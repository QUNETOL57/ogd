import hashlib
import hmac
import json
import os
import secrets
import time
import zipfile
from bisect import bisect_left
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, create_engine, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import DeclarativeBase, Session, mapped_column, sessionmaker

from .importer import archive_digest, exercise_aliases, exercise_names, iter_health_zip

BASE = Path(__file__).parent
TZ = ZoneInfo("Europe/Moscow")
DB_URL = os.environ["DATABASE_URL"]
engine = create_engine(DB_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)
app = FastAPI(title="ogd — openGym dashboard", docs_url=None, redoc_url=None)
AUTH_ATTEMPTS = {}


class BaseModelDB(DeclarativeBase):
    pass


class User(BaseModelDB):
    __tablename__ = "users"
    id = mapped_column(Integer, primary_key=True)
    username = mapped_column(String(40), unique=True, nullable=False)
    password_hash = mapped_column(String(180), nullable=False)
    is_admin = mapped_column(Boolean, default=False, nullable=False)
    share_comparison = mapped_column(Boolean, default=False, nullable=False)
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


class Invite(BaseModelDB):
    __tablename__ = "invites"
    id = mapped_column(Integer, primary_key=True)
    code_hash = mapped_column(String(64), unique=True, nullable=False)
    created_by = mapped_column(Integer, ForeignKey("users.id"))
    used_by = mapped_column(Integer, ForeignKey("users.id"))
    created_at = mapped_column(DateTime(timezone=True), server_default=func.now())


class LoginSession(BaseModelDB):
    __tablename__ = "sessions"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = mapped_column(String(64), unique=True, nullable=False)
    expires_at = mapped_column(DateTime(timezone=True), nullable=False)


class ImportBatch(BaseModelDB):
    __tablename__ = "imports"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    digest = mapped_column(String(64), nullable=False)
    file_name = mapped_column(String(255), nullable=False)
    imported_at = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("user_id", "digest"),)


class Metric(BaseModelDB):
    __tablename__ = "metrics"
    id = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key = mapped_column(String(32), nullable=False)
    sample_ts = mapped_column(BigInteger, nullable=False)
    local_date = mapped_column(Date, nullable=False)
    value = mapped_column(Float, nullable=False)
    payload_hash = mapped_column(String(64), nullable=False)
    __table_args__ = (
        UniqueConstraint("user_id", "key", "sample_ts", "payload_hash", name="uq_metrics_user_key_sample_ts_payload_hash"),
        Index("ix_metrics_user_date_key", "user_id", "local_date", "key"),
    )


class Workout(BaseModelDB):
    __tablename__ = "workouts"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    source_hash = mapped_column(String(64), nullable=False)
    start_ts = mapped_column(BigInteger, nullable=False)
    end_ts = mapped_column(BigInteger, nullable=False)
    kind = mapped_column(String(80), nullable=False)
    name = mapped_column(String(120), nullable=False)
    duration_s = mapped_column(Integer, nullable=False)
    calories = mapped_column(Float)
    distance_m = mapped_column(Float)
    avg_hr = mapped_column(Float)
    min_hr = mapped_column(Float)
    max_hr = mapped_column(Float)
    swolf = mapped_column(Float)
    raw = mapped_column(JSON, nullable=False)
    __table_args__ = (UniqueConstraint("user_id", "source_hash", name="uq_workouts_user_source_hash"), Index("ix_workouts_user_start", "user_id", "start_ts"))


class GymConnection(BaseModelDB):
    __tablename__ = "gym_connections"
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    token_cipher = mapped_column(Text, nullable=False)
    base_url = mapped_column(String(255), nullable=False)


class GymWorkout(BaseModelDB):
    __tablename__ = "gym_workouts"
    id = mapped_column(Integer, primary_key=True)
    user_id = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    external_id = mapped_column(String(120), nullable=False)
    start_ts = mapped_column(BigInteger, nullable=False)
    end_ts = mapped_column(BigInteger, nullable=False)
    name = mapped_column(String(120), nullable=False)
    detail = mapped_column(JSON, nullable=False)
    __table_args__ = (UniqueConstraint("user_id", "external_id", name="uq_gym_workouts_user_external_id"), Index("ix_gym_workouts_user_start", "user_id", "start_ts"))


def get_db():
    with SessionLocal() as db:
        yield db


def _hash_secret(value: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(value.encode(), salt=salt, n=2**14, r=8, p=1)
    return salt.hex() + ":" + digest.hex()


def _verify_secret(value: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        digest = hashlib.scrypt(value.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1)
        return hmac.compare_digest(digest.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def _invite_hash(code: str) -> str:
    return hashlib.sha256(code.strip().upper().encode()).hexdigest()


def _require_origin(request: Request):
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    expected = {item.strip().rstrip("/") for item in os.getenv("APP_ORIGIN", "").split(",") if item.strip()}
    origin = request.headers.get("origin")
    if origin and expected and origin.rstrip("/") not in expected:
        raise HTTPException(403, "Запрос с другого сайта отклонён")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "Запрос с другого сайта отклонён")


def _auth_gate(request: Request):
    address = request.client.host if request.client else "unknown"
    now = time.monotonic()
    attempts = [stamp for stamp in AUTH_ATTEMPTS.get(address, []) if now - stamp < 300]
    if len(attempts) >= 20:
        raise HTTPException(429, "Слишком много попыток. Повторите через несколько минут.")
    attempts.append(now)
    if address not in AUTH_ATTEMPTS and len(AUTH_ATTEMPTS) >= 10000:
        AUTH_ATTEMPTS.clear()
    AUTH_ATTEMPTS[address] = attempts


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get("ogd_session")
    if not token:
        raise HTTPException(401, "Войдите в аккаунт")
    row = db.scalar(select(LoginSession).where(LoginSession.token_hash == hashlib.sha256(token.encode()).hexdigest()))
    if not row or row.expires_at < datetime.now(timezone.utc):
        raise HTTPException(401, "Сессия завершена")
    user = db.get(User, row.user_id)
    if not user:
        raise HTTPException(401, "Сессия завершена")
    return user


def _cookie(response, token):
    response.set_cookie("ogd_session", token, httponly=True, secure=os.getenv("COOKIE_SECURE", "0") == "1", samesite="lax", max_age=30 * 86400, path="/")


class Credentials(BaseModel):
    username: str = Field(min_length=2, max_length=40)
    password: str = Field(min_length=12, max_length=200)
    invite: str = ""


class ShareChoice(BaseModel):
    enabled: bool


class GymInput(BaseModel):
    base_url: str = "https://opengym.qbav.online"
    token: str = Field(min_length=20, max_length=3000, pattern=r"^ogt_[A-Za-z0-9_-]+$")


@app.on_event("startup")
def startup():
    BaseModelDB.metadata.create_all(engine)
    bootstrap = os.getenv("BOOTSTRAP_INVITE", "").strip()
    if bootstrap:
        with SessionLocal() as db:
            if not db.scalar(select(Invite.id).where(Invite.code_hash == _invite_hash(bootstrap))):
                db.add(Invite(code_hash=_invite_hash(bootstrap)))
                db.commit()


@app.middleware("http")
async def same_origin(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and request.url.path == "/api/import" and int(length) > 510 * 1024 * 1024:
        return JSONResponse({"detail": "Максимальный размер архива — 500 МБ"}, status_code=413)
    try:
        _require_origin(request)
    except HTTPException as exc:
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    return response


@app.get("/api/health")
def health():
    with engine.connect() as conn:
        conn.execute(select(1))
    return {"ok": True}


@app.post("/api/register")
def register(body: Credentials, request: Request, db: Session = Depends(get_db)):
    _auth_gate(request)
    username = body.username.strip()
    if not username or any(ord(c) < 32 for c in username):
        raise HTTPException(400, "Укажите корректное имя")
    invite = db.scalar(select(Invite).where(Invite.code_hash == _invite_hash(body.invite), Invite.used_by.is_(None)).with_for_update())
    if not invite:
        raise HTTPException(403, "Приглашение недействительно или уже использовано")
    if db.scalar(select(User.id).where(func.lower(User.username) == username.lower())):
        raise HTTPException(409, "Это имя уже занято")
    admin = db.scalar(select(User.id)) is None
    user = User(username=username, password_hash=_hash_secret(body.password), is_admin=admin)
    db.add(user)
    db.flush()
    db.query(LoginSession).filter(LoginSession.expires_at < datetime.now(timezone.utc)).delete()
    invite.used_by = user.id
    token = secrets.token_urlsafe(32)
    db.add(LoginSession(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=datetime.now(timezone.utc) + timedelta(days=30)))
    db.commit()
    result = JSONResponse({"id": user.id, "username": user.username, "is_admin": user.is_admin})
    _cookie(result, token)
    return result


@app.post("/api/login")
def login(body: Credentials, request: Request, db: Session = Depends(get_db)):
    _auth_gate(request)
    user = db.scalar(select(User).where(func.lower(User.username) == body.username.strip().lower()))
    if not user or not _verify_secret(body.password, user.password_hash):
        raise HTTPException(401, "Неверное имя или пароль")
    token = secrets.token_urlsafe(32)
    db.query(LoginSession).filter(LoginSession.expires_at < datetime.now(timezone.utc)).delete()
    db.add(LoginSession(user_id=user.id, token_hash=hashlib.sha256(token.encode()).hexdigest(), expires_at=datetime.now(timezone.utc) + timedelta(days=30)))
    db.commit()
    result = JSONResponse({"id": user.id, "username": user.username, "is_admin": user.is_admin, "share_comparison": user.share_comparison})
    _cookie(result, token)
    return result


@app.post("/api/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("ogd_session")
    if token:
        db.query(LoginSession).filter_by(token_hash=hashlib.sha256(token.encode()).hexdigest()).delete()
        db.commit()
    result = JSONResponse({"ok": True})
    result.delete_cookie("ogd_session", path="/")
    return result


@app.get("/api/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    latest = db.scalar(select(func.max(Metric.local_date)).where(Metric.user_id == user.id))
    return {"id": user.id, "username": user.username, "is_admin": user.is_admin, "share_comparison": user.share_comparison, "last_date": latest.isoformat() if latest else None}


@app.get("/api/invites")
def list_invites(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "Только администратор может управлять приглашениями")
    return {"invites": [{"created_at": row.created_at.isoformat(), "used": row.used_by is not None} for row in db.scalars(select(Invite).order_by(Invite.id.desc()).limit(30))]}


@app.post("/api/invites")
def create_invite(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.is_admin:
        raise HTTPException(403, "Недостаточно прав")
    code = secrets.token_hex(8).upper()
    db.add(Invite(code_hash=_invite_hash(code), created_by=user.id))
    db.commit()
    return {"code": code}


@app.put("/api/preferences/sharing")
def share(body: ShareChoice, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.share_comparison = body.enabled
    db.commit()
    return {"share_comparison": user.share_comparison}


@app.post("/api/import")
def import_zip(request: Request, file: UploadFile = File(...), password: str = Form(...), user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not file.filename or not file.filename.lower().endswith(".zip"):
        raise HTTPException(400, "Загрузите ZIP-архив с данными")
    if file.size and file.size > 500 * 1024 * 1024:
        raise HTTPException(413, "Максимальный размер архива — 500 МБ")
    digest = archive_digest(file.file)
    if db.scalar(select(ImportBatch.id).where(ImportBatch.user_id == user.id, ImportBatch.digest == digest)):
        return {"ok": True, "duplicate": True, "message": "Этот архив уже импортирован"}
    metric_count = workout_count = 0
    metric_batch = []
    try:
        for kind, item in iter_health_zip(file.file, password):
            if kind == "metric":
                metric_batch.append({
                    "user_id": user.id, "key": item["key"], "sample_ts": item["timestamp"],
                    "local_date": item["date"], "value": item["value"], "payload_hash": item["payload_hash"],
                })
                metric_count += 1
                if len(metric_batch) >= 3000:
                    db.execute(insert(Metric).values(metric_batch).on_conflict_do_nothing(constraint="uq_metrics_user_key_sample_ts_payload_hash"))
                    metric_batch.clear()
            else:
                raw_for_hash = json.dumps(item["raw"], sort_keys=True, separators=(",", ":"))
                source_hash = hashlib.sha256(f'{item["start_ts"]}:{item["kind"]}:{raw_for_hash}'.encode()).hexdigest()
                values = {key: value for key, value in item.items() if key != "raw"}
                values.update(user_id=user.id, source_hash=source_hash, raw=item["raw"])
                db.execute(insert(Workout).values(**values).on_conflict_do_nothing(constraint="uq_workouts_user_source_hash"))
                workout_count += 1
        if metric_batch:
            db.execute(insert(Metric).values(metric_batch).on_conflict_do_nothing(constraint="uq_metrics_user_key_sample_ts_payload_hash"))
        if not metric_count and not workout_count:
            raise ValueError("В архиве не найдены данные здоровья")
        db.add(ImportBatch(user_id=user.id, digest=digest, file_name=Path(file.filename).name[:255]))
        db.commit()
    except (RuntimeError, zipfile.BadZipFile, zipfile.LargeZipFile, OSError) as exc:
        db.rollback()
        raise HTTPException(400, "Не удалось открыть архив: проверьте пароль и формат файла") from exc
    except ValueError as exc:
        db.rollback()
        raise HTTPException(400, str(exc)) from exc
    except Exception:
        db.rollback()
        raise HTTPException(500, "Импорт не завершён; данные не были сохранены")
    return {"ok": True, "metrics": metric_count, "workouts": workout_count, "message": f"Импортировано показателей: {metric_count}, тренировок: {workout_count}"}


def _period_start(period, last_date):
    if not last_date or period == "all":
        return None
    days = {"day": 1, "week": 7, "month": 30, "year": 365}.get(period)
    if not days:
        raise HTTPException(400, "Неизвестный период")
    return last_date - timedelta(days=days - 1)


@app.get("/api/dashboard")
def dashboard(period: str = "year", user: User = Depends(current_user), db: Session = Depends(get_db)):
    last_date = db.scalar(select(func.max(Metric.local_date)).where(Metric.user_id == user.id))
    start = _period_start(period, last_date)
    query = select(Metric.local_date, Metric.key, func.sum(Metric.value), func.avg(Metric.value), func.min(Metric.value), func.max(Metric.value)).where(Metric.user_id == user.id)
    if start:
        query = query.where(Metric.local_date >= start)
    rows = db.execute(query.group_by(Metric.local_date, Metric.key).order_by(Metric.local_date)).all()
    daily = {}
    for day, key, total, avg, low, high in rows:
        row = daily.setdefault(day.isoformat(), {"date": day.isoformat()})
        if key in {"steps", "calories", "intensity"}:
            row[key] = round(float(total))
        elif key == "heart_rate":
            row.update(hr_avg=round(float(avg)), hr_min=round(float(low)), hr_max=round(float(high)))
        elif key == "stress": row["stress_avg"] = round(float(avg))
        elif key == "spo2": row["spo2_avg"] = round(float(avg), 1)
        elif key == "sleep_minutes": row["sleep_min"] = round(float(total))
        elif key in {"sleep_deep", "sleep_light", "sleep_rem"}: row[key] = round(float(total))
        elif key == "rhr": row["rhr"] = round(float(avg))
        elif key == "weight": row["weight"] = round(float(avg), 1)
    last = max(daily) if daily else None
    return {"daily": list(daily.values()), "last_date": last, "timezone": "Europe/Moscow"}


def _gym_match(db, user_id, workout):
    candidate = db.scalar(select(GymWorkout).where(GymWorkout.user_id == user_id, GymWorkout.start_ts.between(workout.start_ts - 30 * 60, workout.start_ts + 30 * 60)).order_by(func.abs(GymWorkout.start_ts - workout.start_ts)).limit(1))
    if not candidate:
        return None
    return {"id": candidate.id, "name": candidate.name, "start_ts": candidate.start_ts, "end_ts": candidate.end_ts, "detail": candidate.detail}


@app.get("/api/workouts")
def workouts(period: str = "all", user: User = Depends(current_user), db: Session = Depends(get_db)):
    latest = max(filter(None, [
        db.scalar(select(func.max(Workout.start_ts)).where(Workout.user_id == user.id)),
        db.scalar(select(func.max(GymWorkout.start_ts)).where(GymWorkout.user_id == user.id)),
    ]), default=None)
    if period != "all" and latest:
        day_count = {"day": 1, "week": 7, "month": 30, "year": 365}.get(period)
        if not day_count:
            raise HTTPException(400, "Неизвестный период")
        start_ts = latest - day_count * 86400
        query = select(Workout).where(Workout.user_id == user.id, Workout.start_ts >= start_ts)
    else:
        query = select(Workout).where(Workout.user_id == user.id)
    rows = db.scalars(query.order_by(Workout.start_ts.desc()).limit(1000)).all()
    mi_starts = sorted(w.start_ts for w in rows)
    gym_query = select(GymWorkout).where(GymWorkout.user_id == user.id)
    if period != "all" and latest:
        gym_query = gym_query.where(GymWorkout.start_ts >= start_ts)
    gym_rows = db.scalars(gym_query.order_by(GymWorkout.start_ts.desc()).limit(1000)).all()
    gym_starts = sorted(gym.start_ts for gym in gym_rows)
    gym_by_start = {gym.start_ts: gym for gym in gym_rows}
    result = []
    for workout in rows:
        pos = bisect_left(gym_starts, workout.start_ts)
        nearby = gym_starts[max(0, pos - 1):pos + 1]
        match_start = min((stamp for stamp in nearby if abs(stamp - workout.start_ts) <= 30 * 60), key=lambda stamp: abs(stamp - workout.start_ts), default=None)
        match = gym_by_start.get(match_start)
        result.append({"id": workout.id, "name": workout.name, "kind": workout.kind, "source": "import", "start_ts": workout.start_ts, "duration_s": workout.duration_s, "calories": workout.calories, "distance_m": workout.distance_m, "avg_hr": workout.avg_hr, "min_hr": workout.min_hr, "max_hr": workout.max_hr, "swolf": workout.swolf, "gym": {"id": match.id, "name": match.name, "start_ts": match.start_ts, "end_ts": match.end_ts, "detail": match.detail} if match else None})
    for gym in gym_rows:
        pos = bisect_left(mi_starts, gym.start_ts)
        nearby = mi_starts[max(0, pos - 1):pos + 1]
        if any(abs(start - gym.start_ts) <= 30 * 60 for start in nearby):
            continue
        result.append({"id": f"gym:{gym.id}", "name": gym.name, "kind": "opengym", "source": "opengym", "start_ts": gym.start_ts, "duration_s": max(0, gym.end_ts - gym.start_ts), "calories": None, "distance_m": None, "avg_hr": None, "min_hr": None, "max_hr": None, "swolf": None, "gym": {"id": gym.id, "name": gym.name, "start_ts": gym.start_ts, "end_ts": gym.end_ts, "detail": gym.detail}})
    result.sort(key=lambda w: w["start_ts"], reverse=True)
    return {"workouts": result[:1000]}


@app.get("/api/workouts/{workout_id}")
def workout_detail(workout_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(Workout).where(Workout.user_id == user.id, Workout.id == workout_id))
    if not row:
        raise HTTPException(404, "Тренировка не найдена")
    return {"id": row.id, "name": row.name, "kind": row.kind, "start_ts": row.start_ts, "end_ts": row.end_ts, "duration_s": row.duration_s, "calories": row.calories, "distance_m": row.distance_m, "avg_hr": row.avg_hr, "min_hr": row.min_hr, "max_hr": row.max_hr, "swolf": row.swolf, "raw": row.raw, "gym": _gym_match(db, user.id, row)}


@app.get("/api/workouts/gym/{gym_id}")
def gym_workout_detail(gym_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    row = db.scalar(select(GymWorkout).where(GymWorkout.user_id == user.id, GymWorkout.id == gym_id))
    if not row:
        raise HTTPException(404, "Тренировка Open Gym не найдена")
    return {"id": f"gym:{row.id}", "name": row.name, "kind": "opengym", "start_ts": row.start_ts, "end_ts": row.end_ts, "duration_s": max(0, row.end_ts - row.start_ts), "gym": {"id": row.id, "name": row.name, "detail": row.detail}}


def _fernet():
    key = os.getenv("FERNET_KEY", "")
    if not key:
        raise HTTPException(503, "Интеграция Open Gym не настроена на сервере")
    try:
        return Fernet(key.encode())
    except (ValueError, TypeError) as exc:
        raise HTTPException(503, "Некорректный FERNET_KEY на сервере") from exc


@app.post("/api/opengym/connect")
def connect_gym(body: GymInput, user: User = Depends(current_user), db: Session = Depends(get_db)):
    base = body.base_url.rstrip("/")
    parsed = urlparse(base)
    allowed_hosts = {host.strip().lower() for host in os.getenv("OPENGYM_ALLOWED_HOSTS", "opengym.qbav.online").split(",") if host.strip()}
    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts or parsed.port not in (None, 443) or parsed.path:
        raise HTTPException(400, "Open Gym должен использовать HTTPS")
    try:
        response = httpx.get(base + "/api/token/me", headers={"Authorization": f"Bearer {body.token}"}, timeout=15)
        response.raise_for_status()
        profile = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(400, "Не удалось проверить токен Open Gym") from exc
    if profile.get("token", {}).get("scopes", {}).get("workouts") not in {"view", "apply"}:
        raise HTTPException(403, "Для токена Open Gym нужно разрешение чтения тренировок")
    cipher = _fernet().encrypt(body.token.encode()).decode()
    existing = db.get(GymConnection, user.id)
    if existing:
        existing.token_cipher, existing.base_url = cipher, base
    else:
        db.add(GymConnection(user_id=user.id, token_cipher=cipher, base_url=base))
    db.commit()
    return {"ok": True, "profile": profile.get("user", {}).get("name", "Open Gym")}


@app.post("/api/opengym/sync")
def sync_gym(user: User = Depends(current_user), db: Session = Depends(get_db)):
    connection = db.get(GymConnection, user.id)
    if not connection:
        raise HTTPException(400, "Сначала подключите Open Gym")
    try:
        token = _fernet().decrypt(connection.token_cipher.encode()).decode()
        response = httpx.get(connection.base_url + "/api/token/data", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        response.raise_for_status()
        state = response.json().get("state") or {}
    except (httpx.HTTPError, InvalidToken, ValueError) as exc:
        raise HTTPException(502, "Не удалось получить данные Open Gym") from exc
    names = exercise_names(state)
    aliases = exercise_aliases(state)
    routines = {item.get("id"): item.get("name") for item in state.get("routines", []) if isinstance(item, dict)}
    imported = 0
    for item in state.get("workouts", []):
        if not isinstance(item, dict) or not item.get("start"):
            continue
        try:
            start_ts = int(float(item["start"]) / 1000)
            end_ts = int(float(item.get("end") or item["start"]) / 1000)
        except (ValueError, TypeError, OverflowError):
            continue
        detail = dict(item)
        for entry in detail.get("entries", []):
            if isinstance(entry, dict):
                raw_id = str(entry.get("id") or "")
                entry["exercise_name"] = entry.get("name") or names.get(raw_id) or names.get(aliases.get(raw_id, raw_id)) or raw_id or "Упражнение"
        external_id = str(item.get("id") or f'{start_ts}:{item.get("name", "")}')[:120]
        name = str(item.get("name") or routines.get(item.get("routineId")) or "Тренировка Open Gym")[:120]
        values = {"user_id": user.id, "external_id": external_id, "start_ts": start_ts, "end_ts": end_ts, "name": name, "detail": detail}
        stmt = insert(GymWorkout).values(**values).on_conflict_do_update(constraint="uq_gym_workouts_user_external_id", set_={k: v for k, v in values.items() if k != "user_id" and k != "external_id"})
        db.execute(stmt)
        imported += 1
    db.commit()
    return {"ok": True, "workouts": imported}


@app.delete("/api/opengym/connect")
def disconnect_gym(user: User = Depends(current_user), db: Session = Depends(get_db)):
    db.query(GymConnection).filter_by(user_id=user.id).delete()
    db.query(GymWorkout).filter_by(user_id=user.id).delete()
    db.commit()
    return {"ok": True}


def _comparison_training(db: Session, user_id: int, start_ts: int, end_ts: int):
    mi_starts = sorted(db.scalars(select(Workout.start_ts).where(Workout.user_id == user_id, Workout.start_ts >= start_ts, Workout.start_ts < end_ts)).all())
    gym_rows = db.scalars(select(GymWorkout).where(GymWorkout.user_id == user_id, GymWorkout.start_ts >= start_ts, GymWorkout.start_ts < end_ts)).all()
    count = len(mi_starts)
    days = {datetime.fromtimestamp(stamp, TZ).date().isoformat() for stamp in mi_starts}
    for gym in gym_rows:
        days.add(datetime.fromtimestamp(gym.start_ts, TZ).date().isoformat())
        pos = bisect_left(mi_starts, gym.start_ts)
        nearby = mi_starts[max(0, pos - 1):pos + 1]
        if not any(abs(stamp - gym.start_ts) <= 30 * 60 for stamp in nearby):
            count += 1
    return count, days


@app.get("/api/compare")
def compare(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not user.share_comparison:
        return {"people": [], "needs_consent": True}
    shared = db.scalars(select(User).where(User.share_comparison.is_(True)).order_by(User.username)).all()
    anchor = db.scalar(select(func.max(Metric.local_date)).where(Metric.user_id == user.id)) or date.today()
    start = anchor - timedelta(days=29)
    start_ts = int(datetime.combine(start, datetime.min.time(), TZ).timestamp())
    end_ts = int(datetime.combine(anchor + timedelta(days=1), datetime.min.time(), TZ).timestamp())
    _, own_days = _comparison_training(db, user.id, start_ts, end_ts)
    result = []
    for person in shared:
        metrics = db.execute(select(Metric.key, func.sum(Metric.value), func.avg(Metric.value)).where(Metric.user_id == person.id, Metric.local_date >= start, Metric.local_date <= anchor).group_by(Metric.key)).all()
        stats = {key: round(float(total if key in {"steps", "calories"} else avg)) for key, total, avg in metrics if key in {"steps", "calories", "heart_rate", "sleep_minutes"}}
        workout_count, workout_days = _comparison_training(db, person.id, start_ts, end_ts)
        result.append({"username": person.username, "is_me": person.id == user.id, "last_30_days": stats, "workouts": workout_count, "common_workout_days": len(workout_days & own_days)})
    return {"people": result, "needs_consent": False, "period_start": start.isoformat(), "period_end": anchor.isoformat()}


@app.get("/{path:path}")
def static(path: str):
    if path.startswith("api/"):
        raise HTTPException(404, "Not found")
    candidate = (BASE / "static" / path).resolve()
    static_root = (BASE / "static").resolve()
    if candidate.parent == static_root and candidate.is_file():
        return FileResponse(candidate)
    return FileResponse(static_root / "index.html")

import csv
import hashlib
import io
import json
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
from typing import BinaryIO
from zoneinfo import ZoneInfo

MOSCOW = ZoneInfo("Europe/Moscow")
EXERCISE_NAMES = json.loads((Path(__file__).with_name("exercise_names.json")).read_text(encoding="utf-8"))
EXERCISE_NAMES_RU = json.loads((Path(__file__).with_name("exercise_names_ru.json")).read_text(encoding="utf-8"))
METRIC_FIELDS = {
    "steps": ("steps",), "calories": ("calories",), "heart_rate": ("bpm",),
    "stress": ("stress",), "spo2": ("spo2",), "weight": ("weight",),
    "intensity": ("intensity", "duration"), "resting_heart_rate": ("bpm",),
}


def archive_digest(file: BinaryIO) -> str:
    file.seek(0)
    digest = hashlib.sha256()
    while chunk := file.read(1024 * 1024):
        digest.update(chunk)
    file.seek(0)
    return digest.hexdigest()


def _local_date(timestamp: int) -> date:
    return datetime.fromtimestamp(timestamp, MOSCOW).date()


def _text_map(value):
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items() if isinstance(item, (str, int)) and str(item).strip()}


def exercise_overrides(state):
    """Names the user set in OpenGym take priority over the built-in catalog."""
    names = {}
    for item in state.get("customEx") or []:
        if isinstance(item, dict) and item.get("id"):
            name = item.get("n") or item.get("name")
            if name:
                names[str(item["id"])] = str(name)
    names.update(_text_map(state.get("exShownName")))
    for routine in state.get("routines") or []:
        if not isinstance(routine, dict):
            continue
        for item in routine.get("ex") or []:
            if isinstance(item, dict) and item.get("id"):
                name = item.get("n") or item.get("name")
                if name:
                    names[str(item["id"])] = str(name)
    return names


def exercise_label(raw_id, canonical_id, overrides):
    """Return (display label, english name when it belongs in brackets)."""
    override = overrides.get(raw_id) or overrides.get(canonical_id)
    if override:
        return override, None
    ru = EXERCISE_NAMES_RU.get(raw_id) or EXERCISE_NAMES_RU.get(canonical_id)
    en = EXERCISE_NAMES.get(raw_id) or EXERCISE_NAMES.get(canonical_id)
    if ru and en and ru.casefold() != en.casefold():
        return ru, en
    return ru or en or raw_id or "Упражнение", None


def exercise_aliases(state):
    return _text_map(state.get("exAliases"))


def iter_health_zip(file: BinaryIO, password: str):
    """Stream normalized rows without extracting archive paths or buffering the export."""
    pwd = password.encode("utf-8")
    with zipfile.ZipFile(file) as archive:
        entries = [item for item in archive.infolist() if not item.is_dir()]
        if len(entries) > 200 or sum(item.file_size for item in entries) > 350 * 1024 * 1024:
            raise ValueError("Архив превышает допустимый размер")
        for item in entries:
            name = item.filename.rsplit("/", 1)[-1].lower()
            if not name.endswith(".csv"):
                continue
            if "hlth_center_fitness_data" in name:
                with archive.open(item, pwd=pwd) as raw:
                    rows = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                    for row in rows:
                        key = row.get("Key", "").lower()
                        if key not in METRIC_FIELDS and key != "sleep":
                            continue
                        try:
                            payload = json.loads(row.get("Value") or "{}")
                            timestamp = int(payload.get("time") or row.get("Time") or 0)
                        except (ValueError, TypeError, json.JSONDecodeError):
                            continue
                        if timestamp <= 0:
                            continue
                        values = {}
                        if key == "sleep":
                            bedtime = int(payload.get("bedtime") or payload.get("device_bedtime") or timestamp)
                            wake = int(payload.get("wake_up_time") or payload.get("out_bed_timestamp") or timestamp)
                            sleep_min = payload.get("bed_duration")
                            if sleep_min is not None:
                                sleep_min = float(sleep_min) / 60
                            else:
                                phases = sum(float(payload.get(k) or 0) for k in ("sleep_deep_duration", "sleep_light_duration", "sleep_rem_duration"))
                                sleep_min = phases if phases else max(0, (wake - bedtime) / 60)
                            values = {
                                "sleep_minutes": sleep_min,
                                "sleep_deep": float(payload.get("sleep_deep_duration") or 0),
                                "sleep_light": float(payload.get("sleep_light_duration") or 0),
                                "sleep_rem": float(payload.get("sleep_rem_duration") or 0),
                            }
                            timestamp = wake
                        else:
                            for field in METRIC_FIELDS[key]:
                                if field in payload and isinstance(payload[field], (int, float)):
                                    metric_key = "rhr" if key == "resting_heart_rate" else "intensity" if key == "intensity" else key
                                    values[metric_key] = float(payload[field])
                        for metric_key, value in values.items():
                            if value >= 0:
                                yield "metric", {
                                    "key": metric_key, "timestamp": timestamp,
                                    "date": _local_date(timestamp), "value": value,
                                    "payload_hash": hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest(),
                                }
            elif "hlth_center_sport_record" in name:
                with archive.open(item, pwd=pwd) as raw:
                    rows = csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8-sig", newline=""))
                    for row in rows:
                        try:
                            payload = json.loads(row.get("Value") or "{}")
                            start = int(payload.get("start_time") or row.get("Time") or 0)
                        except (ValueError, TypeError, json.JSONDecodeError):
                            continue
                        if start <= 0:
                            continue
                        end = int(payload.get("end_time") or start + int(payload.get("duration") or 0))
                        yield "workout", {
                            "start_ts": start, "end_ts": end,
                            "kind": (row.get("Category") or row.get("Key") or "sport")[:80],
                            "name": (row.get("Key") or row.get("Category") or "Тренировка")[:120],
                            "duration_s": max(0, end - start),
                            "calories": _number(payload, "calories"),
                            "distance_m": _number(payload, "distance"),
                            "avg_hr": _number(payload, "avg_hrm"),
                            "min_hr": _number(payload, "min_hrm"),
                            "max_hr": _number(payload, "max_hrm"),
                            "swolf": _number(payload, "swolf"),
                            "raw": payload,
                        }


def _number(payload, key):
    value = payload.get(key)
    return float(value) if isinstance(value, (int, float)) else None

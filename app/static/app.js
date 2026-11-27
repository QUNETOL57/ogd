const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const state={user:null,period:'all',daily:[],heatDaily:[],workouts:[],allWorkouts:null,heatWorkouts:[],view:'dashboard',authMode:'login',invite:null,hm:'steps',woCat:'all',imports:[],importsHidden:false,importsPoll:null,importWatched:new Set()};
const colors={blue:'#f74f9e',green:'#00ceb3',amber:'#fe9a00',purple:'#b48cff',red:'#fb414a',cyan:'#00ceb3',muted:'#9a9a9a',border:'#191919'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=n=>Number(n||0).toLocaleString('ru-RU');
const isoDate=ts=>{const parts=new Intl.DateTimeFormat('en',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ts*1000));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`};
const dateFmt=ts=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'short',year:'numeric'}).format(new Date(ts*1000));
const timeFmt=ts=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',hour:'2-digit',minute:'2-digit'}).format(new Date(ts*1000));
const duration=s=>`${Math.floor((s||0)/3600)} ч ${String(Math.floor(((s||0)%3600)/60)).padStart(2,'0')} мин`;
async function api(url,options={}){const r=await fetch(url,{credentials:'same-origin',...options});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.detail||data.error||`Ошибка ${r.status}`);return data}
function toast(text){const el=$('#toast');el.textContent=text;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2800)}
function notice(text,error=false){const el=$('#notice');el.textContent=text;el.hidden=!text;el.classList.toggle('error',error);if(text)setTimeout(()=>el.hidden=true,6000)}
function inviteFromUrl(){const match=location.pathname.match(/^\/join\/([A-Za-z0-9]+)\/?$/);return match?match[1].toUpperCase():(new URLSearchParams(location.search).get('invite')||'').toUpperCase()||null}
async function validateInvite(code){try{const result=await api(`/api/invites/${encodeURIComponent(code)}`);if(!result.valid){$('#authForm').hidden=true;$('#authError').textContent='Ссылка-приглашение недействительна, уже использована или истекла';return false}return true}catch(error){$('#authForm').hidden=true;$('#authError').textContent=error.message;return false}}
function openAuth(mode='login'){state.authMode=mode;const register=mode==='register';$('#auth').hidden=false;$('#app').hidden=true;$('#confirmField').hidden=!register;$('#authForm [name=confirm]').disabled=!register;$('#authForm [name=confirm]').required=register;$('#authSubmit').textContent=register?'Создать аккаунт':'Войти';$('#authForm [name=password]').setAttribute('autocomplete',register?'new-password':'current-password');$('#authSwitch').hidden=!register;$('#authForm').hidden=false;$('#authError').textContent=''}
async function boot(){const invite=inviteFromUrl();if(invite){state.invite=invite;openAuth('register');await validateInvite(invite);return}state.invite=null;try{state.user=await api('/api/me');$('#auth').hidden=true;$('#app').hidden=false;$('#userName').textContent=state.user.username;$('#avatar').textContent=state.user.username.slice(0,1).toUpperCase();$('#adminPanel').hidden=!state.user.is_admin;$('#shareToggle').checked=state.user.share_comparison;await loadDashboard();await loadWorkouts();await loadGymStatus();await loadImports();}catch{openAuth('login')}}
async function loginForm(e){e.preventDefault();const form=new FormData(e.currentTarget),payload={username:form.get('username'),password:form.get('password')};if(state.authMode==='register'){const confirm=form.get('confirm');if(payload.password!==confirm){$('#authError').textContent='Пароли не совпадают';return}payload.confirm=confirm;payload.invite=state.invite}try{await api(state.authMode==='register'?'/api/register':'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});if(state.authMode==='register'){location.replace('/');return}await boot()}catch(err){$('#authError').textContent=err.message}}
async function loadDashboard(){
  const[data,heat]=await Promise.all([api(`/api/dashboard?period=${state.period}`),state.period==='year'?Promise.resolve(null):api('/api/dashboard?period=year')]);
  state.daily=data.daily||[];
  state.heatDaily=(heat||data).daily||[];
  const first=state.daily[0]?.date,last=state.daily.at(-1)?.date;
  $('#rangeCaption').textContent=first&&last?`${first} — ${last} · данные по Москве`:'Загрузите архив данных, чтобы увидеть аналитику';
  if(state.view==='dashboard')renderAnalytics();
}

function palette(){
  return {c1:colors.blue,c2:colors.green,c3:colors.amber,c4:colors.purple,c5:colors.red,c6:'#9be700',border:colors.border,muted:colors.muted,fg:'#d4d4d4'};
}

function renderKpis(rows,wos){
  const stepRows=rows.filter(r=>r.steps>0);
  const avgSteps=stepRows.length?Math.round(stepRows.reduce((s,r)=>s+r.steps,0)/stepRows.length):0;
  const goalPct=stepRows.length?Math.round(100*stepRows.filter(r=>r.steps>=10000).length/stepRows.length):0;
  const sleepRows=rows.filter(r=>r.sleep_min>0&&r.sleep_min<=960);
  const avgSleep=sleepRows.length?sleepRows.reduce((s,r)=>s+r.sleep_min,0)/sleepRows.length:0;
  const rhrRows=rows.filter(r=>r.rhr>0);
  const avgRhr=rhrRows.length?Math.round(rhrRows.reduce((s,r)=>s+r.rhr,0)/rhrRows.length):null;
  const woHours=wos.reduce((s,w)=>s+(w.duration_s||0),0)/3600;
  const swimKm=wos.filter(w=>sportCat(w)==='swimming').reduce((s,w)=>s+(w.distance_m||0),0)/1000;
  let weightRows=rows.filter(r=>r.weight!=null);
  if(!weightRows.length)weightRows=state.heatDaily.filter(r=>r.weight!=null);
  const latest=weightRows.at(-1),first=weightRows[0];
  const delta=latest&&first&&weightRows.length>1?latest.weight-first.weight:null;
  const items=[
    {label:'Шагов в день (ср.)',val:avgSteps?fmt(avgSteps):'—',note:`Цель выполнена: ${goalPct}% дн.`},
    {label:'Сон (ср.)',val:avgSleep?fmtMin(avgSleep):'—',note:`${sleepRows.length} ночей`},
    {label:'Пульс покоя (RHR)',val:avgRhr?`${avgRhr} уд/мин`:'—',note:`${rhrRows.length} дней замеров`},
    {label:'Тренировки',val:fmt(wos.length),note:`${woHours.toFixed(1)} ч · плавание ${swimKm.toFixed(1)} км`},
    {label:'Последний вес',val:latest?`${latest.weight.toFixed(1)} кг`:'—',note:latest?`${latest.date}${delta!=null?` (${delta>0?'+':''}${delta.toFixed(1)} кг)`:''}`:'нет измерений'},
  ];
  $('#kpis').innerHTML=items.map(k=>`<div class="kpi"><span class="kpi-label">${k.label}</span><b class="kpi-val">${k.val}</b><span class="kpi-note">${k.note}</span></div>`).join('');
}

function setupCanvas(id,customW){
  const canvas=$(`#${id}`);
  if(!canvas)return null;
  const dpr=Math.min(devicePixelRatio||1,2);
  const w=customW||canvas.parentElement.clientWidth||640;
  const h=canvas.clientHeight||190;
  canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);
  if(customW)canvas.style.width=w+'px';
  const ctx=canvas.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return{canvas,ctx,w,h};
}

function drawGrid(ctx,pad,w,h,maxY,minY,pal,fmtY){
  const plotH=h-pad.t-pad.b;
  ctx.strokeStyle=pal.border;ctx.fillStyle=pal.muted;ctx.font='10.5px ui-monospace,monospace';ctx.textAlign='right';ctx.textBaseline='middle';
  for(let i=0;i<=4;i++){
    const val=minY+(maxY-minY)*i/4,y=pad.t+plotH*(1-i/4);
    ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(w-pad.r,y);ctx.lineWidth=1;ctx.stroke();
    ctx.fillText(fmtY(val),pad.l-6,y);
  }
}

function drawXLabels(ctx,pad,w,h,labels,pal){
  if(!labels.length)return;
  const plotW=w-pad.l-pad.r;
  ctx.fillStyle=pal.muted;ctx.font='10.5px ui-monospace,monospace';ctx.textAlign='center';ctx.textBaseline='top';
  const count=Math.max(1,Math.min(labels.length,Math.min(6,Math.floor(plotW/72))));
  for(let i=0;i<count;i++){
    const idx=count===1?0:Math.round(i*(labels.length-1)/(count-1));
    const x=pad.l+(labels.length===1?plotW/2:(idx/(labels.length-1))*plotW);
    ctx.fillText(labels[idx],x,h-pad.b+6);
  }
}

function drawEmpty(ctx,w,h,pal,msg='Нет данных за период'){
  ctx.fillStyle=pal.muted;ctx.font='12px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(msg,w/2,h/2);
}

function fmtDate(iso){if(!iso)return'—';const[y,m,d]=iso.split('-');return`${d}.${m}.${y.slice(2)}`}
function fmtMin(m){if(m==null)return'—';const h=Math.floor(m/60),mm=Math.round(m%60);return`${h}ч ${String(mm).padStart(2,'0')}м`}
function fmtClock(v){if(v==null)return'—';const h=Math.floor(v)%24,m=Math.round((v-Math.floor(v))*60)%60;return`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`}
function movingAvg(arr,win){
  return arr.map((_,i)=>{let sum=0,cnt=0;for(let j=Math.max(0,i-win+1);j<=i;j++){if(arr[j]!=null){sum+=arr[j];cnt++;}}return cnt?sum/cnt:null});
}

const tipEl=$('#tip');
function showTip(x,y,text){
  tipEl.textContent=text;tipEl.style.display='block';
  const r=tipEl.getBoundingClientRect();
  let left=x+12,top=y-r.height-10;
  if(left+r.width>window.innerWidth-8)left=x-r.width-12;
  if(top<8)top=y+14;
  tipEl.style.left=Math.max(8,left)+'px';tipEl.style.top=Math.max(8,top)+'px';
}
function hideTip(){tipEl.style.display='none'}

function attachHover(canvas,pad,n,onPoint){
  canvas.onmousemove=(e)=>{
    if(!n)return;
    const rect=canvas.getBoundingClientRect(),rx=e.clientX-rect.left;
    const plotW=rect.width-pad.l-pad.r;
    if(rx<pad.l||rx>rect.width-pad.r){hideTip();return;}
    const idx=n===1?0:Math.max(0,Math.min(n-1,Math.round(((rx-pad.l)/plotW)*(n-1))));
    const txt=onPoint(idx);
    if(txt)showTip(e.clientX,e.clientY,txt);else hideTip();
  };
  canvas.onmouseleave=hideTip;
}

function workoutsForPeriod(){
  const source=state.allWorkouts??state.workouts;
  if(state.period==='all'||!state.daily.length)return source;
  const first=state.daily[0].date,last=state.daily.at(-1).date;
  return source.filter(w=>{const date=isoDate(w.start_ts);return date>=first&&date<=last});
}

const SPORT_LABELS={swimming:'Плавание',tennis:'Теннис',snowboarding:'Сноуборд',running:'Бег',walking:'Ходьба',rope:'Скакалка',strength:'Силовая',cycling:'Велотренажёр',other:'Прочее'};
function sportCat(w){
  const s=`${w.kind||''} ${w.name||''}`.toLowerCase();
  if(/swim|плав/.test(s))return'swimming';
  if(/tennis|теннис/.test(s))return'tennis';
  if(/snow|сноуборд/.test(s))return'snowboarding';
  if(/run|бег/.test(s))return'running';
  if(/walk|ходьб/.test(s))return'walking';
  if(/rope|скакал/.test(s))return'rope';
  if(/strength|силов|core|офп|physical|gym|зал/.test(s))return'strength';
  if(/ride|cycl|вело/.test(s))return'cycling';
  return'other';
}
function sportLabel(w){return SPORT_LABELS[sportCat(w)]||'Прочее'}
function workoutTitle(w){return (w.source==='opengym'||w.kind==='opengym')?w.name:sportLabel(w)}
function sportColor(cat,pal){return{swimming:pal.c1,tennis:pal.c2,snowboarding:pal.c6,running:pal.c3,walking:pal.c4,rope:pal.c4,strength:pal.c5,cycling:pal.c4,other:pal.c5}[cat]||pal.c5}
function monthKey(ts){return isoDate(ts).slice(0,7)}
function catGroup(w){const c=sportCat(w);return['swimming','tennis','snowboarding'].includes(c)?c:'other'}

function renderSteps(rows){
  const d=setupCanvas('activityChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:46,r:10,t:10,b:24};
  const data=rows.filter(r=>r.steps!=null);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return;}
  const vals=data.map(r=>r.steps),avg=movingAvg(vals,14);
  const maxY=Math.max(10000,Math.ceil(Math.max(...vals,1000)/2000)*2000);
  drawGrid(ctx,pad,w,h,maxY,0,pal,v=>v>=1000?`${Math.round(v/1000)}k`:`${Math.round(v)}`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,barW=Math.min(28,Math.max(1.5,plotW/Math.max(1,data.length)*0.72));
  data.forEach((r,i)=>{
    const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW)-barW/2,bh=(r.steps/maxY)*plotH;
    ctx.fillStyle=r.steps>=10000?pal.c1:'#2a2a2a';ctx.globalAlpha=r.steps>=10000?0.65:0.9;ctx.fillRect(x,pad.t+plotH-bh,barW,bh);
  });
  ctx.globalAlpha=1;
  const gy=pad.t+plotH*(1-10000/maxY);
  ctx.save();ctx.setLineDash([4,4]);ctx.strokeStyle=pal.c2;ctx.lineWidth=1.3;ctx.beginPath();ctx.moveTo(pad.l,gy);ctx.lineTo(w-pad.r,gy);ctx.stroke();ctx.restore();
  ctx.strokeStyle=pal.c3;ctx.lineWidth=2;ctx.beginPath();
  avg.forEach((v,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW),y=pad.t+plotH*(1-v/maxY);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});
  ctx.stroke();
  attachHover(canvas,pad,data.length,i=>{const r=data[i];return`${fmtDate(r.date)}\nШаги: ${fmt(r.steps)} (цель 10 000)\nСр. 14 дн.: ${fmt(Math.round(avg[i]||0))}\nКалории: ${r.calories!=null?fmt(r.calories)+' ккал':'—'}`});
}

function renderHeatmap(){
  const daily=state.heatDaily.length?state.heatDaily:state.daily;
  const wos=state.heatWorkouts.length?state.heatWorkouts:(state.allWorkouts??state.workouts);
  const lastIso=daily.at(-1)?.date||isoDate(Math.floor(Date.now()/1000));
  const end=new Date(lastIso+'T12:00:00Z');
  const start=new Date(end.getTime()-364*86400000);
  start.setUTCDate(start.getUTCDate()-((start.getUTCDay()+6)%7));
  const cells=[];
  for(let dt=new Date(start);dt<=end;dt.setUTCDate(dt.getUTCDate()+1)){
    const iso=dt.toISOString().slice(0,10);
    cells.push({iso,col:Math.floor((dt-start)/(7*86400000)),row:(dt.getUTCDay()+6)%7,d:new Date(dt)});
  }
  const cols=(cells.length?cells[cells.length-1].col:52)+1;
  const gap=2,left=22,top=16;
  const avail=Math.max(240,($('#heatmapChart').parentElement.clientWidth||320)-4);
  const size=Math.max(3,Math.min(9.5,(avail-left)/Math.max(1,cols)-gap));
  const d=setupCanvas('heatmapChart');if(!d)return;
  const{ctx}=d,pal=palette();
  const labelSize=Math.max(7.5,Math.min(9.5,size));
  const byDay=new Map(daily.map(r=>[r.date,r])),woByDay=new Map();
  wos.forEach(w=>{const day=isoDate(w.start_ts);if(!woByDay.has(day))woByDay.set(day,[]);woByDay.get(day).push(w)});
  ctx.fillStyle=pal.muted;ctx.font=labelSize+'px sans-serif';
  ['Пн','','Ср','','Пт','','Вс'].forEach((lbl,r)=>{if(lbl)ctx.fillText(lbl,0,top+r*(size+gap)+8)});
  const MONTHS=['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
  let lastMonth=-1;
  cells.forEach(c=>{
    if(c.row===0&&c.d.getUTCMonth()!==lastMonth){lastMonth=c.d.getUTCMonth();ctx.fillStyle=pal.muted;ctx.fillText(MONTHS[lastMonth],left+c.col*(size+gap),10)}
    const x=left+c.col*(size+gap),y=top+c.row*(size+gap);
    let alpha=0.08,color=pal.muted;
    if(state.hm==='steps'){
      const s=byDay.get(c.iso)?.steps||0;
      if(s>0){color=pal.c2;alpha=s>=10000?1:s>=7500?0.72:s>=5000?0.45:0.22}
    }else{
      const ws=woByDay.get(c.iso)||[];
      if(ws.length){const mins=ws.reduce((a,b)=>a+(b.duration_s||0)/60,0);color=pal.c1;alpha=mins>=60?1:mins>=35?0.7:0.42}
    }
    ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.beginPath();
    if(ctx.roundRect)ctx.roundRect(x,y,size,size,2);else ctx.rect(x,y,size,size);
    ctx.fill();
  });
  ctx.globalAlpha=1;
  const canvas=d.canvas;
  canvas.onmousemove=(e)=>{
    const rect=canvas.getBoundingClientRect(),rx=e.clientX-rect.left,ry=e.clientY-rect.top;
    const col=Math.floor((rx-left)/(size+gap)),row=Math.floor((ry-top)/(size+gap));
    const cell=cells.find(c=>c.col===col&&c.row===row);
    if(!cell){hideTip();return}
    const dr=byDay.get(cell.iso),ws=woByDay.get(cell.iso)||[];
    const lines=[fmtDate(cell.iso)];
    if(dr?.steps!=null)lines.push(`Шаги: ${fmt(dr.steps)}`);
    if(ws.length)lines.push('Тренировки: '+ws.map(w=>`${workoutTitle(w)} (${Math.round((w.duration_s||0)/60)} мин)`).join(', '));
    if(lines.length===1)lines.push('Нет данных');
    showTip(e.clientX,e.clientY,lines.join('\n'));
  };
  canvas.onmouseleave=hideTip;
}

function renderWeekday(rows,wos){
  const d=setupCanvas('weekdayChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:34,r:26,t:10,b:22};
  const names=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
  const sSum=Array(7).fill(0),sCnt=Array(7).fill(0),wCnt=Array(7).fill(0);
  rows.forEach(r=>{if(r.steps>0){const idx=(new Date(r.date+'T12:00:00Z').getUTCDay()+6)%7;sSum[idx]+=r.steps;sCnt[idx]++}});
  wos.forEach(x=>{const idx=(new Date(isoDate(x.start_ts)+'T12:00:00Z').getUTCDay()+6)%7;wCnt[idx]++});
  const avgs=sSum.map((s,i)=>sCnt[i]?Math.round(s/sCnt[i]):0);
  const maxS=Math.max(8000,Math.ceil(Math.max(...avgs,1000)/2000)*2000),maxW=Math.max(4,Math.max(...wCnt));
  drawGrid(ctx,pad,w,h,maxS,0,pal,v=>`${Math.round(v/1000)}k`);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,step=plotW/7,bw=Math.min(22,step*0.42);
  names.forEach((n,i)=>{
    const cx=pad.l+i*step+step/2,h1=(avgs[i]/maxS)*plotH,h2=(wCnt[i]/maxW)*plotH;
    ctx.fillStyle=pal.c1;ctx.globalAlpha=0.72;ctx.fillRect(cx-bw-1,pad.t+plotH-h1,bw,h1);
    ctx.fillStyle=pal.c2;ctx.globalAlpha=0.85;ctx.fillRect(cx+1,pad.t+plotH-h2,bw*0.75,h2);
    ctx.globalAlpha=1;ctx.fillStyle=pal.muted;ctx.font='10.5px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText(n,cx,h-pad.b+5);
  });
  canvas.onmousemove=(e)=>{
    const rect=canvas.getBoundingClientRect(),idx=Math.floor((e.clientX-rect.left-pad.l)/step);
    if(idx<0||idx>6){hideTip();return}
    showTip(e.clientX,e.clientY,`${names[idx]}\nСр. шаги: ${fmt(avgs[idx])}\nТренировок: ${wCnt[idx]}`);
  };
  canvas.onmouseleave=hideTip;
}

function renderSports(wos){
  const el=$('#sportBreakdown');if(!el)return;
  const groups=new Map();
  wos.forEach(w=>{
    const cat=sportCat(w),g=groups.get(cat)||{count:0,min:0,cal:0};
    g.count++;g.min+=(w.duration_s||0)/60;g.cal+=w.calories||0;groups.set(cat,g);
  });
  const rows=[...groups.entries()].sort((a,b)=>b[1].count-a[1].count);
  const totalMin=wos.reduce((s,w)=>s+(w.duration_s||0),0)/60;
  $('#sportSub').textContent=wos.length?`${wos.length} трен. · ${Math.round(totalMin/60)} ч`:'';
  if(!rows.length){el.innerHTML='<div class="empty">Нет тренировок за период</div>';return}
  const max=rows[0][1].count,pal=palette();
  el.innerHTML=rows.map(([cat,g])=>`<div class="sport-row"><span class="sport-name">${esc(SPORT_LABELS[cat]||'Прочее')}</span><div class="sport-track"><i style="width:${Math.max(2,g.count/max*100)}%;background:${sportColor(cat,pal)}"></i></div><span class="sport-value">${g.count} · ${(g.min/60).toFixed(1)} ч</span></div>`).join('');
}

function renderMonthlyWorkouts(){
  const d=setupCanvas('monthlyWorkoutsChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:32,r:8,t:10,b:24},legend=$('#monthlyWorkoutLegend');
  const wos=workoutsForPeriod();
  if(!wos.length){legend.innerHTML='';drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  const latest=wos.reduce((a,x)=>Math.max(a,x.start_ts),0),anchor=monthKey(latest),[ay,am]=anchor.split('-').map(Number);
  const months=Array.from({length:12},(_,i)=>{const n=ay*12+(am-1)-(11-i),y=Math.floor(n/12),m=n%12+1;return`${y}-${String(m).padStart(2,'0')}`});
  const cats=['swimming','tennis','snowboarding','other'],labels=['Плавание','Теннис','Сноуборд','Прочее'],cols=[pal.c1,pal.c2,pal.c6,pal.c3];
  const data=months.map(m=>cats.map(c=>wos.filter(x=>monthKey(x.start_ts)===m&&catGroup(x)===c).length));
  const totals=data.map(a=>a.reduce((x,y)=>x+y,0)),maxY=Math.max(4,Math.ceil(Math.max(...totals)/4)*4);
  legend.innerHTML=labels.map((name,i)=>`<span><i class="dot" style="background:${cols[i]}"></i>${name}</span>`).join('');
  drawGrid(ctx,pad,w,h,maxY,0,pal,v=>`${Math.round(v)}`);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,step=plotW/12,bw=Math.min(26,Math.max(4,step*0.68));
  months.forEach((m,i)=>{
    const x=pad.l+i*step+(step-bw)/2;let y=pad.t+plotH;
    cats.forEach((c,j)=>{const val=data[i][j];if(!val)return;const bh=(val/maxY)*plotH;ctx.fillStyle=cols[j];ctx.fillRect(x,y-bh,bw,bh);y-=bh});
    if(i%2===0){ctx.fillStyle=pal.muted;ctx.font='10px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText(m.slice(5)+'.'+m.slice(2,4),x+bw/2,h-pad.b+5)}
  });
  canvas.onmousemove=(e)=>{
    const rect=canvas.getBoundingClientRect(),idx=Math.floor((e.clientX-rect.left-pad.l)/step);
    if(idx<0||idx>=months.length){hideTip();return}
    const m=months[idx],a=data[idx];
    showTip(e.clientX,e.clientY,`${m}\nПлавание: ${a[0]}\nТеннис: ${a[1]}\nСноуборд: ${a[2]}\nПрочее: ${a[3]}`);
  };
  canvas.onmouseleave=hideTip;
}

function renderSwim(wos){
  const d=setupCanvas('swimChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:44,r:32,t:10,b:24};
  const swims=wos.filter(x=>sportCat(x)==='swimming'&&x.distance_m>0).sort((a,b)=>a.start_ts-b.start_ts).slice(-30);
  if(!swims.length){drawEmpty(ctx,w,h,pal,'Нет плавательных тренировок с дистанцией');canvas.onmousemove=null;return}
  const maxD=Math.max(500,Math.ceil(Math.max(...swims.map(s=>s.distance_m))/250)*250);
  drawGrid(ctx,pad,w,h,maxD,0,pal,v=>`${Math.round(v)}`);
  drawXLabels(ctx,pad,w,h,swims.map(s=>fmtDate(isoDate(s.start_ts))),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,barW=Math.min(28,Math.max(2,plotW/swims.length*0.65));
  swims.forEach((s,i)=>{const x=pad.l+(swims.length===1?plotW/2:(i/(swims.length-1))*plotW)-barW/2,bh=(s.distance_m/maxD)*plotH;ctx.fillStyle=pal.c1;ctx.globalAlpha=0.58;ctx.fillRect(x,pad.t+plotH-bh,barW,bh)});
  ctx.globalAlpha=1;
  const hrMin=80,hrMax=180;
  ctx.fillStyle=pal.c5;ctx.font='10px ui-monospace,monospace';ctx.textAlign='left';ctx.textBaseline='middle';
  ctx.fillText('180',w-pad.r+4,pad.t+4);ctx.fillText('80',w-pad.r+4,pad.t+plotH);
  const hrPts=[];
  swims.forEach((s,i)=>{if(!s.avg_hr)return;const x=pad.l+(swims.length===1?plotW/2:(i/(swims.length-1))*plotW),y=pad.t+plotH*(1-Math.max(0,Math.min(1,(s.avg_hr-hrMin)/(hrMax-hrMin))));hrPts.push([x,y])});
  ctx.strokeStyle=pal.c5;ctx.lineWidth=1.8;ctx.beginPath();hrPts.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
  if(hrPts.length===1){ctx.fillStyle=pal.c5;ctx.beginPath();ctx.arc(hrPts[0][0],hrPts[0][1],2.5,0,Math.PI*2);ctx.fill()}
  attachHover(canvas,pad,swims.length,i=>{const s=swims[i];return`${fmtDate(isoDate(s.start_ts))}\nДистанция: ${fmt(s.distance_m)} м (${Math.round((s.duration_s||0)/60)} мин)\nКалории: ${s.calories!=null?fmt(s.calories)+' ккал':'—'}`+(s.avg_hr?`\nПульс ср/макс: ${Math.round(s.avg_hr)}/${s.max_hr?Math.round(s.max_hr):'—'}`:'')+(s.swolf?`\nSWOLF: ${Math.round(s.swolf)}`:'')});
}

function renderZones(wos){
  const d=setupCanvas('zonesChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:36,r:8,t:10,b:24};
  const groups=new Map();
  wos.forEach(x=>{
    if(!x.zones||!x.zones.length)return;
    const total=x.zones.reduce((a,b)=>a+b,0);if(total<=0)return;
    const cat=sportCat(x),g=groups.get(cat)||[0,0,0,0];
    g[0]+=x.zones[0]/60;g[1]+=x.zones[1]/60;g[2]+=x.zones[2]/60;g[3]+=(x.zones[3]+x.zones[4])/60;groups.set(cat,g);
  });
  const keys=[...groups.keys()].filter(k=>groups.get(k).reduce((a,b)=>a+b,0)>0.05).sort((a,b)=>groups.get(b).reduce((s,v)=>s+v,0)-groups.get(a).reduce((s,v)=>s+v,0));
  if(!keys.length){drawEmpty(ctx,w,h,pal,'Нет данных о пульсовых зонах');canvas.onmousemove=null;return}
  const totals=keys.map(k=>groups.get(k).reduce((a,b)=>a+b,0)),maxY=Math.max(2,Math.ceil(Math.max(...totals)/2)*2);
  drawGrid(ctx,pad,w,h,maxY,0,pal,v=>`${v.toFixed(0)}ч`);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,step=plotW/keys.length,bw=Math.min(44,step*0.56),zCols=[pal.c6,pal.c2,pal.c3,pal.c5];
  keys.forEach((k,i)=>{
    const x=pad.l+i*step+(step-bw)/2;let y=pad.t+plotH;
    groups.get(k).forEach((val,zi)=>{if(!val)return;const bh=(val/maxY)*plotH;ctx.fillStyle=zCols[zi];ctx.fillRect(x,y-bh,bw,bh);y-=bh});
    ctx.fillStyle=pal.muted;ctx.font='10.5px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText(SPORT_LABELS[k]||'Прочее',x+bw/2,h-pad.b+5);
  });
  canvas.onmousemove=(e)=>{
    const rect=canvas.getBoundingClientRect(),idx=Math.floor((e.clientX-rect.left-pad.l)/step);
    if(idx<0||idx>=keys.length){hideTip();return}
    const k=keys[idx],g=groups.get(k);
    showTip(e.clientX,e.clientY,`${SPORT_LABELS[k]||'Прочее'}\nРазминка: ${g[0].toFixed(1)} ч\nЖиросжигание: ${g[1].toFixed(1)} ч\nАэробная: ${g[2].toFixed(1)} ч\nАнаэробная+: ${g[3].toFixed(1)} ч`);
  };
  canvas.onmouseleave=hideTip;
}

function renderSleep(rows){
  const d=setupCanvas('sleepStagesChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:38,r:10,t:10,b:24};
  const data=rows.filter(r=>r.sleep_min>0&&r.sleep_min<=960);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  const hrs=data.map(r=>r.sleep_min/60),avg=movingAvg(hrs,14),maxY=Math.max(8,Math.ceil(Math.max(...hrs)));
  drawGrid(ctx,pad,w,h,maxY,0,pal,v=>`${v.toFixed(0)}ч`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,barW=Math.min(28,Math.max(1.5,plotW/data.length*0.72));
  data.forEach((r,i)=>{
    const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW)-barW/2;let y=pad.t+plotH;
    const deep=(r.sleep_deep||0)/3600,rem=(r.sleep_rem||0)/3600,light=Math.max(0,r.sleep_min/60-deep-rem);
    [[deep,pal.c4],[rem,pal.c6],[light,pal.c1]].forEach(([m,col])=>{if(!m)return;const bh=(m/maxY)*plotH;ctx.fillStyle=col;ctx.globalAlpha=0.72;ctx.fillRect(x,y-bh,barW,bh);y-=bh});
  });
  ctx.globalAlpha=1;
  ctx.strokeStyle=pal.c3;ctx.lineWidth=2;ctx.beginPath();
  avg.forEach((v,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW),y=pad.t+plotH*(1-v/maxY);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});
  ctx.stroke();
  attachHover(canvas,pad,data.length,i=>{const r=data[i];const deep=(r.sleep_deep||0)/60,rem=(r.sleep_rem||0)/60,light=Math.max(0,r.sleep_min-deep-rem);return`${fmtDate(r.date)} · Сон: ${fmtMin(r.sleep_min)}\nГлуб: ${fmtMin(deep)} · REM: ${fmtMin(rem)} · Лёгк: ${fmtMin(light)}`});
}

function bedHour(r){const h=r.sleep_bedtime;if(h==null)return null;return h<12?h+24:h}
function wakeHour(r){const h=r.sleep_waketime;if(h==null)return null;let wake=h<12?h+24:h;const bed=bedHour(r);if(bed!=null&&wake<=bed)wake+=24;return wake}

function renderSleepSchedule(rows){
  const d=setupCanvas('sleepScheduleChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:42,r:10,t:10,b:24};
  const data=rows.filter(r=>{const b=bedHour(r),w=wakeHour(r);return b!=null&&w!=null&&r.sleep_min>0&&r.sleep_min<=960&&w>b&&w-b<=16});
  if(!data.length){drawEmpty(ctx,w,h,pal,'Нет данных о режиме сна');canvas.onmousemove=null;return}
  const minY=21,maxY=37;
  drawGrid(ctx,pad,w,h,maxY,minY,pal,v=>fmtClock(v));
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,yOf=v=>pad.t+plotH*(1-Math.max(0,Math.min(1,(v-minY)/(maxY-minY))));
  ctx.strokeStyle=pal.border;ctx.lineWidth=1.4;
  data.forEach((r,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW);ctx.beginPath();ctx.moveTo(x,yOf(bedHour(r)));ctx.lineTo(x,yOf(wakeHour(r)));ctx.stroke()});
  const bedAvg=movingAvg(data.map(r=>bedHour(r)),14),wakeAvg=movingAvg(data.map(r=>wakeHour(r)),14);
  [[bedAvg,pal.c4],[wakeAvg,pal.c3]].forEach(([arr,col])=>{ctx.strokeStyle=col;ctx.lineWidth=2;ctx.beginPath();arr.forEach((v,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW);if(i===0)ctx.moveTo(x,yOf(v));else ctx.lineTo(x,yOf(v))});ctx.stroke()});
  attachHover(canvas,pad,data.length,i=>{const r=data[i];return`${fmtDate(r.date)}\nОтбой: ${fmtClock(bedHour(r))} · Подъём: ${fmtClock(wakeHour(r))}`});
}

function renderHr(rows){
  const d=setupCanvas('hrChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:38,r:10,t:10,b:24};
  const data=rows.filter(r=>r.hr_avg>0||r.rhr>0);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  const vals=data.flatMap(r=>[r.hr_min,r.hr_max,r.hr_avg,r.rhr].filter(v=>v>0));
  const minY=Math.max(35,Math.floor(Math.min(...vals)/10)*10-10),maxY=Math.ceil(Math.max(...vals)/10)*10+10;
  drawGrid(ctx,pad,w,h,maxY,minY,pal,v=>`${Math.round(v)}`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,yOf=v=>pad.t+plotH*(1-(v-minY)/(maxY-minY));
  ctx.strokeStyle=pal.border;ctx.lineWidth=1.2;
  data.forEach((r,i)=>{if(!r.hr_min||!r.hr_max)return;const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW);ctx.beginPath();ctx.moveTo(x,yOf(r.hr_min));ctx.lineTo(x,yOf(r.hr_max));ctx.stroke()});
  const avgPts=[],rhrPts=[];
  data.forEach((r,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW);if(r.hr_avg)avgPts.push([x,yOf(r.hr_avg)]);if(r.rhr)rhrPts.push([x,yOf(r.rhr)])});
  ctx.strokeStyle=pal.c5;ctx.lineWidth=1.8;ctx.beginPath();avgPts.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
  if(avgPts.length===1){ctx.fillStyle=pal.c5;ctx.beginPath();ctx.arc(avgPts[0][0],avgPts[0][1],2.5,0,Math.PI*2);ctx.fill()}
  ctx.strokeStyle=pal.c2;ctx.lineWidth=2;ctx.beginPath();rhrPts.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
  if(rhrPts.length===1){ctx.fillStyle=pal.c2;ctx.beginPath();ctx.arc(rhrPts[0][0],rhrPts[0][1],2.5,0,Math.PI*2);ctx.fill()}
  attachHover(canvas,pad,data.length,i=>{const r=data[i];return`${fmtDate(r.date)}\nСр. пульс: ${r.hr_avg?Math.round(r.hr_avg):'—'} (мин ${r.hr_min?Math.round(r.hr_min):'—'} / макс ${r.hr_max?Math.round(r.hr_max):'—'})`+(r.rhr?`\nПульс покоя (RHR): ${Math.round(r.rhr)}`:'')});
}

function renderStress(rows){
  const d=setupCanvas('stressChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:38,r:10,t:10,b:24};
  const data=rows.filter(r=>r.stress_avg>0||r.spo2_avg>0);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  drawGrid(ctx,pad,w,h,100,0,pal,v=>`${Math.round(v)}`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,yOf=v=>pad.t+plotH*(1-v/100);
  [['stress_avg',pal.c3],['spo2_avg',pal.c6]].forEach(([key,col])=>{
    const pts=[];
    data.forEach((r,i)=>{if(!r[key])return;const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW);pts.push([x,yOf(r[key])])});
    ctx.strokeStyle=col;ctx.lineWidth=1.8;ctx.beginPath();pts.forEach(([x,y],i)=>{if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.stroke();
    if(pts.length===1){ctx.fillStyle=col;ctx.beginPath();ctx.arc(pts[0][0],pts[0][1],2.5,0,Math.PI*2);ctx.fill()}
  });
  attachHover(canvas,pad,data.length,i=>{const r=data[i];return`${fmtDate(r.date)}`+(r.stress_avg?`\nСтресс ср: ${Math.round(r.stress_avg)}`:'')+(r.spo2_avg?`\nSpO2 ср: ${r.spo2_avg.toFixed(1)}%`:'')});
}

function renderCal(rows,wos){
  const d=setupCanvas('calChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:42,r:32,t:10,b:24};
  const data=rows.filter(r=>r.calories!=null);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  const loadByDay=new Map(),woCount=new Map();
  wos.forEach(w=>{const day=isoDate(w.start_ts);if(w.load!=null)loadByDay.set(day,(loadByDay.get(day)||0)+w.load);woCount.set(day,(woCount.get(day)||0)+1)});
  const cals=data.map(r=>r.calories||0),maxC=Math.max(500,Math.ceil(Math.max(...cals,100)/250)*250);
  drawGrid(ctx,pad,w,h,maxC,0,pal,v=>`${Math.round(v)}`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,barW=Math.min(28,Math.max(1.5,plotW/data.length*0.7));
  data.forEach((r,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW)-barW/2,bh=((r.calories||0)/maxC)*plotH;ctx.fillStyle=pal.c3;ctx.globalAlpha=0.55;ctx.fillRect(x,pad.t+plotH-bh,barW,bh)});
  ctx.globalAlpha=1;
  const loads=data.map(r=>loadByDay.get(r.date)||0),maxL=Math.max(...loads);
  if(maxL>0){
    ctx.fillStyle=pal.c1;ctx.font='10px ui-monospace,monospace';ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(`${Math.round(maxL)}`,w-pad.r+4,pad.t+4);
    ctx.strokeStyle=pal.c1;ctx.lineWidth=1.6;ctx.beginPath();
    loads.forEach((v,i)=>{const x=pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW),y=pad.t+plotH*(1-v/maxL);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});
    ctx.stroke();
  }
  attachHover(canvas,pad,data.length,i=>{const r=data[i];return`${fmtDate(r.date)}\nКалории: ${fmt(r.calories||0)} ккал\nНагрузка: ${Math.round(loads[i])}\nТренировок: ${woCount.get(r.date)||0}`});
}

function renderWeight(rows){
  const d=setupCanvas('weightChart');if(!d)return;
  const{canvas,ctx,w,h}=d,pal=palette(),pad={l:40,r:10,t:10,b:24};
  let data=rows.filter(r=>r.weight!=null);
  if(!data.length)data=state.heatDaily.filter(r=>r.weight!=null);
  if(!data.length){drawEmpty(ctx,w,h,pal);canvas.onmousemove=null;return}
  const ws=data.map(r=>r.weight),minW=Math.floor(Math.min(...ws)-1),maxW=Math.ceil(Math.max(...ws)+1);
  drawGrid(ctx,pad,w,h,maxW,minW,pal,v=>`${v.toFixed(0)}`);
  drawXLabels(ctx,pad,w,h,data.map(r=>fmtDate(r.date)),pal);
  const plotW=w-pad.l-pad.r,plotH=h-pad.t-pad.b,xOf=i=>pad.l+(data.length===1?plotW/2:(i/(data.length-1))*plotW),yOf=v=>pad.t+plotH*(1-(v-minW)/(maxW-minW));
  ctx.strokeStyle=pal.c2;ctx.lineWidth=2;ctx.beginPath();data.forEach((r,i)=>{if(i===0)ctx.moveTo(xOf(i),yOf(r.weight));else ctx.lineTo(xOf(i),yOf(r.weight))});ctx.stroke();
  data.forEach((r,i)=>{ctx.fillStyle=pal.c2;ctx.beginPath();ctx.arc(xOf(i),yOf(r.weight),2.5,0,Math.PI*2);ctx.fill()});
  attachHover(canvas,pad,data.length,i=>`${fmtDate(data[i].date)}\nВес: ${data[i].weight.toFixed(1)} кг`);
}

function renderRecords(rows,wos){
  const el=$('#records');if(!el)return;
  const bestSteps=rows.filter(r=>r.steps>0).reduce((b,r)=>!b||r.steps>b.steps?r:b,null);
  const bestSwim=wos.filter(w=>sportCat(w)==='swimming'&&w.distance_m>0).reduce((b,w)=>!b||w.distance_m>b.distance_m?w:b,null);
  const longest=wos.reduce((b,w)=>!b||w.duration_s>b.duration_s?w:b,null);
  const longestName=longest?workoutTitle(longest):'';
  const bestSleep=rows.filter(r=>r.sleep_min>0&&r.sleep_min<=960).reduce((b,r)=>!b||r.sleep_min>b.sleep_min?r:b,null);
  const lowRhr=rows.filter(r=>r.rhr>0).reduce((b,r)=>!b||r.rhr<b.rhr?r:b,null);
  const maxCal=rows.filter(r=>r.calories>0).reduce((b,r)=>!b||r.calories>b.calories?r:b,null);
  const cards=[
    bestSteps?{k:'Максимум шагов',v:fmt(bestSteps.steps),d:fmtDate(bestSteps.date)}:null,
    bestSwim?{k:'Лучший заплыв',v:`${fmt(bestSwim.distance_m)} м`,d:`${fmtDate(isoDate(bestSwim.start_ts))} · ${Math.round((bestSwim.duration_s||0)/60)} мин`}:null,
    longest?{k:'Самая долгая трен.',v:`${Math.round((longest.duration_s||0)/60)} мин`,d:`${esc(longestName)} · ${fmtDate(isoDate(longest.start_ts))}`}:null,
    bestSleep?{k:'Самый долгий сон',v:fmtMin(bestSleep.sleep_min),d:fmtDate(bestSleep.date)}:null,
    lowRhr?{k:'Минимальный RHR',v:`${Math.round(lowRhr.rhr)} уд/мин`,d:fmtDate(lowRhr.date)}:null,
    maxCal?{k:'Максимум калорий',v:`${fmt(maxCal.calories)} ккал`,d:fmtDate(maxCal.date)}:null,
  ].filter(Boolean);
  el.innerHTML=cards.length?cards.map(c=>`<div class="rec"><div class="rec-k">${c.k}</div><div class="rec-v">${c.v}</div><div class="rec-d">${c.d}</div></div>`).join(''):'<div class="empty">Нет данных за период</div>';
}

function renderWorkoutsTable(wos){
  const tbl=$('#woTable');if(!tbl)return;
  const list=wos.filter(w=>{
    if(state.woCat==='all')return true;
    if(state.woCat==='other')return !['swimming','tennis','snowboarding'].includes(sportCat(w));
    return sportCat(w)===state.woCat;
  }).sort((a,b)=>b.start_ts-a.start_ts).slice(0,12);
  if(!list.length){tbl.innerHTML='<tbody><tr><td class="empty" colspan="6">Нет тренировок за выбранный период</td></tr></tbody>';return}
  const nameFor=workoutTitle;
  const dist=w=>w.distance_m?(w.distance_m>=1000?`${(w.distance_m/1000).toFixed(2)} км`:`${Math.round(w.distance_m)} м`):'—';
  const hr=w=>w.avg_hr?`${Math.round(w.avg_hr)} / ${w.max_hr?Math.round(w.max_hr):'—'}`:'—';
  tbl.innerHTML=`<thead><tr><th>Дата</th><th>Вид спорта</th><th>Длит.</th><th>Дист.</th><th>Пульс</th><th>Ккал</th></tr></thead><tbody>${list.map(w=>`<tr><td>${fmtDate(isoDate(w.start_ts))}</td><td>${esc(nameFor(w))}</td><td>${Math.round((w.duration_s||0)/60)} мин</td><td>${dist(w)}</td><td>${hr(w)}</td><td>${w.calories!=null?fmt(Math.round(w.calories)):'—'}</td></tr>`).join('')}</tbody>`;
}

function renderAnalytics(){
  const rows=state.daily,wos=workoutsForPeriod();
  renderKpis(rows,wos);
  renderSteps(rows);
  renderHeatmap();
  renderWeekday(rows,wos);
  renderSports(wos);
  renderMonthlyWorkouts();
  renderSwim(wos);
  renderZones(wos);
  renderSleep(rows);
  renderSleepSchedule(rows);
  renderHr(rows);
  renderStress(rows);
  renderCal(rows,wos);
  renderWeight(rows);
  renderRecords(rows,wos);
  renderWorkoutsTable(wos);
}

async function loadWorkouts(){
  const period=$('#workoutPeriod')?.value||'all';
  const requests=[api(`/api/workouts?period=${period}`),period==='year'?Promise.resolve(null):api('/api/workouts?period=year')];
  if(period!=='all'&&state.allWorkouts===null)requests.push(api('/api/workouts?period=all'));
  const[data,heat,all]=await Promise.all(requests);
  if(period==='all')state.allWorkouts=data.workouts||[];
  else if(all)state.allWorkouts=all.workouts||[];
  state.workouts=data.workouts||[];
  state.heatWorkouts=(heat||data).workouts||[];
  renderWorkouts();
  if(state.view==='dashboard')renderAnalytics();
}

function sportIcon(kind){if(kind.includes('swim'))return'≈';if(kind.includes('run')||kind.includes('walk'))return'↗';if(kind.includes('snow'))return'❄';if(kind.includes('tennis'))return'◉';return'⌁'}
function renderWorkouts(){const el=$('#workoutList');if(!state.workouts.length){el.innerHTML='<div class="empty">Нет тренировок за выбранный период. Импортируйте ZIP-архив или подключите Open Gym.</div>';return}el.innerHTML=state.workouts.map(w=>`<div class="workout-row" data-id="${w.id}"><span class="sport-icon">${sportIcon(w.kind)}</span><div><div class="workout-name">${esc(workoutTitle(w))}</div><div class="workout-sub">${dateFmt(w.start_ts)} · ${timeFmt(w.start_ts)} · ${duration(w.duration_s)}${w.gym?'<br><span class="gym-tag">Open Gym сопоставлен</span>':''}</div></div><div class="workout-stat"><span>Калории</span><b>${w.calories!=null?`${fmt(Math.round(w.calories))} ккал`:'—'}</b></div><div class="workout-stat"><span>Пульс ср.</span><b>${w.avg_hr?`${Math.round(w.avg_hr)} уд/мин`:'—'}</b></div><div class="workout-stat"><span>Дистанция</span><b>${w.distance_m?`${(w.distance_m/1000).toFixed(2)} км`:'—'}</b></div><button class="btn outline">Подробнее</button></div>`).join('');$$('.workout-row',el).forEach(row=>row.addEventListener('click',()=>showWorkout(row.dataset.id)))}
async function showWorkout(id){try{const url=String(id).startsWith('gym:')?`/api/workouts/gym/${String(id).slice(4)}`:`/api/workouts/${id}`;const w=await api(url);const gym=w.gym?.detail;let exercises='';if(gym?.entries?.length)exercises=gym.entries.map(e=>{const sets=(e.sets||[]).filter(s=>s.done!==false);const count=sets.length,reps=sets.reduce((n,s)=>n+(Number(s.r)||0),0),vol=sets.reduce((n,s)=>n+(Number(s.w)||0)*(Number(s.r)||0),0);return `<div class="exercise"><b>${esc(e.exercise_name||e.name||e.id||'Упражнение')}</b>${e.exercise_name_en?` <span class="ex-en">(${esc(e.exercise_name_en)})</span>`:''}<br><small>${count} подходов · ${reps} повторений · объём ${fmt(Math.round(vol))} кг</small>${sets.length?`<br><small>${sets.map(s=>`${esc(s.w??'—')} кг × ${esc(s.r??'—')}`).join(' · ')}</small>`:''}</div>`}).join('');const raw=w.raw||{},other=Object.entries(raw).filter(([k,v])=>!['start_time','end_time','duration','calories','min_hrm','avg_hrm','max_hrm','distance'].includes(k)&&['string','number','boolean'].includes(typeof v)).map(([k,v])=>`<div class="compare-stat"><span>${esc(k.replaceAll('_',' '))}</span><b>${esc(v)}</b></div>`).join('');$('#workoutDetail').innerHTML=`<div class="eyebrow">${esc(w.source==='opengym'||w.kind==='opengym'?'OPEN GYM':'ТРЕНИРОВКА')}</div><h2>${esc(workoutTitle(w))}</h2><p class="muted">${dateFmt(w.start_ts)} · ${timeFmt(w.start_ts)} · ${duration(w.duration_s)}</p><div class="detail-kpis"><div><small>Калории</small><b>${w.calories!=null?`${fmt(Math.round(w.calories))} ккал`:'—'}</b></div><div><small>Пульс</small><b>${w.min_hr||'—'} / ${w.avg_hr?Math.round(w.avg_hr):'—'} / ${w.max_hr||'—'}</b></div><div><small>Дистанция</small><b>${w.distance_m?`${Math.round(w.distance_m)} м`:'—'}</b></div></div>${w.swolf?`<div class="detail-section"><h3>Плавание</h3><p>SWOLF: ${esc(w.swolf)}</p></div>`:''}${w.gym?`<div class="detail-section"><h3>Open Gym · ${esc(w.gym.name)}</h3><p class="muted">${w.kind==='opengym'?'Тренировка из Open Gym.':'Подобрано автоматически по времени начала (±30 минут).'}</p>${exercises||'<p class="muted">Нет подробностей по упражнениям.</p>'}</div>`:''}${other?`<div class="detail-section"><h3>Показатели импорта</h3>${other}</div>`:''}`;$('#detailDialog').showModal()}catch(e){toast(e.message)}}
function renderCompare(data){const people=data.people||[],el=$('#compareList');if(!people.length){el.innerHTML=`<div class="panel empty">${data.needs_consent?'Чтобы увидеть сравнение, сначала включите согласие на обмен сводными показателями.':'Пока другие участники не разрешили сравнение.'}</div>`;return}const me=people.find(p=>p.is_me);el.innerHTML=people.map(p=>{const delta=p.is_me?0:p.workouts-(me?.workouts||0);return `<article class="compare-card"><h3>${esc(p.username)} ${p.is_me?'<span class="unit">Вы</span>':''}</h3><div class="compare-stat"><span>Тренировки за период</span><b>${fmt(p.workouts)}${p.is_me?'':` · ${delta>0?'+':''}${fmt(delta)} к вам`}</b></div><div class="compare-stat"><span>${p.is_me?'Дней с тренировками':'Совпавшие дни тренировок'}</span><b>${fmt(p.common_workout_days)}</b></div><div class="compare-stat"><span>Шаги за 30 дней</span><b>${fmt(p.last_30_days.steps)}</b></div><div class="compare-stat"><span>Калории, ккал · 30 дней</span><b>${fmt(p.last_30_days.calories)}</b></div><div class="compare-stat"><span>Пульс, средний</span><b>${p.last_30_days.heart_rate?`${p.last_30_days.heart_rate} уд/мин`:'—'}</b></div><div class="compare-stat"><span>Сон, средний</span><b>${p.last_30_days.sleep_minutes?`${(p.last_30_days.sleep_minutes/60).toFixed(1)} ч`:'—'}</b></div></article>`}).join('')}
async function changeView(view){state.view=view;$$('.view').forEach(el=>el.hidden=el.id!==`view-${view}`);$$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));$('#pageTitle').textContent={dashboard:'Обзор',workouts:'Тренировки',compare:'Сравнение',settings:'Настройки'}[view];if(view==='dashboard')renderAnalytics();if(view==='compare'){const d=await api('/api/compare');renderCompare(d)}if(view==='settings')await loadGymStatus()}
function openImport(){$('#importError').textContent='';state.importsHidden=false;$('#importDialog').showModal()}
function importTime(){return new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date())}
function importMoment(value){const date=value?new Date(value):new Date();return Number.isNaN(date.getTime())?importTime():new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date)}
function importStatus(job){if(job.status==='uploading')return `Загрузка ${Number(job.progress)||0}%`;if(job.status==='processing'){const counts=(job.metrics||job.workouts)?` · ${fmt(job.metrics)} показ. / ${fmt(job.workouts)} трен.`:'';return 'Обработка архива…'+counts}if(job.status==='error')return job.error||'Ошибка импорта';const counts=(job.metrics||job.workouts)?` · ${fmt(job.metrics)} показ. / ${fmt(job.workouts)} трен.`:'';return job.duplicate?'Уже импортирован':`Готово${counts}`}
function importRow(job){const cls=job.status==='done'?'ok':job.status==='error'?'error':'';const progress=job.status==='done'?'done':job.status==='error'?'error':job.status==='processing'?'processing':'';const width=job.status==='uploading'?Math.min(99,Number(job.progress)||0):job.status==='done'||job.status==='error'?100:0;const text=importStatus(job);return `<tr><td>${esc(importMoment(job.created_at))}</td><td class="import-file" title="${esc(job.file_name)}">${esc(job.file_name)}</td><td><span class="import-state ${cls}" title="${esc(text)}">${esc(text)}</span></td><td><div class="import-progress ${progress}"><div class="import-progress-track"><div class="import-progress-bar"${width?` style="width:${width}%"`:''}></div></div></div></td></tr>`}
function renderImports(){const body=$('#importRows');if(!body)return;body.innerHTML=state.imports.map(importRow).join('');$('#importStatus').hidden=!state.imports.length||state.importsHidden}
function stopImportPolling(){if(state.importsPoll)clearInterval(state.importsPoll);state.importsPoll=null}
function startImportPolling(){if(state.importsPoll)return;state.importsPoll=setInterval(async()=>{if(!state.imports.some(job=>job.status==='processing')){stopImportPolling();return}await loadImports(true)},1500)}
async function loadImports(silent=false){try{const data=await api('/api/imports'),items=data.items||[],previous=new Map(state.imports.filter(job=>typeof job.id==='number').map(job=>[job.id,job.status])),local=state.imports.filter(job=>typeof job.id!=='number'&&!items.some(item=>item.file_name===job.file_name&&new Date(item.created_at).getTime()>=new Date(job.created_at).getTime()-5000));state.imports=[...local,...items];let reload=false;for(const job of state.imports){if(job.status==='processing')state.importWatched.add(job.id);const was=previous.get(job.id),watched=state.importWatched.has(job.id);if(was==='processing'||watched){if(job.status==='done'){state.importWatched.delete(job.id);toast(`Импорт завершён: ${fmt(job.metrics)} показ. / ${fmt(job.workouts)} трен.`);reload=true}else if(job.status==='error'){state.importWatched.delete(job.id);notice(job.error||'Импорт не завершён',true)}}}renderImports();if(reload){await loadDashboard();await loadWorkouts()}if(state.imports.some(job=>job.status==='processing'))startImportPolling();else stopImportPolling()}catch(err){if(!silent)notice(err.message,true)}}
function submitImport(e){
  e.preventDefault();
  const formEl=e.currentTarget,form=new FormData(formEl),file=form.get('file');
  const fileName=file instanceof File?file.name:'архив.zip';
  const local={id:`upload-${Date.now()}`,file_name:fileName,status:'uploading',progress:0,metrics:0,workouts:0,created_at:new Date().toISOString()};
  state.imports=[local,...state.imports];state.importsHidden=false;renderImports();
  formEl.reset();
  $('#importDialog').close();
  const xhr=new XMLHttpRequest();
  xhr.open('POST','/api/import');
  xhr.withCredentials=true;
  xhr.upload.addEventListener('progress',event=>{if(!event.lengthComputable)return;local.progress=Math.min(99,Math.round(event.loaded/event.total*100));renderImports()});
  xhr.upload.addEventListener('load',()=>{local.status='processing';local.progress=0;renderImports()});
  xhr.addEventListener('load',async()=>{
    let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch{}
    if(xhr.status>=200&&xhr.status<300){
      state.imports=[data,...state.imports.filter(job=>String(job.id)!==String(local.id)&&String(job.id)!==String(data.id))];
      if(data.status==='done'){renderImports();toast(data.duplicate?'Архив уже был импортирован':`Импорт завершён: ${fmt(data.metrics)} показ. / ${fmt(data.workouts)} трен.`);await loadDashboard();await loadWorkouts()}
      else if(data.status==='error'){renderImports();notice(data.error||'Импорт не завершён',true)}
      else{state.importWatched.add(data.id);renderImports();startImportPolling()}
    }else{
      local.status='error';local.error=data.detail||data.error||`Ошибка ${xhr.status}`;renderImports();notice(local.error,true);
    }
  });
  xhr.addEventListener('error',()=>{local.status='error';local.error='Связь с сервером прервана';renderImports();notice('Связь прервана. Проверяем статус импорта…',true);setTimeout(()=>loadImports(true),2500)});
  xhr.send(form);
}
async function loadGymStatus(){try{const s=await api('/api/opengym/status'),connected=s.connected;$('#gymState').hidden=!connected;$('#gymActions').hidden=!connected;$('#gymForm').hidden=connected;if(connected){$('#gymServer').textContent=s.base_url||'';$('#gymWorkouts').textContent=fmt(s.workouts);$('#gymForm [name=base_url]').value=s.base_url||'';$('#gymForm [name=token]').value=''}else{$('#gymConnect').textContent='Подключить'}}catch(err){notice(err.message,true)}}
async function submitGym(e){e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));try{const result=await api('/api/opengym/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});toast(`Подключён профиль ${result.profile}`);e.currentTarget.reset();e.currentTarget.base_url.value=data.base_url;await loadGymStatus();await syncGym()}catch(err){notice(err.message,true)}}
async function syncGym(){try{const result=await api('/api/opengym/sync',{method:'POST'});toast(`Синхронизировано тренировок Open Gym: ${result.workouts}`);await loadWorkouts();await loadGymStatus()}catch(err){notice(err.message,true)}}
document.addEventListener('click',async e=>{const nav=e.target.closest('[data-view]');if(nav)return changeView(nav.dataset.view);const goto=e.target.closest('[data-goto]');if(goto)return changeView(goto.dataset.goto);const period=e.target.closest('[data-period]');if(period){state.period=period.dataset.period;$$('#periods button').forEach(b=>b.classList.toggle('active',b===period));return loadDashboard()}if(e.target.closest('#importOpen,#importOpen2'))return openImport();if(e.target.closest('[data-close]'))return e.target.closest('dialog').close();if(e.target.closest('#importStatusClose')){state.importsHidden=true;$('#importStatus').hidden=true;return}if(e.target.closest('#gymSync'))return syncGym();if(e.target.closest('#gymReplace')){$('#gymForm').hidden=false;$('#gymState').hidden=true;$('#gymActions').hidden=true;$('#gymForm [name=token]').value='';$('#gymConnect').textContent='Сохранить токен';$('#gymForm [name=token]').focus();return}if(e.target.closest('#gymDisconnect')){try{await api('/api/opengym/connect',{method:'DELETE'});toast('Open Gym отключён');await loadWorkouts();await loadGymStatus()}catch(err){notice(err.message,true)}}if(e.target.closest('#inviteCreate')){try{const d=await api('/api/invites',{method:'POST'}),link=$('#newInvite'),meta=$('#inviteMeta');link.href=d.url;link.textContent=d.url;link.hidden=false;meta.textContent=`Ссылка действует до ${new Date(d.expires_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})}`;meta.hidden=false;try{await navigator.clipboard?.writeText(d.url);toast('Ссылка скопирована')}catch{toast('Ссылка создана')}}catch(err){notice(err.message,true)}}if(e.target.closest('#logout,#logoutMobile')){await api('/api/logout',{method:'POST'});location.reload()}});
$('#authForm').addEventListener('submit',loginForm);$('#importForm').addEventListener('submit',submitImport);$('#gymForm').addEventListener('submit',submitGym);$('#workoutPeriod').addEventListener('change',loadWorkouts);$('#shareToggle').addEventListener('change',async e=>{try{await api('/api/preferences/sharing',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:e.target.checked})});state.user.share_comparison=e.target.checked;toast(e.target.checked?'Согласие на сравнение включено':'Согласие отозвано');if(state.view==='compare')renderCompare(await api('/api/compare'))}catch(err){e.target.checked=!e.target.checked;notice(err.message,true)}});window.addEventListener('resize',()=>{if(!$('#app').hidden&&state.view==='dashboard')renderAnalytics()});window.addEventListener('orientationchange',()=>setTimeout(()=>{if(!$('#app').hidden&&state.view==='dashboard')renderAnalytics()},220));$('#hmPills').addEventListener('click',e=>{const btn=e.target.closest('button[data-hm]');if(!btn)return;state.hm=btn.dataset.hm;$$('#hmPills button').forEach(b=>b.classList.toggle('active',b===btn));renderHeatmap()});
$('#woFilter').addEventListener('click',e=>{const btn=e.target.closest('button[data-cat]');if(!btn)return;state.woCat=btn.dataset.cat;$$('#woFilter button').forEach(b=>b.classList.toggle('active',b===btn));renderWorkoutsTable(workoutsForPeriod())});
boot();

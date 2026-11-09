/* Stage → calendar week → day drawer → approximate or exact time slots. */
'use strict';
const goalISO=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const goalShift=(date,n)=>{const d=new Date(date+'T00:00:00');d.setDate(d.getDate()+n);return goalISO(d);};
function goalDates(start,end){const out=[];if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return out;for(let d=start;d<=end&&out.length<366;d=goalShift(d,1))out.push(d);return out;}
function goalWeek(date){const d=new Date(date+'T00:00:00');return goalShift(date,-((d.getDay()+6)%7));}
function goalWeeks(days){const groups=new Map();days.forEach(d=>{const key=goalWeek(d.date);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(d);});return [...groups].map(([key,days])=>({key,days}));}
function goalSlotTitle(s){return `${s.startTime?`${s.startTime}—${s.endTime}`:s.timeLabel||'时间自定'} · ${s.title||'待填写事项'}`;}
function goalMinutes(slots){return slots.reduce((n,s)=>{const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3));return n+(s.startTime&&s.endTime?Math.max(0,mins(s.endTime)-mins(s.startTime)):Number(s.minutes)||0);},0);}
function goalDaysPreview(days){return `<div class="goal-week-preview">${goalWeeks(days).map(w=>{
  const meta=w.days.find(d=>d.schedule)?.schedule,mins=w.days.reduce((n,d)=>n+(d.rest?0:goalMinutes(d.schedule?.slots||[])),0);
  return `<details class="goal-week"><summary>${w.days[0].date} — ${w.days.at(-1).date}<small>${w.days.filter(d=>!d.rest).length} 天安排 · 已估 ${mins} 分钟${meta?.weekMinutes?` / 本周预计 ${meta.weekMinutes} 分钟`:''}</small></summary>${meta?.weekGoal?`<p class="goal-composer-tip">本周：${esc(meta.weekGoal)}</p>`:''}${w.days.map(d=>`<details class="goal-preview-day"><summary>${d.date} · ${d.rest?'休息日':`${d.schedule?.slots.length||d.tasks?.length||0} 项安排`}</summary>${d.rest?'<p>无需打卡</p>':`${d.schedule?.dayGoal?`<p>当天目标：${esc(d.schedule.dayGoal)}</p>`:''}<ul>${(d.schedule?.slots?d.schedule.slots.map(goalSlotTitle):d.tasks||[]).map(t=>`<li>${esc(t)}</li>`).join('')}</ul>`}</details>`).join('')}</details>`;
}).join('')}</div>`;}
function goalCalendarDays(cycle,days){const map=new Map(days.map(d=>[d.dayDate,d]));return goalDates(cycle.calendarStart||toLocalInput(cycle.startAt).slice(0,10),cycle.calendarEnd||toLocalInput(cycle.dueAt).slice(0,10)).map(date=>{const d=map.get(date);return d?{date,schedule:d.schedule,tasks:d.items?.length?d.items.map(i=>i.title):[d.content]}:{date,rest:true};});}
function wireGoalAccordion(root){root.addEventListener('toggle',e=>{const el=e.target;if(el.tagName!=='DETAILS'||!el.open)return;for(const sibling of el.parentElement.children)if(sibling!==el&&sibling.tagName==='DETAILS')sibling.open=false;},true);}

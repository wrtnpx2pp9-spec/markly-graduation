'use strict';
// Optional structured context; legacy plans continue to use plain task titles.
function normalizeSchedule(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('每日安排格式不正确');
  const text=(v,max)=>{if(v===undefined)return '';if(typeof v!=='string'||v.length>max)throw Error('安排文字过长');return v.trim();};
  const number=v=>{if(v===undefined||v===null||v==='')return 0;if(!Number.isInteger(v)||v<0||v>10080)throw Error('预计时长不正确');return v;};
  const time=v=>{const s=text(v,5);if(s&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(s))throw Error('时间格式不正确');return s;};
  if(!Array.isArray(value.slots)||!value.slots.length||value.slots.length>12)throw Error('每天需要1至12项安排');
  const slots=value.slots.map(s=>{
    if(!s||typeof s!=='object')throw Error('时间段格式不正确');
    const refs=s.resourceRefs===undefined?[]:s.resourceRefs;
    if(!Array.isArray(refs)||refs.length>12||refs.some(v=>typeof v!=='string'||!/^source-[\\w-]{1,80}$/.test(v)))throw Error('资料引用格式不正确');
    const slot={title:text(s.title,150),timeLabel:text(s.timeLabel,30),startTime:time(s.startTime),endTime:time(s.endTime),minutes:number(s.minutes),resourceRefs:[...new Set(refs)]};
    if(!slot.title)throw Error('请填写时间段事项');
    if(!!slot.startTime!==!!slot.endTime||slot.startTime&&slot.endTime<=slot.startTime)throw Error('请填写同一天内正确的起止时间');
    if(slot.startTime){const mins=t=>Number(t.slice(0,2))*60+Number(t.slice(3));slot.minutes=mins(slot.endTime)-mins(slot.startTime);}
    if(slot.minutes>1440)throw Error('单项时长最多一天');
    return slot;
  });
  const timed=slots.filter(s=>s.startTime).sort((a,b)=>a.startTime.localeCompare(b.startTime));
  if(timed.some((s,i)=>i&&s.startTime<timed[i-1].endTime))throw Error('当天时间段有重叠，请调整');
  return {weekGoal:text(value.weekGoal,300),weekMinutes:number(value.weekMinutes),dayGoal:text(value.dayGoal,300),slots};
}
function slotTitle(s){return `${s.startTime?`${s.startTime}—${s.endTime}`:s.timeLabel||'时间自定'} · ${s.title}`;}
module.exports={normalizeSchedule,slotTitle};

'use strict';
const crypto = require('crypto');
const plans = require('./plan.repo');
function init(db) {
  if (!db.prepare('PRAGMA table_info(plans)').all().some(c=>c.name==='planning_mode')) db.exec("ALTER TABLE plans ADD COLUMN planning_mode TEXT NOT NULL DEFAULT 'fixed'");
  if (!db.prepare('PRAGMA table_info(plan_day_items)').all().some(c=>c.name==='removed_at')) db.exec('ALTER TABLE plan_day_items ADD COLUMN removed_at INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS daily_plan_proposals(
    id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,day_date TEXT NOT NULL,proposer_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'draft',
    base_json TEXT NOT NULL,payload_json TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',
    decision_note TEXT NOT NULL DEFAULT '',reviewer_id TEXT,submitted_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_open ON daily_plan_proposals(plan_id,day_date) WHERE status IN ('draft','submitted');
    CREATE INDEX IF NOT EXISTS idx_daily_plan ON daily_plan_proposals(plan_id,updated_at);`);
  if (!db.prepare('PRAGMA table_info(daily_plan_proposals)').all().some(c=>c.name==='submitted_at')) db.exec('ALTER TABLE daily_plan_proposals ADD COLUMN submitted_at INTEGER');
}
function snapshot(db,planId,date) {
  const day=db.prepare('SELECT * FROM plan_days WHERE plan_id=? AND day_date=? ORDER BY created_at,id').get(planId,date);
  return day ? {day,items:db.prepare('SELECT * FROM plan_day_items WHERE day_id=? AND removed_at IS NULL ORDER BY seq,id').all(day.id)} : null;
}
function sameExecutionSnapshot(current, base) {
  const comparable = value => {
    if (!value?.day) return value;
    // Scheduling delivery does not change the agreed work or its execution.
    // Normalize BOTH sides so previously saved full snapshots remain valid.
    const { remind_fired_at, overdue_fired_at, ...day } = value.day;
    return { ...value, day };
  };
  return JSON.stringify(comparable(current)) === JSON.stringify(comparable(base));
}
function view(row) {
  return {...row,base:JSON.parse(row.base_json),payload:JSON.parse(row.payload_json),base_json:undefined,payload_json:undefined};
}
function apply(db,plan,row) {
  const data=JSON.parse(row.payload_json),base=JSON.parse(row.base_json),now=Date.now();
  let day=base?.day;
  if (!day) {
    const start=new Date(plan.start_at),target=new Date(row.day_date+'T00:00:00');
    const dateNumber=d=>Date.UTC(d.getFullYear(),d.getMonth(),d.getDate());
    const seq=Math.round((dateNumber(target)-dateNumber(start))/86400000)+1;
    const id=crypto.randomUUID();
    plans.insertDays(db,plan.id,[{id,seq,day_date:row.day_date,content:data.rest?'双方确认休息':data.items.map(i=>i.title).join('；'),items:[],createdAt:now}]);
    day=plans.dayById(db,id);
  }
  const kept=new Set(data.items.map(i=>i.id).filter(Boolean));
  for(const item of base?.items||[]) if(!kept.has(item.id)) db.prepare('UPDATE plan_day_items SET removed_at=? WHERE id=?').run(now,item.id);
  data.items.forEach((item,index)=>{
    if(item.id)db.prepare('UPDATE plan_day_items SET title=?,seq=? WHERE id=?').run(item.title,index+1,item.id);
    else db.prepare('INSERT INTO plan_day_items(id,day_id,plan_id,seq,title,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(),day.id,plan.id,index+1,item.title,'pending',now);
  });
  db.prepare("UPDATE plan_days SET content=?,schedule_json='null',status='pending',checkin_state=?,remind_fired_at=NULL,overdue_fired_at=NULL WHERE id=?")
    .run(data.rest?'双方确认休息':data.items.map(i=>i.title).join('；'),data.rest?'cancelled':'unsubmitted',day.id);
  return day.id;
}
module.exports={init,snapshot,sameExecutionSnapshot,view,apply};

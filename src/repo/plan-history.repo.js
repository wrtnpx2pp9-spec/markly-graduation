"use strict";
const plans = require('./plan.repo');
const stageReviews = require('./phase-review.repo');
// Completion is derived from confirmed execution, never from the deadline alone.
function executionInfo(db, rows) {
  const result = new Map();
  if (!rows.length) return result;
  const ids=rows.map(p=>p.id), marks=ids.map(()=>'?').join(',');
  const children=db.prepare(`SELECT * FROM plans WHERE parent_id IN (${marks})`).all(...ids);
  const childrenByParent = new Map();
  for (const child of children) {
    if (!childrenByParent.has(child.parent_id)) childrenByParent.set(child.parent_id, []);
    childrenByParent.get(child.parent_id).push(child);
  }
  const all=[...new Map([...rows,...children].map(p=>[p.id,p])).values()];
  const allIds=all.map(p=>p.id), placeholders=allIds.map(()=>'?').join(',');
  const counts=new Map(db.prepare(`SELECT plan_id,COUNT(*) total,SUM(checkin_state='approved') done FROM plan_days WHERE status<>'rest' AND checkin_state<>'cancelled' AND plan_id IN (${placeholders}) GROUP BY plan_id`).all(...allIds).map(r=>[r.plan_id,r]));
  const tasks=new Map(db.prepare(`SELECT plan_id,COUNT(*) total,SUM(status='done') done FROM tasks WHERE plan_id IN (${placeholders}) GROUP BY plan_id`).all(...allIds).map(r=>[r.plan_id,r]));
  const reviews=stageReviews.byCycleIds(db,allIds);
  const active=new Set(db.prepare(`SELECT p.id FROM plans p WHERE p.id IN (${placeholders}) AND EXISTS (SELECT 1 FROM supervision_relations r WHERE r.supervisor_id=p.creator_id AND r.supervisee_id=p.assignee_id AND r.status='active' AND EXISTS(SELECT 1 FROM supervision_periods h WHERE h.id=p.cooperation_period_id AND h.ended_at IS NULL))`).all(...allIds).map(p=>p.id));
  function info(p) {
    if(result.has(p.id))return result.get(p.id);
    const count=(p.kind==='cycle'?counts:tasks).get(p.id)||{total:0,done:0};
    let total=count.total,done=count.done,completed=!!(total&&done===total);
    if(p.kind==='phase') {
      const stages=(childrenByParent.get(p.id)||[]).map(info);
      total=stages.reduce((n,s)=>n+s.total,0);done=stages.reduce((n,s)=>n+s.done,0);
      completed=!!stages.length&&stages.every(s=>s.completed);
    }
    if(['proposed','declined'].includes(p.status))completed=false;
    if(p.planning_mode==='rolling' && (!p.due_at || p.due_at>=Date.now()))completed=false;
    const value={completed,total,done,reviewConfirmed:!!reviews.get(p.id)?.locked_at,activeRelation:active.has(p.id)};result.set(p.id,value);return value;
  }
  rows.forEach(info);return result;
}
function serialize(db, rows, user) {
  const execution=executionInfo(db,rows),reviews=stageReviews.byCycleIds(db,rows.map(p=>p.id));
  const coverage=plans.coverageByParentIds(db,rows.filter(p=>p.kind==='phase').map(p=>p.id));
  return rows.map(p=>({...plans.toPlan(p,null,stageReviews.toStageReview(reviews.get(p.id),user),coverage.get(p.id)||null),...execution.get(p.id)}));
}
// Hydrate a whole history tree in bounded batches rather than five queries
// per stage. Keep both task ownership and unpublished proposal privacy gates.
function withDetails(db, records, user) {
  const days = new Map(), items = new Map(), comments = new Map(), tasks = new Map(), proposals = new Map();
  function add(group, id, row) {
    if (!group.has(id)) group.set(id, []);
    group.get(id).push(row);
  }
  for (let offset = 0; offset < records.length; offset += 500) {
    const ids = records.slice(offset, offset + 500).map(record => record.id);
    const marks = ids.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT * FROM plan_days WHERE plan_id IN (${marks}) ORDER BY plan_id,seq,id`).all(...ids)) add(days, row.plan_id, row);
    for (const row of db.prepare(`SELECT * FROM plan_day_items WHERE plan_id IN (${marks}) AND removed_at IS NULL ORDER BY day_id,seq,id`).all(...ids)) add(items, row.day_id, plans.toDayItem(row));
    for (const row of db.prepare(`SELECT * FROM plan_day_comments WHERE plan_id IN (${marks}) ORDER BY created_at,id`).all(...ids)) {
      add(comments, row.day_id, { id: row.id, authorId: row.author_id, authorRole: row.author_role, content: row.content, mood: row.mood, createdAt: row.created_at });
    }
    for (const row of db.prepare(`SELECT plan_id,id,title,status,note,checkin_note AS checkinNote,created_at AS createdAt,due_at AS dueAt,done_at AS doneAt FROM tasks WHERE plan_id IN (${marks}) AND (creator_id=? OR assignee_id=?) ORDER BY created_at,id`).all(...ids, user.id, user.id)) {
      const { plan_id, ...task } = row;
      add(tasks, plan_id, task);
    }
    for (const row of db.prepare(`SELECT * FROM daily_plan_proposals WHERE plan_id IN (${marks}) AND (submitted_at IS NOT NULL OR proposer_id=?) ORDER BY created_at,id`).all(...ids, user.id)) add(proposals, row.plan_id, require('./daily-planning.repo').view(row));
  }
  return records.map(record => ({
    ...record,
    days: (days.get(record.id) || []).map(day => plans.toDay(day, comments.get(day.id) || [], items.get(day.id) || [])),
    tasks: tasks.get(record.id) || [], dailyProposals: proposals.get(record.id) || [],
  }));
}
module.exports={executionInfo,serialize,withDetails};

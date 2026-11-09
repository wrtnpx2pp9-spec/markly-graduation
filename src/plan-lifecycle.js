'use strict';

// A cooperation period spans binding to unbinding; a stage is a dated child plan.
function currentPeriod(db, record) {
  if (record.creator_id === record.assignee_id) return true;
  return !!db.prepare(`SELECT 1 FROM supervision_periods h
    JOIN supervision_relations r ON r.supervisor_id=h.supervisor_id AND r.supervisee_id=h.supervisee_id
    WHERE h.id=? AND h.supervisor_id=? AND h.supervisee_id=? AND h.ended_at IS NULL AND r.status='active'`)
    .get(record.cooperation_period_id, record.creator_id, record.assignee_id);
}

function writable(db, plan) {
  return !!plan && plan.status === 'active' && currentPeriod(db, plan);
}

function calendarDate(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// Reserve entire calendar ranges, including rest days. Declined/archived proposals do not reserve dates.
function overlappingStage(db, parentId, startAt, dueAt, excludeId = '') {
  const start = calendarDate(startAt), end = calendarDate(dueAt);
  return db.prepare("SELECT id,title,start_at,due_at FROM plans WHERE parent_id=? AND kind='cycle' AND status IN ('active','proposed') AND id<>?")
    .all(parentId, excludeId).find(p => calendarDate(p.start_at) <= end && calendarDate(p.due_at) >= start);
}

// Timing only; callers must separately enforce active cooperation and visibility.
function reviewTimingReady(cycle, counts, now) {
  if(cycle.planning_mode==='rolling')return cycle.due_at!=null && cycle.due_at<now;
  return !!(counts.total && counts.done === counts.total) || (cycle.due_at != null && cycle.due_at < now);
}

function readyForReview(db, cycle, now = Date.now()) {
  if (!writable(db, cycle)) return false;
  const counts = cycle.planning_mode === 'rolling' ? null : db.prepare("SELECT COUNT(*) total, SUM(checkin_state='approved') done FROM plan_days WHERE plan_id=? AND status<>'rest' AND checkin_state<>'cancelled'").get(cycle.id);
  return reviewTimingReady(cycle, counts, now);
}

module.exports = { currentPeriod, writable, overlappingStage, readyForReview, reviewTimingReady };

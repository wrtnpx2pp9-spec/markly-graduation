'use strict';
/** 任务数据访问。 */
const crypto = require('crypto');

function toTask(t) {
  if (!t) return null;
  return {
    id: t.id,
    planId: t.plan_id,
    title: t.title,
    note: t.note,
    creatorId: t.creator_id,
    assigneeId: t.assignee_id,
    dueAt: t.due_at,
    remindBeforeMinutes: t.remind_before_minutes,
    status: t.status,
    doneAt: t.done_at,
    checkinNote: t.checkin_note,
    createdAt: t.created_at,
    remindFiredAt: t.remind_fired_at,
    overdueFiredAt: t.overdue_fired_at,
    overdueEscalatedAt: t.overdue_escalated_at,
  };
}

function byId(db, id) {
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}
// scope: { creatorId, assigneeIds[], assigneeId }，或由 scope.js 创建的当前用户作用域。
// recentSince 启用后，保留所有仍需处理的事项，仅带回近期已结束事项。
// 这样登录工作台不会被多年以前的完成/取消任务拖慢；历史页仍使用默认全量口径。
function whereForList(scope, recentSince = null) {
  const conds = [];
  const args = [];
  if (scope.all) {
    // 管理员不附加业务范围条件。
  } else if (scope.accessUserId && scope.accessRole === 'supervisor') {
    conds.push(`creator_id=? AND (
      assignee_id=? OR EXISTS (
        SELECT 1 FROM supervision_relations r
        WHERE r.supervisor_id=tasks.creator_id AND r.supervisee_id=tasks.assignee_id AND r.status='active' AND EXISTS(SELECT 1 FROM supervision_periods h WHERE h.id=tasks.cooperation_period_id AND h.ended_at IS NULL)
      )
    )`);
    args.push(scope.accessUserId, scope.accessUserId);
  } else if (scope.accessUserId && scope.accessRole === 'supervisee') {
    conds.push(`assignee_id=? AND (
      creator_id=? OR EXISTS (
        SELECT 1 FROM supervision_relations r
        WHERE r.supervisor_id=tasks.creator_id AND r.supervisee_id=tasks.assignee_id AND r.status='active' AND EXISTS(SELECT 1 FROM supervision_periods h WHERE h.id=tasks.cooperation_period_id AND h.ended_at IS NULL)
      )
    )`);
    args.push(scope.accessUserId, scope.accessUserId);
  } else {
    if (scope.assigneeId) { conds.push('assignee_id=?'); args.push(scope.assigneeId); }
    if (scope.creatorId) { conds.push('creator_id=?'); args.push(scope.creatorId); }
  }
  if (!scope.accessUserId && scope.assigneeIds?.length) {
    conds.push('assignee_id IN (' + scope.assigneeIds.map(() => '?').join(',') + ')');
    args.push(...scope.assigneeIds);
  }
  const filters = [];
  if (conds.length) filters.push('(' + conds.join(') OR (') + ')');
  if (Number.isFinite(recentSince)) {
    filters.push("(status IN ('pending','submitted') OR COALESCE(done_at, due_at, created_at) >= ?)");
    args.push(recentSince);
  }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  return { where, args };
}
function list(db, scope, limit = 200, offset = 0, { recentSince = null } = {}) {
  // The API reads one extra row to detect a following page at its 500-row cap.
  const safeLimit = Math.min(501, Math.max(1, Number.parseInt(limit, 10) || 200));
  const safeOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(offset, 10) || 0));
  const { where, args } = whereForList(scope, recentSince);
  return db.prepare('SELECT * FROM tasks ' + where + ' ORDER BY COALESCE(due_at, created_at) ASC, id ASC LIMIT ? OFFSET ?').all(...args, safeLimit, safeOffset);
}
function overview(db, scope, { now, todayStart, tomorrow }) {
  const { where, args } = whereForList(scope);
  const filtered = where ? where + ' AND ' : 'WHERE ';
  const stats = db.prepare(`SELECT COUNT(*) total,
    COALESCE(SUM(status='pending'),0) pending, COALESCE(SUM(status='done'),0) done,
    COALESCE(SUM(status='pending' AND due_at IS NOT NULL AND due_at<?),0) overdue,
    COALESCE(SUM(due_at IS NOT NULL AND due_at>=? AND due_at<?),0) today
    FROM tasks ${where}`).get(now, todayStart, tomorrow, ...args);
  // Bound the detail lists independently; their limits must never cap totals.
  const todayTasks = db.prepare(`SELECT * FROM tasks ${filtered}due_at>=? AND due_at<? ORDER BY due_at,id LIMIT 200`).all(...args,todayStart,tomorrow);
  const overdue = db.prepare(`SELECT * FROM tasks ${filtered}status='pending' AND due_at<? ORDER BY due_at,id LIMIT 20`).all(...args,now);
  const upcoming = db.prepare(`SELECT * FROM tasks ${filtered}status='pending' AND due_at IS NOT NULL ORDER BY due_at,id LIMIT 8`).all(...args);
  return { stats, todayTasks, overdue, upcoming };
}
function insert(db, data) {
  const id = crypto.randomUUID();
  const parentId = data.parentId || data.planId;
  const parent = parentId ? db.prepare('SELECT cooperation_period_id FROM plans WHERE id=?').get(parentId) : null;
  const periodId = parent?.cooperation_period_id || db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(data.creatorId,data.assigneeId)?.id || null;
  db.prepare(
    'INSERT INTO tasks(id, plan_id, title, note, creator_id, assignee_id, due_at, remind_before_minutes, status, created_at, cooperation_period_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id, data.planId, data.title, data.note, data.creatorId, data.assigneeId,
    data.dueAt, data.remindBeforeMinutes, data.status, data.createdAt, periodId
  );
  return byId(db, id);
}
function update(db, id, fields) {
  const current = byId(db, id);
  if (!current) return null;
  const scheduleChanged = current.assignee_id !== fields.assigneeId
    || current.due_at !== fields.dueAt
    || current.remind_before_minutes !== fields.remindBeforeMinutes;
  const sql = scheduleChanged
    ? 'UPDATE tasks SET title=?, note=?, assignee_id=?, due_at=?, remind_before_minutes=?, remind_fired_at=NULL, overdue_fired_at=NULL, overdue_escalated_at=NULL WHERE id=?'
    : 'UPDATE tasks SET title=?, note=?, assignee_id=?, due_at=?, remind_before_minutes=? WHERE id=?';
  db.prepare(sql).run(fields.title, fields.note, fields.assigneeId, fields.dueAt, fields.remindBeforeMinutes, id);
  if(current.assignee_id!==fields.assigneeId) {
    const period=db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(current.creator_id,fields.assigneeId);
    db.prepare('UPDATE tasks SET cooperation_period_id=? WHERE id=?').run(period?.id||null,id);
  }
  return byId(db, id);
}
function setStatus(db, id, status, doneAt, checkinNote) {
  db.prepare("UPDATE tasks SET status=?, done_at=?, checkin_note=? WHERE id=?").run(status, doneAt, checkinNote || '', id);
  return byId(db, id);
}
function remove(db, id) {
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
}
function setRemindFired(db, id, ts) {
  return db.prepare("UPDATE tasks SET remind_fired_at=? WHERE id=? AND status='pending' AND remind_fired_at IS NULL").run(ts, id).changes > 0;
}
function setOverdueFired(db, id, ts) {
  return db.prepare("UPDATE tasks SET overdue_fired_at=? WHERE id=? AND status='pending' AND overdue_fired_at IS NULL").run(ts, id).changes > 0;
}
function setOverdueEscalated(db, id, ts, intervalMs) {
  return db.prepare("UPDATE tasks SET overdue_escalated_at=? WHERE id=? AND status='pending' AND overdue_fired_at IS NOT NULL AND (overdue_escalated_at IS NULL OR overdue_escalated_at<=?)")
    .run(ts, id, ts - intervalMs).changes > 0;
}
// Personal work resumes when its account is enabled again. Shared work must
// still belong to this pair's current cooperation period, even after rebinding.
// Filter here, before LIMIT, so invalid records cannot starve active reminders.
const REMINDER_ELIGIBILITY = `status='pending' AND due_at IS NOT NULL
  AND (plan_id IS NULL OR EXISTS (SELECT 1 FROM plans p WHERE p.id=tasks.plan_id AND p.status='active'
    AND (p.parent_id IS NULL OR EXISTS (SELECT 1 FROM plans parent WHERE parent.id=p.parent_id AND parent.status='active'))))
  AND EXISTS (SELECT 1 FROM users creator JOIN users assignee ON assignee.id=tasks.assignee_id
    WHERE creator.id=tasks.creator_id AND creator.status=1 AND assignee.status=1
    AND (tasks.creator_id=tasks.assignee_id OR (creator.role='supervisor' AND assignee.role='supervisee'
      AND EXISTS (SELECT 1 FROM supervision_periods h JOIN supervision_relations r
        ON r.supervisor_id=h.supervisor_id AND r.supervisee_id=h.supervisee_id
        WHERE h.id=tasks.cooperation_period_id AND h.supervisor_id=tasks.creator_id
          AND h.supervisee_id=tasks.assignee_id AND h.ended_at IS NULL AND r.status='active'))))`;
function reminderById(db, id) {
  return db.prepare(`SELECT * FROM tasks WHERE id=? AND ${REMINDER_ELIGIBILITY}`).get(id);
}
// 到点未完成且未提醒过的任务
function listDueUnreminded(db, now = Date.now(), limit) {
  const sql = `SELECT * FROM tasks WHERE ${REMINDER_ELIGIBILITY} AND remind_fired_at IS NULL AND due_at - (COALESCE(remind_before_minutes, 30) * 60000) <= ? ORDER BY due_at ASC, id ASC`;
  return Number.isInteger(limit) && limit > 0
    ? db.prepare(sql + ' LIMIT ?').all(now, limit)
    : db.prepare(sql).all(now);
}
// 已超时且未提醒过的任务
function listDueOverdue(db, now, limit) {
  const sql = `SELECT * FROM tasks WHERE ${REMINDER_ELIGIBILITY} AND due_at < ? AND overdue_fired_at IS NULL ORDER BY due_at ASC, id ASC`;
  return Number.isInteger(limit) && limit > 0
    ? db.prepare(sql + ' LIMIT ?').all(now, limit)
    : db.prepare(sql).all(now);
}
// 首次超时提醒发出至少一个周期后，仍未完成才允许再次催办。
function listDueOverdueEscalation(db, now = Date.now(), intervalMs = 86400000, limit) {
  const sql = `SELECT * FROM tasks WHERE ${REMINDER_ELIGIBILITY} AND overdue_fired_at IS NOT NULL AND overdue_fired_at<=? AND (overdue_escalated_at IS NULL OR overdue_escalated_at<=?) ORDER BY overdue_fired_at ASC, due_at ASC, id ASC`;
  const args = [now - intervalMs, now - intervalMs];
  return Number.isInteger(limit) && limit > 0
    ? db.prepare(sql + ' LIMIT ?').all(...args, limit)
    : db.prepare(sql).all(...args);
}
function removeRelatedNotes(db, taskId) {
  db.prepare("DELETE FROM notifications WHERE link_type='task' AND link_id=?").run(taskId);
}
// 排行用：一次取一批被监督者的任务关键列（assignee_id/plan/status/done_at/due_at）
function minimalByAssignees(db, ids) {
  if (!ids || !ids.length) return [];
  return db.prepare(
    'SELECT assignee_id, plan_id, status, done_at, due_at, created_at FROM tasks WHERE assignee_id IN (' +
    ids.map(() => '?').join(',') + ')'
  ).all(...ids);
}

module.exports = {
  toTask, byId, list, overview, insert, update, setStatus, remove,
  setRemindFired, setOverdueFired, setOverdueEscalated, reminderById, listDueUnreminded, listDueOverdue, listDueOverdueEscalation, removeRelatedNotes,
  minimalByAssignees,
};

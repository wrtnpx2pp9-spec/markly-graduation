'use strict';
/** 监督计划数据访问。 */
const crypto = require('crypto');
const { dayReminderAt } = require('../reminder-time');

function toPlan(p, review = null, stageReview = null, coverage = null) {
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    creatorId: p.creator_id,
    assigneeId: p.assignee_id,
    parentId: p.parent_id,
    cooperationPeriodId: p.cooperation_period_id || null,
    serviceRequestId: p.service_request_id || null,
    kind: p.kind || 'task',
    planningMode: p.planning_mode || 'fixed',
    startAt: p.start_at,
    dueAt: p.due_at,
    calendarStart: p.start_at == null ? null : calendarDate(p.start_at),
    calendarEnd: p.due_at == null ? null : calendarDate(p.due_at),
    // Original proposal dates remain immutable. Coverage includes accepted renewals.
    coverageStart: coverage?.startAt == null ? null : calendarDate(coverage.startAt),
    coverageEnd: coverage?.dueAt == null ? null : calendarDate(coverage.dueAt),
    calendarTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    remindBeforeMinutes: p.remind_before_minutes,
    status: p.status,
    agreementNote: p.agreement_note || '',
    review,
    stageReview,
    createdAt: p.created_at,
  };
}
function calendarDate(value){const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}

function byId(db, id) {
  return db.prepare('SELECT * FROM plans WHERE id=?').get(id);
}
// scope: { creatorId, assigneeIds[], assigneeId }，或由 scope.js 创建的当前用户作用域。
// recentSince 启用后，持续显示进行中和待协商计划，只显示近期归档计划。
// 历史记录由合作历史页面按需读取，不随登录首屏下载。
function list(db, scope, limit = 200, offset = 0, { recentSince = null } = {}) {
  // The API reads one extra row to detect a following page at its 500-row cap.
  const safeLimit = Math.min(501, Math.max(1, Number.parseInt(limit, 10) || 200));
  const safeOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(offset, 10) || 0));
  const conds = [];
  const args = [];
  if (scope.all) {
    // 管理员不附加业务范围条件。
  } else if (scope.accessUserId && scope.accessRole === 'supervisor') {
    conds.push(`creator_id=? AND (
      assignee_id=? OR EXISTS (
        SELECT 1 FROM supervision_relations r
        WHERE r.supervisor_id=plans.creator_id AND r.supervisee_id=plans.assignee_id AND r.status='active' AND EXISTS(SELECT 1 FROM supervision_periods h WHERE h.id=plans.cooperation_period_id AND h.ended_at IS NULL)
      ) OR (plans.status IN ('proposed','declined') AND plans.service_request_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM service_requests sr
        WHERE sr.id=plans.service_request_id AND sr.supervisor_id=plans.creator_id AND sr.supervisee_id=plans.assignee_id
      )
      )
    )`);
    args.push(scope.accessUserId, scope.accessUserId);
  } else if (scope.accessUserId && scope.accessRole === 'supervisee') {
    conds.push(`assignee_id=? AND (
      creator_id=? OR EXISTS (
        SELECT 1 FROM supervision_relations r
        WHERE r.supervisor_id=plans.creator_id AND r.supervisee_id=plans.assignee_id AND r.status='active' AND EXISTS(SELECT 1 FROM supervision_periods h WHERE h.id=plans.cooperation_period_id AND h.ended_at IS NULL)
      ) OR (plans.status IN ('proposed','declined') AND plans.service_request_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM service_requests sr
        WHERE sr.id=plans.service_request_id AND sr.supervisor_id=plans.creator_id AND sr.supervisee_id=plans.assignee_id
      )
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
    filters.push("(status IN ('active','proposed','declined') OR COALESCE(due_at, created_at) >= ?)");
    args.push(recentSince);
  }
  const where = filters.length ? 'WHERE ' + filters.join(' AND ') : '';
  return db.prepare('SELECT * FROM plans ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(...args, safeLimit, safeOffset);
}
function insert(db, data) {
  const id = crypto.randomUUID();
  const parentId = data.parentId || data.planId;
  const parent = parentId ? db.prepare('SELECT cooperation_period_id,planning_mode FROM plans WHERE id=?').get(parentId) : null;
  const periodId = parent?.cooperation_period_id || db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(data.creatorId,data.assigneeId)?.id || null;
  db.prepare(
    'INSERT INTO plans(id, title, description, creator_id, assignee_id, parent_id, kind, start_at, due_at, remind_before_minutes, remind_hour, status, service_request_id, created_at, cooperation_period_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id, data.title, data.description, data.creatorId, data.assigneeId, data.parentId || null,
    data.kind || 'task', data.startAt, data.dueAt, data.remindBeforeMinutes ?? 30,
    data.remindHour !== undefined ? data.remindHour : 20, data.status, data.serviceRequestId || null, data.createdAt, periodId
  );
  db.prepare('UPDATE plans SET planning_mode=? WHERE id=?').run(data.planningMode || parent?.planning_mode || 'fixed',id);
  return byId(db, id);
}
function update(db, id, fields) {
  db.prepare(
    'UPDATE plans SET title=?, description=?, assignee_id=?, start_at=?, due_at=?, remind_before_minutes=?, status=? WHERE id=?'
  ).run(
    fields.title, fields.description, fields.assigneeId, fields.startAt, fields.dueAt,
    fields.remindBeforeMinutes, fields.status, id
  );
  return byId(db, id);
}
function archive(db, id) {
  db.exec('SAVEPOINT archive_plan');
  try {
    const tree = db.prepare('WITH RECURSIVE tree(id) AS (SELECT id FROM plans WHERE id=? UNION SELECT p.id FROM plans p JOIN tree t ON p.parent_id=t.id) SELECT id FROM tree').all(id).map(p=>p.id);
    if (tree.length) {
      const marks = tree.map(()=>'?').join(',');
      db.prepare(`UPDATE tasks SET status='cancelled' WHERE plan_id IN (${marks}) AND status IN ('pending','submitted')`).run(...tree);
      db.prepare(`UPDATE plans SET status='archived' WHERE id IN (${marks})`).run(...tree);
      db.prepare(`UPDATE daily_plan_proposals SET status='closed',version=version+1,updated_at=? WHERE plan_id IN (${marks}) AND status IN ('draft','submitted')`).run(Date.now(),...tree);
      db.prepare(`UPDATE service_requests SET status='planning',plan_id=NULL,updated_at=? WHERE status='plan_proposed' AND plan_id IN (${marks})`).run(Date.now(),...tree);
    }
    db.exec('RELEASE archive_plan');
    return byId(db, id);
  } catch (error) {
    db.exec('ROLLBACK TO archive_plan'); db.exec('RELEASE archive_plan'); throw error;
  }
}
function repairArchivedWorkflows(db) {
  db.exec('SAVEPOINT repair_archived_workflows');
  try {
    db.prepare("UPDATE tasks SET status='cancelled' WHERE status IN ('pending','submitted') AND EXISTS (SELECT 1 FROM plans p WHERE p.id=tasks.plan_id AND p.status='archived')").run();
    db.prepare("UPDATE daily_plan_proposals SET status='closed',version=version+1,updated_at=? WHERE status IN ('draft','submitted') AND EXISTS (SELECT 1 FROM plans p WHERE p.id=daily_plan_proposals.plan_id AND p.status='archived')").run(Date.now());
    db.prepare("UPDATE service_requests SET status='planning',plan_id=NULL,updated_at=? WHERE status='plan_proposed' AND EXISTS (SELECT 1 FROM plans p WHERE p.id=service_requests.plan_id AND p.status='archived')").run(Date.now());
    db.exec('RELEASE repair_archived_workflows');
  } catch(error) { db.exec('ROLLBACK TO repair_archived_workflows');db.exec('RELEASE repair_archived_workflows');throw error; }
}
function coverage(db, p) {
  if (p.kind !== 'phase') return null;
  const row = db.prepare("SELECT MIN(start_at) startAt,MAX(due_at) dueAt FROM plans WHERE parent_id=? AND kind='cycle' AND status='active'").get(p.id);
  return row.startAt == null ? null : row;
}
function coverageByParentIds(db, parentIds) {
  const result = new Map();
  if (!parentIds?.length) return result;
  const rows = db.prepare('SELECT parent_id,MIN(start_at) AS startAt,MAX(due_at) AS dueAt FROM plans WHERE parent_id IN (' + parentIds.map(() => '?').join(',') + ") AND kind='cycle' AND status='active' GROUP BY parent_id").all(...parentIds);
  rows.forEach(row => result.set(row.parent_id, { startAt: row.startAt, dueAt: row.dueAt }));
  return result;
}
// 排行用：进行中的计划 id 集合
function activePlanIds(db) {
  return db.prepare("SELECT id FROM plans WHERE status='active'").all().map((r) => r.id);
}

// ================= 每天打卡（plan_days） =================
function listDays(db, planId) {
  return db.prepare('SELECT * FROM plan_days WHERE plan_id=? ORDER BY seq ASC').all(planId);
}
function dayItems(db, planId) {
  const grouped = new Map();
  const rows = db.prepare('SELECT * FROM plan_day_items WHERE plan_id=? AND removed_at IS NULL ORDER BY day_id ASC, seq ASC').all(planId);
  rows.forEach((row) => {
    if (!grouped.has(row.day_id)) grouped.set(row.day_id, []);
    grouped.get(row.day_id).push(toDayItem(row));
  });
  return grouped;
}
function dayComments(db, planId) {
  const rows = db.prepare('SELECT * FROM plan_day_comments WHERE plan_id=? ORDER BY created_at ASC').all(planId);
  const grouped = new Map();
  rows.forEach((row) => {
    if (!grouped.has(row.day_id)) grouped.set(row.day_id, []);
    grouped.get(row.day_id).push({ id: row.id, authorId: row.author_id, authorRole: row.author_role, content: row.content, mood: row.mood, createdAt: row.created_at });
  });
  return grouped;
}
function addDayComment(db, data) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO plan_day_comments(id,day_id,plan_id,author_id,author_role,content,mood,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, data.dayId, data.planId, data.authorId, data.authorRole, data.content || '', data.mood || '', data.createdAt);
  return db.prepare('SELECT * FROM plan_day_comments WHERE id=?').get(id);
}
function dayById(db, id) {
  return db.prepare('SELECT * FROM plan_days WHERE id=?').get(id);
}
function insertDays(db, planId, list) {
  const ins = db.prepare('INSERT INTO plan_days(id, plan_id, seq, day_date, content, status, created_at) VALUES (?,?,?,?,?,?,?)');
  const itemIns = db.prepare('INSERT INTO plan_day_items(id, day_id, plan_id, seq, title, status, created_at) VALUES (?,?,?,?,?,?,?)');
  const scheduleUpdate = db.prepare('UPDATE plan_days SET schedule_json=? WHERE id=?');
  for (const d of list) {
    ins.run(d.id, planId, d.seq, d.day_date, d.content, 'pending', d.createdAt);
    if (d.schedule) scheduleUpdate.run(JSON.stringify(d.schedule),d.id);
    (d.items || []).forEach((item, index) => itemIns.run(crypto.randomUUID(), d.id, planId, index + 1, item, 'pending', d.createdAt));
  }
}
function dayItemById(db, id) {
  return db.prepare('SELECT * FROM plan_day_items WHERE id=?').get(id);
}
function setDayItemStatus(db, id, status) {
  db.prepare('UPDATE plan_day_items SET status=?, done_at=? WHERE id=?').run(status, status === 'done' ? Date.now() : null, id);
  return dayItemById(db, id);
}
function incompleteDayItemCount(db, dayId) {
  return db.prepare("SELECT COUNT(*) AS count FROM plan_day_items WHERE day_id=? AND removed_at IS NULL AND status!='done'").get(dayId).count;
}
function dayItemCount(db, dayId) {
  return db.prepare('SELECT COUNT(*) AS count FROM plan_day_items WHERE day_id=? AND removed_at IS NULL').get(dayId).count;
}
function completeDayItems(db, dayId) {
  db.prepare("UPDATE plan_day_items SET status='done', done_at=? WHERE day_id=? AND removed_at IS NULL AND status='pending'").run(Date.now(), dayId);
}
function setDayStatus(db, id, status, doneAt, note) {
  db.prepare(`UPDATE plan_days SET status=?, done_at=?, note=?, checkin_state=?, checkin_submitted_at=?,
    checkin_reviewed_at=NULL, checkin_reviewer_id=NULL, checkin_review_note='' WHERE id=?`)
    .run(status, doneAt, note || '', status === 'done' ? 'submitted' : 'withdrawn', status === 'done' ? Date.now() : null, id);
  return dayById(db, id);
}
function submitDay(db, id, note, mood = '') {
  db.prepare(`UPDATE plan_days SET status='done', done_at=?, note=?, checkin_state='submitted',
    checkin_submitted_at=?, checkin_reviewed_at=NULL, checkin_reviewer_id=NULL, checkin_review_note='' WHERE id=?`)
    .run(Date.now(), note || '', Date.now(), id);
  db.prepare('UPDATE plan_days SET mood=? WHERE id=?').run(mood || '', id);
  return dayById(db, id);
}
function reviewDay(db, id, reviewerId, state, reviewNote) {
  db.prepare(`UPDATE plan_days SET status=?, checkin_state=?, checkin_reviewed_at=?, checkin_reviewer_id=?, checkin_review_note=? WHERE id=?`)
    .run(state === 'approved' ? 'done' : 'pending', state, Date.now(), reviewerId, reviewNote || '', id);
  return dayById(db, id);
}
function withdrawDay(db, id) {
  db.prepare(`UPDATE plan_days SET status='pending', done_at=NULL, checkin_state='withdrawn',
    checkin_reviewed_at=NULL, checkin_reviewer_id=NULL, checkin_review_note='' WHERE id=?`).run(id);
  return dayById(db, id);
}
function toDayItem(item) {
  return { id: item.id, dayId: item.day_id, planId: item.plan_id, seq: item.seq, title: item.title, status: item.status, doneAt: item.done_at, createdAt: item.created_at };
}
function toDay(d, comments = [], items = []) {
  return {
    id: d.id, planId: d.plan_id, seq: d.seq, dayDate: d.day_date,
    schedule: d.schedule_json ? JSON.parse(d.schedule_json) : null,
    content: d.content, status: d.status, doneAt: d.done_at, note: d.note, mood: d.mood || '', createdAt: d.created_at,
    checkinState: d.checkin_state || (d.status === 'done' ? 'approved' : 'unsubmitted'),
    checkinSubmittedAt: d.checkin_submitted_at, checkinReviewedAt: d.checkin_reviewed_at,
    checkinReviewerId: d.checkin_reviewer_id, checkinReviewNote: d.checkin_review_note || '',
    comments, items,
    helpNote: d.help_note || '', helpReply: d.help_reply || '',
  };
}

// ================= 常用内容模板 =================
function listTemplates(db, ownerId) {
  return db.prepare('SELECT * FROM plan_templates WHERE owner_id=? ORDER BY created_at DESC').all(ownerId);
}
function insertTemplate(db, ownerId, title, content) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO plan_templates(id, owner_id, title, content, created_at) VALUES (?,?,?,?,?)')
    .run(id, ownerId, title, content, Date.now());
  return db.prepare('SELECT * FROM plan_templates WHERE id=?').get(id);
}
function deleteTemplate(db, id, ownerId) {
  return db.prepare('DELETE FROM plan_templates WHERE id=? AND owner_id=?').run(id, ownerId).changes > 0;
}

// ================= 到点提醒扫描 =================
const DAY_REMINDER_ELIGIBILITY = `pd.status='pending' AND pd.checkin_state NOT IN ('submitted','approved','cancelled')
  AND p.status='active' AND p.kind='cycle'
  AND (p.parent_id IS NULL OR EXISTS (SELECT 1 FROM plans parent WHERE parent.id=p.parent_id AND parent.status='active'))
  AND EXISTS (SELECT 1 FROM users creator JOIN users assignee ON assignee.id=p.assignee_id
    WHERE creator.id=p.creator_id AND creator.status=1 AND assignee.status=1
    AND (p.creator_id=p.assignee_id OR (creator.role='supervisor' AND assignee.role='supervisee'
      AND EXISTS (SELECT 1 FROM supervision_periods h JOIN supervision_relations r
        ON r.supervisor_id=h.supervisor_id AND r.supervisee_id=h.supervisee_id
        WHERE h.id=p.cooperation_period_id AND h.supervisor_id=p.creator_id
          AND h.supervisee_id=p.assignee_id AND h.ended_at IS NULL AND r.status='active'))))`;
const DAY_REMINDER_SELECT = `SELECT pd.id AS day_id, pd.seq, pd.content, pd.day_date, pd.remind_fired_at, pd.overdue_fired_at,
    p.id AS plan_id, p.title AS plan_title, p.creator_id, p.assignee_id, p.remind_hour, p.cooperation_period_id
    FROM plan_days pd JOIN plans p ON p.id=pd.plan_id`;
function reminderDayById(db, id) {
  return db.prepare(`${DAY_REMINDER_SELECT} WHERE pd.id=? AND ${DAY_REMINDER_ELIGIBILITY}`).get(id);
}
function listPendingCycleDays(db, fromDay, toDay, limit, { now, dayStart } = {}) {
  const args = [fromDay, toDay];
  let eligibility = '';
  if (Number.isFinite(now) && Number.isFinite(dayStart)) {
    // Filter before LIMIT so already-fired and not-yet-due rows cannot hold
    // every later reminder behind the same first batch of pending days.
    const dueHours = Array.from({ length: 24 }, (_, hour) => hour).filter(hour => dayReminderAt(now, hour) <= now);
    eligibility = ` AND ((pd.day_date=? AND pd.overdue_fired_at IS NULL)
      OR (pd.day_date=? AND pd.remind_fired_at IS NULL AND COALESCE(p.remind_hour,20) IN (${dueHours.map(() => '?').join(',') || 'NULL'})))`;
    args.push(fromDay, toDay, ...dueHours);
  }
  const sql =
    `${DAY_REMINDER_SELECT}
     WHERE ${DAY_REMINDER_ELIGIBILITY} AND pd.day_date BETWEEN ? AND ?${eligibility}
     ORDER BY pd.day_date ASC, pd.seq ASC, pd.id ASC`;
  return Number.isInteger(limit) && limit > 0
    ? db.prepare(sql + ' LIMIT ?').all(...args, limit)
    : db.prepare(sql).all(...args);
}
function markDayRemindFired(db, id, ts) {
  return db.prepare("UPDATE plan_days SET remind_fired_at=? WHERE id=? AND status='pending' AND remind_fired_at IS NULL").run(ts, id).changes > 0;
}
function markDayOverdueFired(db, id, ts) {
  return db.prepare("UPDATE plan_days SET overdue_fired_at=? WHERE id=? AND status='pending' AND overdue_fired_at IS NULL").run(ts, id).changes > 0;
}

module.exports = { toPlan, coverage, coverageByParentIds, repairArchivedWorkflows, byId, list, insert, update, archive, activePlanIds, listDays, dayItems, dayComments, addDayComment, dayById, insertDays, dayItemById, setDayItemStatus, incompleteDayItemCount, dayItemCount, completeDayItems, setDayStatus, submitDay, reviewDay, withdrawDay, toDayItem, toDay, listTemplates, insertTemplate, deleteTemplate, reminderDayById, listPendingCycleDays, markDayRemindFired, markDayOverdueFired };

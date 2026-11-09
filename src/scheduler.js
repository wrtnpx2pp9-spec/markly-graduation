'use strict';
/**
 * 定时提醒调度器：周期性扫描“到点未完成”的任务 + 阶段性打卡计划的每日提醒/漏卡。
 * 依赖于 task.repo / plan.repo / notify，不直接写业务 SQL。
 */
const taskRepo = require('./repo/task.repo');
const planRepo = require('./repo/plan.repo');
const notify = require('./notify');
const sessionRepo = require('./repo/session.repo');
const crypto = require('crypto');
const { taskMessages, dayMessages } = require('./reminder-messages');
const { dayReminderAt } = require('./reminder-time');
let lastSessionPurgeAt = 0;
let lastAuditPurgeAt = 0;
const OVERDUE_ESCALATION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 100;

function batchSize(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000 ? n : DEFAULT_BATCH_SIZE;
}

function acquireLease(db, name, owner, now, ttlMs) {
  return db.prepare(
    "INSERT INTO scheduler_leases(name, owner, locked_until) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, locked_until=excluded.locked_until WHERE scheduler_leases.locked_until<? OR scheduler_leases.owner=?"
  ).run(name, owner, now + ttlMs, now, owner).changes > 0;
}

function pad(n) { return String(n).padStart(2, '0'); }
function dayStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function dayStartMs(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

function fire(db, options = {}) {
  const now = Date.now();
  const limit = batchSize(options.batchSize ?? process.env.SCHEDULER_BATCH_SIZE);
  const stats = { reminds: 0, overdue: 0, overdueEscalations: 0 };

  const reminds = taskRepo.listDueUnreminded(db, now, limit);
  stats.reminds = markAndDeliverBatch(db, reminds, (t, recipients, deliveryContext) => {
    const remindAt = (t.due_at || 0) - (t.remind_before_minutes ?? 30) * 60000;
    if (remindAt > now || !taskRepo.setRemindFired(db, t.id, now)) return false;
    deliverToPair(db, t, taskMessages(t, 'remind'), recipients, deliveryContext);
    return true;
  });

  const overdues = taskRepo.listDueOverdue(db, now, limit);
  stats.overdue = markAndDeliverBatch(db, overdues, (t, recipients, deliveryContext) => {
    if (!taskRepo.setOverdueFired(db, t.id, now)) return false;
    deliverToPair(db, t, taskMessages(t, 'overdue'), recipients, deliveryContext);
    return true;
  });

  const escalations = taskRepo.listDueOverdueEscalation(db, now, OVERDUE_ESCALATION_INTERVAL_MS, limit);
  stats.overdueEscalations = markAndDeliverBatch(db, escalations, (t, recipients, deliveryContext) => {
    if (!taskRepo.setOverdueEscalated(db, t.id, now, OVERDUE_ESCALATION_INTERVAL_MS)) return false;
    deliverToPair(db, t, taskMessages(t, 'followup'), recipients, deliveryContext);
    return true;
  });

  return stats;
}

// 阶段性打卡计划：到点提醒“今天该打卡”/跨天后“漏卡”
function scanPhaseDays(db, now = Date.now(), options = {}) {
  const limit = batchSize(options.batchSize ?? process.env.SCHEDULER_BATCH_SIZE);
  const start = dayStartMs(now);
  const today = dayStr(new Date(start));
  const yesterday = new Date(start);
  yesterday.setDate(yesterday.getDate() - 1);
  const yst = dayStr(yesterday);
  const rows = planRepo.listPendingCycleDays(db, yst, today, limit, { now, dayStart: start });
  const stats = { planReminds: 0, planMissed: 0 };
  markAndDeliverBatch(db, rows, (r, recipients, deliveryContext) => {
    const isToday = r.day_date === today;
    if (isToday) {
      const remindHour = r.remind_hour == null ? 20 : r.remind_hour;
      const remindAt = dayReminderAt(now, remindHour);
      if (!r.remind_fired_at && now >= remindAt) {
        if (!planRepo.markDayRemindFired(db, r.day_id, now)) return false;
        deliverDayPair(db, r, dayMessages(r, 'remind'), recipients, deliveryContext);
        stats.planReminds++;
        return true;
      }
    } else if (r.day_date === yst && !r.overdue_fired_at && now >= start) {
      if (!planRepo.markDayOverdueFired(db, r.day_id, now)) return false;
      deliverDayPair(db, r, dayMessages(r, 'miss'), recipients, deliveryContext);
      stats.planMissed++;
      return true;
    }
    return false;
  });
  return stats;
}

// Marking and notification/outbox writes are committed as one bounded batch.
// A failed row rolls the complete batch back, so none of its reminders is
// marked without a matching durable notification; the next scan retries it.
function markAndDeliverBatch(db, rows, deliver) {
  if (!rows.length) return 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const recipients = loadRecipients(db, rows);
    const deliveryContext = notify.createDeliveryContext(db);
    let count = 0;
    for (const row of rows) if (deliver(row, recipients, deliveryContext)) count++;
    db.exec('COMMIT');
    return count;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function loadRecipients(db, rows) {
  const ids = [...new Set(rows.flatMap(row => [row.assignee_id, row.creator_id]).filter(Boolean))];
  if (!ids.length) return new Map();
  const people = db.prepare(
    'SELECT id, username, role, display_name FROM users WHERE id IN (' + ids.map(() => '?').join(',') + ')'
  ).all(...ids);
  return new Map(people.map(person => [person.id, person]));
}

function deliverDayPair(db, day, messages, recipients, deliveryContext) {
  const assignee = recipients.get(day.assignee_id);
  const creator = recipients.get(day.creator_id);
  if (assignee) {
    notify.deliver(db, {
      userId: assignee.id, kind: messages.assigneeKind, title: messages.assigneeTitle,
      content: messages.assigneeContent, linkType: 'day', linkId: day.day_id, recipientUser: assignee,
    }, deliveryContext);
  }
  if (creator && (!assignee || creator.id !== assignee.id)) {
    notify.deliver(db, {
      userId: creator.id, kind: messages.creatorKind, title: messages.creatorTitle,
      content: messages.creatorContent, linkType: 'day', linkId: day.day_id, recipientUser: creator,
    }, deliveryContext);
  }
}

function deliverToPair(db, task, messages, recipients, deliveryContext) {
  const assignee = recipients.get(task.assignee_id);
  const creator = recipients.get(task.creator_id);
  if (assignee) {
    notify.deliver(db, {
      userId: assignee.id, kind: messages.assigneeKind, title: messages.assigneeTitle,
      content: messages.assigneeContent, linkType: 'task', linkId: task.id, recipientUser: assignee,
    }, deliveryContext);
  }
  if (creator && (!assignee || creator.id !== assignee.id)) {
    notify.deliver(db, {
      userId: creator.id, kind: messages.creatorKind, title: messages.creatorTitle,
      content: messages.creatorContent, linkType: 'task', linkId: task.id, recipientUser: creator,
    }, deliveryContext);
  }
}

function start(db, intervalMs = 10000) {
  const owner = crypto.randomUUID();
  const timer = setInterval(() => {
    try {
      const now = Date.now();
      if (!acquireLease(db, 'main', owner, now, Math.max(30000, intervalMs * 3))) return;
      if (now - lastSessionPurgeAt >= 3600000) {
        sessionRepo.purgeExpired(db);
        lastSessionPurgeAt = now;
      }
      if (now - lastAuditPurgeAt >= 86400000) {
        db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(now - 180 * 86400000);
        lastAuditPurgeAt = now;
      }
      const stats = fire(db);
      const ps = scanPhaseDays(db, Date.now());
      if (stats.reminds || stats.overdue || stats.overdueEscalations || ps.planReminds || ps.planMissed) {
        console.log('[scheduler] fired:', JSON.stringify({ ...stats, ...ps }), new Date().toISOString());
      }
    } catch (e) { console.error('[scheduler] error:', e.message); }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { start, fire, scanPhaseDays };

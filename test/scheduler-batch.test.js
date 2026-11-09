'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-scheduler-batch-'));
process.env.DB_PATH = path.join(dir, 'app.db');
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const scheduler = require('../src/scheduler');
const plans = require('../src/repo/plan.repo');

function phaseFixture(prefix) {
  const start = new Date(2026, 9, 5);
  const now = +start + 12 * 3600000;
  const yesterday = new Date(start); yesterday.setDate(yesterday.getDate() - 1);
  const calendar = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const userId = prefix + '-user';
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)')
    .run(userId, userId, 'supervisee', 'hash', 'salt', userId, now);
  function addDay(name, date, remindHour) {
    const plan = plans.insert(db, { title: name, description: '', creatorId: userId, assigneeId: userId, kind: 'cycle', startAt: +yesterday, dueAt: +start + 86399999, remindHour, status: 'active', createdAt: now });
    const id = prefix + '-' + name;
    plans.insertDays(db, plan.id, [{ id, seq: 1, day_date: calendar(date), content: name, items: [name], createdAt: now }]);
    return id;
  }
  return { start, yesterday, now, userId, addDay };
}

test('调度器的实际提醒时刻、逾期与催办扫描均有专用部分索引', () => {
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(row => row.name));
  for (const name of ['idx_tasks_remind_at', 'idx_tasks_overdue_at', 'idx_tasks_overdue_escalation']) assert.ok(indexes.has(name), name);
});

test('到期高峰按有界批次原子处理，后续扫描继续清空积压', () => {
  const now = Date.now();
  db.prepare("INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES ('batch-user','batch-user','supervisee','hash','salt','batch-user',1,?)").run(now);
  const insert = db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,due_at,remind_before_minutes,status,created_at) VALUES (?,?,?,?,?,0,'pending',?)");
  for (let i = 0; i < 5; i++) insert.run(`batch-${i}`, `任务 ${i}`, 'batch-user', 'batch-user', now - (5000 - i), now - 6000);

  assert.deepEqual(scheduler.fire(db, { batchSize: 2 }), { reminds: 2, overdue: 2, overdueEscalations: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE remind_fired_at IS NOT NULL').get().count, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE overdue_fired_at IS NOT NULL').get().count, 2);

  assert.deepEqual(scheduler.fire(db, { batchSize: 2 }), { reminds: 2, overdue: 2, overdueEscalations: 0 });
  assert.deepEqual(scheduler.fire(db, { batchSize: 2 }), { reminds: 1, overdue: 1, overdueEscalations: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE remind_fired_at IS NOT NULL AND overdue_fired_at IS NOT NULL').get().count, 5);

  db.prepare("INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES ('batch-owner','batch-owner','supervisor','hash','salt','监督者',1,?),('batch-assignee','batch-assignee','supervisee','hash','salt','执行人',1,?)").run(now, now);
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='test-agreement',capacity_override=1 WHERE id='batch-owner'").run();
  require('../src/repo/user.repo').setRelations(db, 'batch-assignee', ['batch-owner']);
  insert.run('batch-pair', '双人任务', 'batch-owner', 'batch-assignee', now - 1, now - 2);
  db.prepare("UPDATE tasks SET cooperation_period_id=(SELECT id FROM supervision_periods WHERE supervisor_id='batch-owner' AND supervisee_id='batch-assignee' AND ended_at IS NULL) WHERE id='batch-pair'").run();
  assert.deepEqual(scheduler.fire(db, { batchSize: 1 }), { reminds: 1, overdue: 1, overdueEscalations: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id='batch-owner'").get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id='batch-assignee'").get().count, 2);
});

test('阶段漏卡和当日提醒超过批次后继续清空，已发送记录不占后续批次', () => {
  const x = phaseFixture('phase-backlog');
  const missed = Array.from({ length: 5 }, (_, i) => x.addDay('yesterday-' + i, x.yesterday, 8));
  const reminders = Array.from({ length: 2 }, (_, i) => x.addDay('today-' + i, x.start, 8));
  assert.deepEqual(Array.from({ length: 5 }, () => scheduler.scanPhaseDays(db, x.now, { batchSize: 2 })), [
    { planReminds: 0, planMissed: 2 },
    { planReminds: 0, planMissed: 2 },
    { planReminds: 1, planMissed: 1 },
    { planReminds: 1, planMissed: 0 },
    { planReminds: 0, planMissed: 0 },
  ]);
  for (const id of missed) assert.equal(plans.dayById(db, id).overdue_fired_at, x.now);
  for (const id of reminders) assert.equal(plans.dayById(db, id).remind_fired_at, x.now);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?').get(x.userId).count, 7);
});

test('尚未到提醒时刻的阶段日期不占批次，并在到点后只提醒一次', () => {
  const x = phaseFixture('phase-hours');
  const later = Array.from({ length: 3 }, (_, i) => x.addDay('a-later-' + i, x.start, 23));
  const due = Array.from({ length: 3 }, (_, i) => x.addDay('z-due-' + i, x.start, 8));
  assert.deepEqual(scheduler.scanPhaseDays(db, x.now, { batchSize: 2 }), { planReminds: 2, planMissed: 0 });
  assert.deepEqual(scheduler.scanPhaseDays(db, x.now, { batchSize: 2 }), { planReminds: 1, planMissed: 0 });
  assert.deepEqual(scheduler.scanPhaseDays(db, x.now, { batchSize: 2 }), { planReminds: 0, planMissed: 0 });
  for (const id of due) assert.equal(plans.dayById(db, id).remind_fired_at, x.now);
  for (const id of later) assert.equal(plans.dayById(db, id).remind_fired_at, null);
  const at23 = +x.start + 23 * 3600000;
  assert.deepEqual(scheduler.scanPhaseDays(db, at23, { batchSize: 2 }), { planReminds: 2, planMissed: 0 });
  assert.deepEqual(scheduler.scanPhaseDays(db, at23, { batchSize: 2 }), { planReminds: 1, planMissed: 0 });
  assert.deepEqual(scheduler.scanPhaseDays(db, at23, { batchSize: 2 }), { planReminds: 0, planMissed: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id=?').get(x.userId).count, 6);
});

test.after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

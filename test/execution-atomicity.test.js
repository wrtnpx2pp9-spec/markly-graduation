'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const tasks = require('../src/repo/task.repo');
const plans = require('../src/repo/plan.repo');
const notes = require('../src/repo/note.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['task', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);

function actor(role = 'supervisee') {
  return users.insert(db, { username: `execution-atomic-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(user, method, url, body = {}) {
  current = user;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function failActivity(t, entityId) {
  db.exec(`CREATE TEMP TRIGGER fail_execution_activity BEFORE INSERT ON activity_events
    WHEN NEW.entity_id='${entityId}' BEGIN SELECT RAISE(ABORT,'activity write failed'); END`);
  const clear = () => db.exec('DROP TRIGGER IF EXISTS fail_execution_activity');
  t.after(clear);
  return clear;
}
function dailyExecution() {
  const supervisor = actor('supervisor'), supervisee = actor();
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-authorization',capacity_override=1 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const now = Date.now(), today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const base = { creatorId: supervisor.id, assigneeId: supervisee.id, description: '', startAt: +today, dueAt: +today + 86399999, status: 'active', createdAt: now };
  const parent = plans.insert(db, { ...base, title: 'Shared goal', kind: 'phase' });
  const cycle = plans.insert(db, { ...base, title: 'Shared stage', kind: 'cycle', parentId: parent.id });
  const dayId = crypto.randomUUID();
  plans.insertDays(db, cycle.id, [{ id: dayId, seq: 1, day_date: date, content: 'Practice and summarize', items: ['Practice', 'Summarize'], createdAt: now }]);
  const item = db.prepare('SELECT * FROM plan_day_items WHERE day_id=? ORDER BY seq').get(dayId);
  const url = `/api/plans/${cycle.id}/days/${dayId}/items/${item.id}/toggle`;
  return { supervisor, supervisee, cycle, dayId, item, url };
}

test('personal task completion rolls back its state when the activity write fails and can be retried', t => {
  const user = actor();
  const created = call(user, 'POST', '/api/tasks', { title: 'Personal execution' });
  assert.equal(created.status, 200);
  const before = { ...tasks.byId(db, created.task.id) };
  const clear = failActivity(t, created.task.id);
  assert.throws(() => call(user, 'POST', `/api/tasks/${created.task.id}/checkin`, { note: 'Completed work' }), /activity write failed/);
  assert.deepEqual({ ...tasks.byId(db, created.task.id) }, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(created.task.id).n, 0);
  clear();
  const completed = call(user, 'POST', `/api/tasks/${created.task.id}/checkin`, { note: 'Completed work' });
  assert.equal(completed.status, 200);
  assert.equal(completed.task.status, 'done');
  assert.equal(completed.task.checkinNote, 'Completed work');
  call(user, 'POST', `/api/tasks/${created.task.id}/checkin`, { note: 'Repeated request' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(created.task.id).n, 1);
});

test('daily item completion rolls back its state when the activity write fails and can be retried', t => {
  const { supervisee, dayId, item, url } = dailyExecution();
  const before = { ...item };
  const clear = failActivity(t, item.id);
  assert.throws(() => call(supervisee, 'POST', url, { done: true }), /activity write failed/);
  assert.deepEqual({ ...plans.dayItemById(db, item.id) }, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n, 0);
  clear();
  const completed = call(supervisee, 'POST', url, { done: true });
  assert.equal(completed.status, 200);
  assert.equal(completed.item.status, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n, 1);
  assert.equal(plans.dayById(db, dayId).checkin_state, 'unsubmitted');
  assert.equal(call(supervisee, 'POST', url, { done: false }).item.status, 'pending');
});

test('explicit daily item state requests preserve completion evidence on retry and keep execution guards', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2030-01-02T04:00:00Z').getTime() });
  const { supervisor, supervisee, cycle, dayId, item, url } = dailyExecution();
  const completed = call(supervisee, 'POST', url, { done: true });
  assert.equal(completed.status, 200);
  const before = { ...plans.dayItemById(db, item.id) };
  t.mock.timers.tick(1000);
  const repeated = call(supervisee, 'POST', url, { done: true });
  assert.equal(repeated.status, 200);
  const eventCount = db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n;
  assert.deepEqual({ item: repeated.item, eventCount }, { item: completed.item, eventCount: 1 });
  assert.deepEqual({ ...plans.dayItemById(db, item.id) }, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n, 1);
  assert.equal(call(supervisor, 'POST', url, { done: true }).status, 403);

  // Omitting the state still toggles, and a new completion has its own event.
  assert.equal(call(supervisee, 'POST', url).item.status, 'pending');
  const pending = { ...plans.dayItemById(db, item.id) };
  assert.equal(call(supervisee, 'POST', url, { done: false }).item.status, 'pending');
  assert.deepEqual({ ...plans.dayItemById(db, item.id) }, pending);
  assert.equal(call(supervisee, 'POST', url).item.status, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n, 2);
  const secondItem = db.prepare('SELECT id FROM plan_day_items WHERE day_id=? AND id<>?').get(dayId, item.id);
  assert.equal(call(supervisee, 'POST', `/api/plans/${cycle.id}/days/${dayId}/items/${secondItem.id}/toggle`, { done: true }).status, 200);
  assert.equal(call(supervisee, 'POST', `/api/plans/${cycle.id}/days/${dayId}/checkin`, { note: 'Finished the day' }).status, 200);
  assert.equal(call(supervisee, 'POST', url, { done: true }).status, 409);
  assert.equal(call(supervisor, 'POST', `/api/plans/${cycle.id}/archive`).status, 200);
  assert.equal(call(supervisee, 'POST', url, { done: true }).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_events WHERE entity_id=?').get(item.id).n, 2);
});

test('personal task deletion preserves linked notifications if deleting the task fails', t => {
  const user = actor();
  const created = call(user, 'POST', '/api/tasks', { title: 'Keep linked evidence' });
  assert.equal(created.status, 200);
  const noteId = notes.insert(db, { userId: user.id, kind: 'task_due', title: 'Task reminder', content: 'Reminder evidence', linkType: 'task', linkId: created.task.id, createdAt: Date.now() });
  const before = { ...db.prepare('SELECT * FROM notifications WHERE id=?').get(noteId) };
  db.exec(`CREATE TEMP TRIGGER fail_execution_delete BEFORE DELETE ON tasks
    WHEN OLD.id='${created.task.id}' BEGIN SELECT RAISE(ABORT,'task delete failed'); END`);
  const clear = () => db.exec('DROP TRIGGER IF EXISTS fail_execution_delete');
  t.after(clear);
  assert.throws(() => call(user, 'DELETE', `/api/tasks/${created.task.id}`), /task delete failed/);
  assert.ok(tasks.byId(db, created.task.id));
  assert.deepEqual({ ...db.prepare('SELECT * FROM notifications WHERE id=?').get(noteId) }, before);
  clear();
  assert.equal(call(user, 'DELETE', `/api/tasks/${created.task.id}`).status, 200);
  assert.equal(tasks.byId(db, created.task.id), undefined);
  assert.equal(db.prepare('SELECT * FROM notifications WHERE id=?').get(noteId), undefined);
});

test.after(() => database.closeDb());

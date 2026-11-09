'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), tasks = require('../src/repo/task.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['task', 'dashboard']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
function actor() {
  return users.insert(db, { username: `task-boundary-${++sequence}`, role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(user, method, url, body = {}) {
  current = user;
  let result;
  router.dispatch(method, url, { method, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function add(user, title, status = 'pending', dueAt = null) {
  return tasks.insert(db, { title, status, dueAt, planId: null, note: '', creatorId: user.id, assigneeId: user.id, remindBeforeMinutes: 30, createdAt: Date.now() });
}

test('task creation and updates reject malformed fields without partial persistence', () => {
  const user = actor();
  const malformed = [
    { note: {} }, { note: [] }, { note: 42 }, { note: null },
    { assigneeId: {} }, { assigneeId: [] }, { assigneeId: null },
    { planId: {} }, { planId: [] }, { dueAt: 1e100 },
  ];
  for (const input of malformed) {
    assert.equal(call(user, 'POST', '/api/tasks', { title: 'Valid task', ...input }).status, 400, JSON.stringify(input));
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks WHERE creator_id=?').get(user.id).n, 0);
  const created = call(user, 'POST', '/api/tasks', { title: 'Original task', note: 'Original note' }).task;
  for (const input of malformed.filter(input => !Object.hasOwn(input, 'planId'))) {
    assert.equal(call(user, 'PUT', `/api/tasks/${created.id}`, { title: 'Changed task', ...input }).status, 400, JSON.stringify(input));
    assert.equal(tasks.byId(db, created.id).title, 'Original task');
    assert.equal(tasks.byId(db, created.id).note, 'Original note');
  }
});

test('task epoch zero and explicit clearing preserve the intended deadline and reminder defaults', () => {
  const user = actor();
  const created = call(user, 'POST', '/api/tasks', { title: 'Epoch task', dueAt: 0, remindBeforeMinutes: 0 });
  assert.equal(created.status, 200);
  assert.equal(created.task.dueAt, 0);
  assert.equal(created.task.remindBeforeMinutes, 0);
  const updated = call(user, 'PUT', `/api/tasks/${created.task.id}`, { dueAt: null, remindBeforeMinutes: null });
  assert.equal(updated.status, 200);
  assert.equal(updated.task.dueAt, null);
  assert.equal(updated.task.remindBeforeMinutes, 30);
});

test('malformed checkin notes do not complete a personal task', () => {
  const user = actor(), task = add(user, 'Pending work');
  for (const note of [{}, [], 42, null]) {
    assert.equal(call(user, 'POST', `/api/tasks/${task.id}/checkin`, { note }).status, 400);
    assert.equal(tasks.byId(db, task.id).status, 'pending');
  }
  assert.equal(call(user, 'POST', `/api/tasks/${task.id}/checkin`, { note: 'Completed work' }).task.checkinNote, 'Completed work');
});

test('overview aggregates beyond the first page and filters detail lists before limiting them', t => {
  const user = actor(), other = actor();
  const now = new Date('2030-01-02T04:00:00Z').getTime();
  t.mock.timers.enable({ apis: ['Date'], now });
  for (let i = 0; i < 250; i++) add(user, `Old completion ${i}`, 'done', now - 5 * 86400000);
  const overdue = add(user, 'Overdue today', 'pending', now - 3600000);
  const later = add(user, 'Later today', 'pending', now + 3600000);
  add(user, 'Tomorrow', 'pending', now + 86400000);
  add(user, 'Submitted', 'submitted');
  add(user, 'Cancelled', 'cancelled');
  for (let i = 0; i < 20; i++) add(other, 'Private task', 'pending', now - 1);
  const overview = call(user, 'GET', '/api/me/overview');
  assert.deepEqual(overview.stats, { total: 255, pending: 3, done: 250, overdue: 1, today: 2 });
  assert.deepEqual(new Set(overview.todayTasks.map(task => task.id)), new Set([overdue.id, later.id]));
  assert.deepEqual(overview.overdue.map(task => task.id), [overdue.id]);
  assert.equal(overview.upcoming.length, 3);
  assert.ok(overview.upcoming.every(task => task.assigneeId === user.id));
});

test('overview today range follows calendar midnight across daylight saving changes', t => {
  const previousZone = process.env.TZ;
  process.env.TZ = 'America/New_York';
  t.after(() => { process.env.TZ = previousZone; });
  const user = actor(), now = new Date('2030-03-10T16:00:00Z').getTime();
  t.mock.timers.enable({ apis: ['Date'], now });
  const today = add(user, 'Late today', 'pending', new Date('2030-03-11T03:30:00Z').getTime());
  add(user, 'Tomorrow midnight', 'pending', new Date('2030-03-11T04:30:00Z').getTime());
  const overview = call(user, 'GET', '/api/me/overview');
  assert.equal(overview.stats.today, 1);
  assert.deepEqual(overview.todayTasks.map(task => task.id), [today.id]);
});
test.after(() => database.closeDb());

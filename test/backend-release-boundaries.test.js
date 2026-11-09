'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
let current, sequence = 0, failNotification = false;
const deps = { notify: { deliver() { if (failNotification) throw new Error('notification unavailable'); } }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/plan.ctrl').register(router, deps);
require('../src/controllers/task.ctrl').register(router, deps);
require('../src/controllers/market.ctrl').register(router, deps);
require('../src/controllers/admin.ctrl').register(router, deps);
function user(role = 'supervisee') {
  return users.insert(db, { username: `release-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(actor, method, url, body = {}, query = {}) {
  current = actor;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, query, body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}

test('archiving a personal plan preserves completed task evidence and prevents reopening it', () => {
  const actor = user();
  const plan = ok(actor, 'POST', '/api/plans', { title: 'Personal plan' }).plan;
  const task = ok(actor, 'POST', '/api/tasks', { title: 'Completed evidence', planId: plan.id }).task;
  ok(actor, 'POST', `/api/tasks/${task.id}/checkin`, { note: 'Completed work' });
  ok(actor, 'POST', `/api/plans/${plan.id}/archive`);
  assert.equal(call(actor, 'POST', `/api/tasks/${task.id}/uncheck`).status, 409);
  const stored = db.prepare('SELECT status,checkin_note FROM tasks WHERE id=?').get(task.id);
  assert.equal(stored.status, 'done');
  assert.equal(stored.checkin_note, 'Completed work');
});

test('active personal plans still allow a completed task to be reopened', () => {
  const actor = user();
  const plan = ok(actor, 'POST', '/api/plans', { title: 'Active plan' }).plan;
  const task = ok(actor, 'POST', '/api/tasks', { title: 'Reopenable task', planId: plan.id }).task;
  ok(actor, 'POST', `/api/tasks/${task.id}/checkin`);
  assert.equal(ok(actor, 'POST', `/api/tasks/${task.id}/uncheck`).task.status, 'pending');
});

for (const resource of ['plans', 'tasks']) {
  test(`${resource}: maximum-size pagination exposes and retrieves every record exactly once`, () => {
    const actor = user();
    for (let i = 0; i < 501; i++) ok(actor, 'POST', `/api/${resource}`, { title: `Record ${i}` });
    const first = ok(actor, 'GET', `/api/${resource}`, {}, { limit: '500' });
    assert.equal(first[resource].length, 500);
    assert.equal(first.nextOffset, 500);
    const second = ok(actor, 'GET', `/api/${resource}`, {}, { limit: '500', offset: String(first.nextOffset) });
    assert.equal(second[resource].length, 1);
    assert.equal(second.nextOffset, null);
    assert.equal(new Set([...first[resource], ...second[resource]].map(row => row.id)).size, 501);
  });
}
test('collaboration handoffs roll back when notification enqueue fails and remain retryable', () => {
  const supervisor = user('supervisor'), supervisee = user();
  require('../src/repo/cooperation.repo').save(db, supervisor, supervisor.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  const input = { personId: supervisor.id, goal: 'Practice', mode: 'quick', desiredStartAt: Date.now() };
  failNotification = true;
  try {
    assert.throws(() => call(supervisee, 'POST', '/api/requests', input), /notification unavailable/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM service_requests WHERE supervisee_id=?').get(supervisee.id).n, 0);
  } finally { failNotification = false; }
  const request = ok(supervisee, 'POST', '/api/requests', input);
  for (const [actor, method, action, body] of [
    [supervisee, 'POST', 'messages', { content: 'Please help me practice' }],
    [supervisor, 'PUT', 'terms', { terms: 'Daily feedback' }],
    [supervisor, 'POST', 'confirm', {}],
  ]) {
    const before = { ...db.prepare('SELECT * FROM service_requests WHERE id=?').get(request.id) };
    failNotification = true;
    try {
      assert.throws(() => call(actor, method, `/api/requests/${request.id}/${action}`, body), /notification unavailable/);
      assert.deepEqual({ ...db.prepare('SELECT * FROM service_requests WHERE id=?').get(request.id) }, before);
      if (action === 'messages') assert.equal(db.prepare('SELECT COUNT(*) n FROM request_messages WHERE request_id=?').get(request.id).n, 0);
    } finally { failNotification = false; }
    ok(actor, method, `/api/requests/${request.id}/${action}`, body);
  }
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(request.id).status, 'planning');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM request_messages WHERE request_id=?').get(request.id).n, 1);
});

test('disabling or changing a role through admin edit invalidates preexisting sessions', () => {
  const admin = user('admin'), actor = user();
  const security = require('../src/security');
  const token = security.createSession(db, actor.id);
  ok(admin, 'PUT', `/api/admin/users/${actor.id}`, { status: false });
  ok(admin, 'PUT', `/api/admin/users/${actor.id}`, { status: true });
  assert.equal(security.userByToken(db, token), null);
  const nextToken = security.createSession(db, actor.id);
  ok(admin, 'PUT', `/api/admin/users/${actor.id}`, { role: 'supervisor' });
  assert.equal(security.userByToken(db, nextToken), null);
});
test.after(() => database.closeDb());

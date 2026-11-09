'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
const security = require('../src/security');
let current, sequence = 0;
const deps = {
  db,
  notify: { deliver() {} },
  security: { ...security, authenticate: () => ({ user: current && users.byId(db, current.id) }) },
};
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['admin', 'supervision', 'market', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
function add(role = 'supervisee', fields = {}) {
  return users.insert(db, { username: `admin-boundary-${++sequence}`, displayName: `旧名称${sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now(), ...fields });
}
const admin = add('admin');
function call(actor, method, url, body = {}) {
  current = actor;
  let result;
  const u = new URL(url, 'http://local');
  router.dispatch(method, u.pathname, { method, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, Object.fromEntries(u.searchParams), body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}
function grant(supervisor) {
  ok(admin, 'PUT', `/api/admin/users/${supervisor.id}/cooperation`, { state: 'active', capacity: 10, agreementRef: 'isolated-test', note: '测试授权', published: true });
}
function pair() {
  const supervisor = add('supervisor'), supervisee = add();
  grant(supervisor);
  return { supervisor, supervisee };
}
function request(supervisor, supervisee) {
  return ok(supervisee, 'POST', '/api/requests', { personId: supervisor.id, goal: '每天阅读', mode: 'quick', desiredStartAt: Date.now() });
}
test.after(() => database.closeDb());

test('maximum administrator user page exposes the 501st matching user without duplicates', () => {
  for (let i = 0; i < 501; i++) add('supervisee', { username: `pagination-boundary-${i}`, createdAt: i });
  const first = ok(admin, 'GET', '/api/admin/users?q=pagination-boundary-&limit=500');
  assert.equal(first.users.length, 500);
  assert.equal(first.total, 501);
  assert.equal(first.nextOffset, 500);
  const second = ok(admin, 'GET', `/api/admin/users?q=pagination-boundary-&limit=500&offset=${first.nextOffset}`);
  assert.equal(second.users.length, 1);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.users, ...second.users].map(row => row.id)).size, 501);
});

test('administrator creation applies nickname format and occupancy rules', () => {
  const input = { username: 'created-nickname', password: 'Temporary-2468', role: 'supervisee', displayName: '新同学' };
  const created = ok(admin, 'POST', '/api/admin/users', input);
  assert.equal(created.user.displayName, '新同学');
  assert.equal(call(admin, 'POST', '/api/admin/users', { ...input, username: 'duplicate-nickname' }).status, 409);
  for (const displayName of ['English', '姓名一二三四五六七八', '', '联系微信']) {
    assert.equal(call(admin, 'POST', '/api/admin/users', { ...input, username: 'invalid-nickname', displayName }).status, 400);
  }
  assert.equal(users.byUsername(db, 'duplicate-nickname'), undefined);
  assert.equal(users.byUsername(db, 'invalid-nickname'), undefined);
});

test('administrator rename rejects duplicates but preserves unchanged legacy names', () => {
  const first = add(), second = add();
  ok(admin, 'PUT', `/api/admin/users/${first.id}`, { displayName: '林老师' });
  assert.equal(call(admin, 'PUT', `/api/admin/users/${second.id}`, { displayName: ' 林老师 ' }).status, 409);
  assert.equal(call(admin, 'PUT', `/api/admin/users/${second.id}`, { displayName: 'Not a Chinese nickname' }).status, 400);
  ok(admin, 'PUT', `/api/admin/users/${first.id}`, { displayName: '林老师', identity: 'mentee' });
  const legacy = add('supervisee', { displayName: 'legacy English name' });
  ok(admin, 'PUT', `/api/admin/users/${legacy.id}`, { displayName: legacy.display_name, identity: 'mentee' });
  assert.equal(users.byId(db, legacy.id).display_name, legacy.display_name);
});

for (const entry of ['admin', 'legacy']) test(`${entry} can remove one relationship while retaining a disabled supervisor`, () => {
  const { supervisor: first, supervisee } = pair(), second = add('supervisor');
  grant(second);
  users.setRelations(db, supervisee.id, [first.id, second.id]);
  ok(admin, 'POST', `/api/admin/users/${second.id}/status`, { active: false });
  if (entry === 'admin') ok(admin, 'PUT', `/api/admin/users/${supervisee.id}`, { managedByIds: [second.id] });
  else ok(first, 'DELETE', `/api/supervision/${supervisee.id}/bind`);
  assert.deepEqual(users.activeSupervisorIds(db, supervisee.id), [second.id]);
  const periods = db.prepare('SELECT ended_at FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=?').all(first.id, supervisee.id);
  assert.equal(periods.length, 1);
  assert.ok(periods[0].ended_at);
});

test('retaining disabled relationships does not permit newly binding disabled accounts', () => {
  const { supervisor, supervisee } = pair(), newcomer = add('supervisor');
  grant(newcomer);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  ok(admin, 'POST', `/api/admin/users/${supervisor.id}/status`, { active: false });
  ok(admin, 'POST', `/api/admin/users/${newcomer.id}/status`, { active: false });
  const before = users.activeSupervisorIds(db, supervisee.id);
  assert.equal(call(admin, 'PUT', `/api/admin/users/${supervisee.id}`, { managedByIds: [supervisor.id, newcomer.id] }).status, 409);
  assert.deepEqual(users.activeSupervisorIds(db, supervisee.id), before);
});

for (const changedRole of ['supervisee', 'supervisor']) test(`changing ${changedRole} closes all unfinished negotiations and proposed plans, retaining history`, () => {
  const { supervisor, supervisee } = pair();
  const r = request(supervisor, supervisee);
  ok(supervisee, 'POST', `/api/requests/${r.id}/messages`, { content: '原协商内容' });
  ok(supervisor, 'POST', `/api/requests/${r.id}/confirm`);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const bundle = ok(supervisor, 'POST', '/api/plan-bundles', { requestId: r.id, assigneeId: supervisee.id, title: '阶段目标', dailyContent: '阅读', startAt: +start, dueAt: +start });
  const actor = changedRole === 'supervisee' ? supervisee : supervisor;
  const nextRole = changedRole === 'supervisee' ? 'supervisor' : 'supervisee';
  const other = actor.id === supervisor.id ? supervisee : supervisor;
  const otherRequests = [];
  for (const state of ['discussing', 'planning']) {
    const otherPair = pair();
    const sup = actor.id === supervisor.id ? supervisor : otherPair.supervisor;
    const sub = actor.id === supervisee.id ? supervisee : otherPair.supervisee;
    const pending = request(sup, sub);
    if (state === 'planning') ok(sup, 'POST', `/api/requests/${pending.id}/confirm`);
    otherRequests.push(pending.id);
  }
  ok(admin, 'PUT', `/api/admin/users/${actor.id}`, { role: nextRole });
  for (const id of [r.id, ...otherRequests]) assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(id).status, 'closed');
  const tree = db.prepare('SELECT status FROM plans WHERE service_request_id=?').all(r.id);
  assert.equal(tree.length, 2);
  assert.ok(tree.every(row => row.status === 'archived'));
  assert.equal(plans.byId(db, bundle.plan.id).status, 'archived');
  assert.equal(ok(actor, 'GET', `/api/requests/${r.id}`).messages[0].content, '原协商内容');
  assert.equal(call(actor, 'POST', `/api/requests/${r.id}/messages`, { content: '继续协商' }).status, 409);
  assert.equal(call(other, 'POST', `/api/requests/${r.id}/confirm`).status, 409);
});

test('legacy unfinished negotiations reject writes when participant roles no longer match', () => {
  const { supervisor, supervisee } = pair(), r = request(supervisor, supervisee);
  users.update(db, supervisee.id, { role: 'supervisor' });
  assert.equal(call(supervisee, 'POST', `/api/requests/${r.id}/messages`, { content: '继续协商' }).status, 409);
  assert.equal(call(supervisor, 'PUT', `/api/requests/${r.id}/terms`, { terms: '继续约定' }).status, 409);
  assert.equal(call(supervisor, 'POST', `/api/requests/${r.id}/confirm`).status, 409);
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(r.id).status, 'discussing');
  assert.equal(ok(supervisee, 'GET', `/api/requests/${r.id}`).request.id, r.id);
});

test('failed role cleanup rolls back the role, sessions and associated plans', () => {
  const { supervisor, supervisee } = pair(), r = request(supervisor, supervisee);
  const token = security.createSession(db, supervisee.id);
  const proposed = plans.insert(db, { title: '未接受方案', description: '', creatorId: supervisor.id, assigneeId: supervisee.id, startAt: null, dueAt: null, kind: 'phase', status: 'proposed', serviceRequestId: r.id, createdAt: Date.now() });
  db.exec(`CREATE TEMP TRIGGER reject_role_cleanup BEFORE UPDATE ON service_requests WHEN OLD.id='${r.id}' AND NEW.status='closed' BEGIN SELECT RAISE(ABORT,'test-role-cleanup-failed'); END`);
  try {
    assert.throws(() => call(admin, 'PUT', `/api/admin/users/${supervisee.id}`, { role: 'supervisor' }), /test-role-cleanup-failed/);
    assert.equal(users.byId(db, supervisee.id).role, 'supervisee');
    assert.ok(security.userByToken(db, token));
    assert.equal(plans.byId(db, proposed.id).status, 'proposed');
    assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(r.id).status, 'discussing');
  } finally { db.exec('DROP TRIGGER reject_role_cleanup'); }
});

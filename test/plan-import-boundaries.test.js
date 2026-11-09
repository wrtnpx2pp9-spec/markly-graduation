'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
const security = require('../src/security');
const drafts = require('../src/plan-drafts');
const engine = require('../src/plan-import');
const deps = { db, security, notify: { deliver() {} } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['auth', 'admin', 'plan-import']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
let sequence = 0;
function add(role = 'supervisee') {
  return users.insert(db, { username: `import-boundary-${++sequence}`, displayName: `旧名称${sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
const admin = add('admin'), adminToken = security.createSession(db, admin.id);
function headers(token, mode = 'bearer') {
  return mode === 'cookie'
    ? { cookie: `sd_session=${token}`, 'x-markly-client': 'web', 'sec-fetch-site': 'same-origin' }
    : { authorization: `Bearer ${token}` };
}
async function call(authHeaders, method, url, body = {}) {
  let result;
  const u = new URL(url, 'http://local');
  await router.dispatch(method, u.pathname, { method, url, headers: authHeaders, socket: { remoteAddress: '127.0.0.1' } }, {
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, Object.fromEntries(u.searchParams), body);
  return result;
}
async function ok(...args) {
  const result = await call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}
async function pair() {
  const supervisor = add('supervisor'), supervisee = add();
  await ok(headers(adminToken), 'PUT', `/api/admin/users/${supervisor.id}/cooperation`, { state: 'active', capacity: 10, agreementRef: 'isolated-test', note: '测试授权', published: true });
  users.setRelations(db, supervisee.id, [supervisor.id]);
  return { supervisor, supervisee, token: security.createSession(db, supervisor.id) };
}
const text = '目标：阅读\n每天：阅读 20分钟';
const limits = { start: '2026-10-10', days: 1, dailyLimit: 60, workdays: [1, 2, 3, 4, 5, 6, 7] };
const source = { name: '隔离测试', digest: '', lines: [], notices: [] };
function workspace(assigneeId) { return engine.expand(engine.parseText(text).rules, limits, assigneeId).workspace; }
function count(ownerId) { return db.prepare('SELECT COUNT(*) AS n FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL').get(ownerId).n; }
function delayDocument(t) {
  const original = engine.readDocument;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  engine.readDocument = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  t.after(() => { engine.readDocument = original; });
  return { started, release: () => release(text) };
}
function input(assigneeId) { return { assigneeId, file: { name: 'isolated.docx', base64: 'isolated' }, constraints: limits }; }
async function credential(supervisor, token) {
  await ok(headers(adminToken), 'PUT', `/api/admin/plan-access/${supervisor.id}`, { action: 'eligible', note: '允许申请' });
  await ok(headers(token), 'POST', '/api/plan-access/apply', { purpose: '隔离导入测试' });
  await ok(headers(adminToken), 'PUT', `/api/admin/plan-access/${supervisor.id}`, { action: 'approve', days: 1, quota: 100, note: '批准草稿权限' });
  return (await ok(headers(token), 'POST', '/api/plan-access/credential')).credential;
}
test.after(() => database.closeDb());

for (const mode of ['bearer', 'cookie']) test(`logout invalidates a delayed ${mode} import before any draft is written`, async t => {
  const { supervisor, supervisee, token } = await pair(), delayed = delayDocument(t);
  const pending = call(headers(token, mode), 'POST', '/api/plan-import', input(supervisee.id));
  await delayed.started;
  await ok(headers(token, mode), 'POST', '/api/auth/logout');
  assert.equal(security.userByToken(db, token), null);
  delayed.release();
  const result = await pending;
  assert.equal(result.status, 401, JSON.stringify(result));
  assert.equal(count(supervisor.id), 0);
});

test('a valid machine credential still creates a delayed draft without a session token', async t => {
  const { supervisor, supervisee, token } = await pair(), machine = await credential(supervisor, token), delayed = delayDocument(t);
  const pending = call({ ...headers(machine), 'idempotency-key': 'valid-import-credential' }, 'POST', '/api/internal/plan-drafts', input(supervisee.id));
  await delayed.started;
  await ok(headers(token), 'POST', '/api/auth/logout');
  delayed.release();
  const result = await pending;
  assert.equal(result.status, 201, JSON.stringify(result));
  assert.equal(count(supervisor.id), 1);
});

test('revoking a machine credential during extraction prevents both draft and idempotency writes', async t => {
  const { supervisor, supervisee, token } = await pair(), machine = await credential(supervisor, token), delayed = delayDocument(t);
  const pending = call({ ...headers(machine), 'idempotency-key': 'revoked-import-credential' }, 'POST', '/api/internal/plan-drafts', input(supervisee.id));
  await delayed.started;
  await ok(headers(adminToken), 'PUT', `/api/admin/plan-access/${supervisor.id}`, { action: 'revoke', note: '撤销测试凭据' });
  delayed.release();
  const result = await pending;
  assert.equal(result.status, 401, JSON.stringify(result));
  assert.equal(count(supervisor.id), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plan_api_requests WHERE user_id=?').get(supervisor.id).n, 0);
});

test('an asynchronous import cannot exceed the draft quota after a manual draft takes the final slot', async t => {
  const { supervisor, supervisee, token } = await pair(), w = workspace(supervisee.id);
  for (let i = 0; i < 99; i++) drafts.create(db, supervisor.id, supervisee.id, null, source, limits, w);
  const delayed = delayDocument(t), pending = call(headers(token), 'POST', '/api/plan-import', input(supervisee.id));
  await delayed.started;
  const manual = await call(headers(token), 'POST', '/api/plan-drafts', { assigneeId: supervisee.id, workspace: w, bundle: engine.workspaceBundle(w) });
  assert.equal(manual.status, 201, JSON.stringify(manual));
  delayed.release();
  const result = await pending;
  assert.equal(result.status, 409, JSON.stringify(result));
  assert.equal(count(supervisor.id), 100);
  const last = db.prepare('SELECT id FROM plan_drafts WHERE owner_id=? ORDER BY updated_at,id LIMIT 1').get(supervisor.id);
  await ok(headers(token), 'DELETE', `/api/plan-drafts/${last.id}`);
  const retry = await call(headers(token), 'POST', '/api/plan-import', { assigneeId: supervisee.id, text, constraints: limits });
  assert.equal(retry.status, 201, JSON.stringify(retry));
  assert.equal(count(supervisor.id), 100);
});

test('draft recovery filters the service recipient before taking the latest thirty drafts', async () => {
  const { supervisor, supervisee, token } = await pair(), other = add();
  users.setRelations(db, other.id, [supervisor.id]);
  const target = drafts.create(db, supervisor.id, supervisee.id, null, source, limits, workspace(supervisee.id));
  db.prepare('UPDATE plan_drafts SET updated_at=1 WHERE id=?').run(target.id);
  for (let i = 0; i < 30; i++) {
    const newer = drafts.create(db, supervisor.id, other.id, null, source, limits, workspace(other.id));
    db.prepare('UPDATE plan_drafts SET updated_at=? WHERE id=?').run(10 + i, newer.id);
  }
  const result = await ok(headers(token), 'GET', `/api/plan-drafts?assigneeId=${supervisee.id}`);
  assert.deepEqual(result.drafts.map(row => row.id), [target.id]);
  assert.equal((await ok(headers(token), 'GET', '/api/plan-drafts')).drafts.length, 30);
});

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), security = require('../src/security');
let serial = 0;
const deps = { db, security: { ...security } }, router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/admin.ctrl').register(router, deps);
require('../src/controllers/auth.ctrl').register(router, deps);
function add(role) {
  const salt = security.genSalt();
  return users.insert(db, { username: `session-boundary-${++serial}`, role, passwordHash: security.hashPassword('Old-password-2468', salt), salt, createdAt: Date.now() });
}
const admin = add('admin'), adminToken = security.createSession(db, admin.id);
async function call(method, url, body, token = adminToken) {
  let result;
  await router.dispatch(method, url, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, socket: { remoteAddress: '2001:db8::99' } }, {
    writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function blockRevocation(target) {
  db.exec(`CREATE TRIGGER fail_session_revoke BEFORE DELETE ON sessions WHEN OLD.user_id='${target.id}'
    BEGIN SELECT RAISE(ABORT,'injected session revocation failure'); END;`);
}

test('密码重置与撤销全部会话原子保存，撤销失败不能留下新密码与旧会话组合', async () => {
  const target = add('supervisee'), before = users.byId(db, target.id);
  const tokens = [security.createSession(db, target.id), security.createSession(db, target.id)];
  const sessions = db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token').all(target.id);
  blockRevocation(target);
  try {
    await assert.rejects(call('POST', `/api/admin/users/${target.id}/reset-password`, { password: 'New-password-2468' }), /injected session revocation failure/);
    assert.deepEqual(users.byId(db, target.id), before, 'failed revocation rolls back the password and salt');
    assert.deepEqual(db.prepare('SELECT * FROM sessions WHERE user_id=? ORDER BY token').all(target.id), sessions);
  } finally { db.exec('DROP TRIGGER fail_session_revoke'); }
  assert.equal((await call('POST', `/api/admin/users/${target.id}/reset-password`, { password: 'New-password-2468' })).status, 200);
  assert.equal(security.verifyPassword(users.byId(db, target.id), 'New-password-2468'), true);
  assert.equal(security.verifyPassword(users.byId(db, target.id), 'Old-password-2468'), false);
  for (const token of tokens) assert.equal(security.userByToken(db, token), null);
});

test('停用与撤销会话原子保存，成功停用后再启用也不恢复旧凭据', async () => {
  const target = add('supervisee'), before = users.byId(db, target.id), token = security.createSession(db, target.id);
  blockRevocation(target);
  try {
    await assert.rejects(call('POST', `/api/admin/users/${target.id}/status`, { active: false }), /injected session revocation failure/);
    assert.deepEqual(users.byId(db, target.id), before, 'failed revocation rolls back the disabled status');
    assert.ok(security.userByToken(db, token), 'an aborted disable retains its previous complete state');
  } finally { db.exec('DROP TRIGGER fail_session_revoke'); }
  assert.equal((await call('POST', `/api/admin/users/${target.id}/status`, { active: false })).status, 200);
  assert.equal(security.userByToken(db, token), null);
  assert.equal((await call('POST', `/api/admin/users/${target.id}/status`, { active: true })).status, 200);
  assert.equal(security.userByToken(db, token), null);
});

async function heldLogin(target, change) {
  const originalVerify = deps.security.verifyPasswordAsync;
  let entered, release;
  const arrived = new Promise(resolve => { entered = resolve; }), held = new Promise(resolve => { release = resolve; });
  deps.security.verifyPasswordAsync = async (user, password) => {
    const valid = await originalVerify(user, password);
    entered(); await held; return valid;
  };
  const pending = call('POST', '/api/auth/login', { username: target.username, password: 'Old-password-2468' }, null);
  try { await arrived; await change(); }
  finally { release(); deps.security.verifyPasswordAsync = originalVerify; }
  return pending;
}

test('异步登录已校验旧密码时重置，迟到请求不能创建新的有效会话', async () => {
  const target = add('supervisee'), oldToken = security.createSession(db, target.id);
  const result = await heldLogin(target, async () => {
    assert.equal((await call('POST', `/api/admin/users/${target.id}/reset-password`, { password: 'New-password-2468' })).status, 200);
  });
  assert.equal(result.status, 401);
  assert.equal(security.userByToken(db, oldToken), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(target.id).n, 0);
});

test('异步登录等待期间角色改变，响应与新会话只能使用当前角色', async () => {
  const target = add('supervisor'), oldToken = security.createSession(db, target.id);
  const result = await heldLogin(target, async () => {
    assert.equal((await call('PUT', `/api/admin/users/${target.id}`, { role: 'supervisee' })).status, 200);
  });
  assert.equal(result.status, 200);
  assert.equal(result.user.role, 'supervisee');
  assert.equal(security.userByToken(db, result.token).role, 'supervisee');
  assert.equal(security.userByToken(db, oldToken), null);
});

test.after(() => database.closeDb());

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), security = require('../src/security');
const originalNow = Date.now;
let now = originalNow(), checks = 0, verificationGate;
Date.now = () => now;
const deps = { db, security: { ...security, verifyPasswordAsync: async (user, password) => {
  checks++;
  if (verificationGate && user?.id === verificationGate.userId) {
    verificationGate.enter();
    await verificationGate.wait;
  }
  return !!user && password === 'correct-isolated-password';
} } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/auth.ctrl').register(router, deps);
function user(username) {
  return users.insert(db, { username, role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: now });
}
async function login(username, ip, password = 'wrong-isolated-password') {
  let response;
  await router.dispatch('POST', '/api/auth/login', { method: 'POST', headers: {}, socket: { remoteAddress: ip } }, {
    writeHead(status) { this.status = status; }, setHeader() {},
    end(text) { response = { status: this.status, ...JSON.parse(text) }; },
  }, {}, { username, password });
  return response;
}
async function fill(prefix, count) {
  for (let i = 1; i <= count; i++) {
    const result = await login(`${prefix}-${i}`, `2001:db8:${prefix === 'early' ? '1' : '2'}::${i.toString(16)}`);
    assert.ok([401, 429].includes(result.status), JSON.stringify(result));
  }
}

test('失败计数容量不足时在密码计算前拒绝新键，保留既有计数并回收已过期的键', async () => {
  const firstTime = now;
  await fill('early', 3300); // 9900 account/IP/pair entries, with no real scrypt or network.
  now += 3 * 60 * 1000;
  const blocked = user('capacity-blocked-account'), active = user('capacity-existing-account'), unseen = user('capacity-new-account');
  for (let i = 1; i <= 8; i++) assert.equal((await login(blocked.username, `2001:db8:3::${i}`)).status, 401);
  for (let i = 1; i <= 30; i++) assert.equal((await login(`ip-blocked-${i}`, '2001:db8:4::1')).status, 401);
  assert.equal((await login(active.username, '2001:db8:5::1')).status, 401);
  await fill('late', 10);
  const before = checks;
  const full = await login(unseen.username, '2001:db8:6::1');
  assert.equal(full.status, 429, JSON.stringify(full));
  assert.equal(checks, before, 'new keys that cannot be counted never run password verification');
  assert.equal((await login(blocked.username, '2001:db8:3::1', 'correct-isolated-password')).status, 429);
  assert.equal((await login('ip-blocked-1', '2001:db8:4::1')).status, 429);
  assert.equal((await login(active.username, '2001:db8:5::1', 'correct-isolated-password')).status, 200,
    'existing keys below their limits remain usable at capacity');
  now = firstTime + 15 * 60 * 1000 + 1;
  assert.equal((await login(unseen.username, '2001:db8:6::1', 'correct-isolated-password')).status, 200,
    'expired flood keys are reclaimed without clearing still-valid counters');
  assert.equal((await login(blocked.username, '2001:db8:3::1', 'correct-isolated-password')).status, 429);
  assert.equal((await login('ip-blocked-1', '2001:db8:4::1')).status, 429);
});

test('密码计算等待期间计数容量被耗尽，迟到登录返回429并且不创建会话', async () => {
  now += 16 * 60 * 1000;
  const target = user('capacity-await-account');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  verificationGate = { userId: target.id, enter, wait };
  const pending = login(target.username, '2001:db8:7::1', 'correct-isolated-password');
  try {
    await entered;
    await fill('late', 3334);
  } finally { release(); verificationGate = null; }
  const result = await pending;
  assert.equal(result.status, 429, JSON.stringify(result));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(target.id).n, 0);
});

test.after(() => { Date.now = originalNow; database.closeDb(); });

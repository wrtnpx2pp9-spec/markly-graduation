'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-auth-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { getDb, closeDb } = require('../src/db');
const db = getDb(), security = require('../src/security');
const users = require('../src/repo/user.repo');
const router = require('../src/app').createApp(db);
async function call(route, body, remoteAddress = 'test') {
  let result;
  const res = { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } };
  await router.dispatch('POST', route, { method: 'POST', headers: {}, socket: { remoteAddress } }, res, {}, body);
  return result;
}
test('管理员初始化默认锁定，正确部署密钥只能初始化一次', async () => {
  const previous = process.env.SETUP_TOKEN;
  const admin = { username: 'admin', password: 'test-password-123' };
  try {
    delete process.env.SETUP_TOKEN;
    assert.equal((await call('/api/auth/setup', { admin })).status, 403);
    process.env.SETUP_TOKEN = 'short';
    assert.equal((await call('/api/auth/setup', { admin, setupToken: 'short' })).status, 403);
    process.env.SETUP_TOKEN = 'a'.repeat(64);
    assert.equal((await call('/api/auth/setup', { admin, setupToken: 'b'.repeat(64) })).status, 403);
    assert.equal(users.count(db), 0);
    assert.equal((await call('/api/auth/setup', { admin, setupToken: process.env.SETUP_TOKEN })).status, 200);
    assert.equal((await call('/api/auth/setup', { admin, setupToken: process.env.SETUP_TOKEN })).status, 400);
    const login = await call('/api/auth/login', { username: 'admin', password: admin.password });
    assert.equal(login.status, 200);
    assert.equal(security.userByToken(db, login.token).username, 'admin');
    assert.equal((await call('/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  } finally {
    if (previous === undefined) delete process.env.SETUP_TOKEN; else process.env.SETUP_TOKEN = previous;
  }
});
test('异步登录验证期间停用账号不能取得会话', async () => {
  const pending = call('/api/auth/login', { username: 'admin', password: 'test-password-123' });
  users.setStatus(db, users.byUsername(db, 'admin').id, 0);
  assert.equal((await pending).status, 401);
});
test('密码验证并发有界，多余请求快速退让', async () => {
  const checks = Array.from({ length: 5 }, () => security.verifyPasswordAsync(null, 'invalid'));
  const results = await Promise.allSettled(checks);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(results[4].reason.statusCode, 429);
});
test('登录按账号、IP 和总请求数限流，阻断分布式爆破与请求洪泛', async () => {
  const salt = security.genSalt();
  users.insert(db, { username: 'brute-target', role: 'supervisee', passwordHash: security.hashPassword('correct-password', salt), salt, createdAt: Date.now() });

  // Changing IPs must not bypass the per-account lockout.
  for (let i = 0; i < 8; i++) assert.equal((await call('/api/auth/login', { username: 'brute-target', password: 'wrong-password' }, `distributed-${i}`)).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'brute-target', password: 'wrong-password' }, 'distributed-final')).status, 429);

  // Changing usernames must not bypass the per-IP password-spray limit.
  for (let i = 0; i < 30; i++) assert.equal((await call('/api/auth/login', { username: `spray-user-${i}`, password: 'wrong-password' }, 'spray-origin')).status, 401);
  assert.equal((await call('/api/auth/login', { username: 'spray-user-final', password: 'wrong-password' }, 'spray-origin')).status, 429);

  // Invalid payload floods are rejected before they can consume password-hash CPU.
  for (let i = 0; i < 40; i++) assert.equal((await call('/api/auth/login', { username: '', password: '' }, 'flood-origin')).status, 400);
  assert.equal((await call('/api/auth/login', { username: '', password: '' }, 'flood-origin')).status, 429);
});
test('批量广场与个人主页统计一致，隐藏认证材料；用户列表保持关系隔离', () => {
  const profiles = require('../src/repo/profile.repo');
  const create = (id, role) => users.insert(db,{username:id,role,passwordHash:'hash',salt:'salt',displayName:id,createdAt:Date.now()});
  const sup=create('batch-sup','supervisor'), sub=create('batch-sub','supervisee'), stranger=create('batch-other','supervisee');
  require('../src/repo/cooperation.repo').save(db,sup,'test-admin',{state:'active',capacity:1,agreementRef:'test-record',note:'测试授权',published:true});
  users.setRelations(db,sub.id,[sup.id]);
  profiles.save(db,sup.id,{headline:'监督',bio:'介绍',skills:['学习'],serviceStyle:'每日',published:true,accepting:true});
  const cert=profiles.submitCert(db,sup.id,'证书','机构','PRIVATE-EVIDENCE');
  db.prepare("UPDATE certifications SET status='verified' WHERE id=?").run(cert);
  const list=profiles.marketProfiles(db);
  assert.deepEqual(list,[profiles.publicProfile(db,users.byId(db,sup.id))]);
  assert.equal(JSON.stringify(list).includes('PRIVATE-EVIDENCE'),false);
  assert.deepEqual(users.peopleFor(db,sub).map(u=>u.id),[sup.id]);
  assert.deepEqual(users.peopleFor(db,sup).map(u=>u.id),[sub.id]);
  assert.deepEqual(users.peopleFor(db,stranger),[]);
  users.setStatus(db,sup.id,0);
  assert.equal(profiles.marketProfiles(db).length,0);
  assert.equal(users.peopleFor(db,sub)[0].status,0);
});
test.after(() => { closeDb(); fs.rmSync(dir, { recursive: true, force: true }); });

test('浏览器会话使用 HttpOnly Cookie，跨站写入被拒绝，退出撤销凭据', async()=>{
  const salt=security.genSalt();
  users.insert(db,{username:'cookie-user',role:'supervisee',passwordHash:security.hashPassword('test-password',salt),salt,createdAt:Date.now()});
  async function request(method,url,headers,body={}) {
    let result;const responseHeaders={};
    const res={setHeader(k,v){responseHeaders[k]=v;},writeHead(s){this.status=s;},end(text){result={status:this.status,...JSON.parse(text),headers:responseHeaders};}};
    await router.dispatch(method,url,{method,headers,socket:{encrypted:true,remoteAddress:'cookie-test'}},res,{},body);return result;
  }
  const login=await request('POST','/api/auth/login',{'x-markly-client':'web','sec-fetch-site':'same-origin'},{username:'cookie-user',password:'test-password'});
  assert.equal(login.status,200);assert.equal(login.token,undefined);
  const cookie=login.headers['Set-Cookie'];assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000; Secure/);
  const headers={cookie:cookie.split(';')[0],'x-markly-client':'web','sec-fetch-site':'same-origin'};
  assert.equal((await request('GET','/api/auth/me',headers)).user.username,'cookie-user');
  assert.equal((await request('POST','/api/auth/logout',{cookie:headers.cookie})).status,403);
  assert.equal((await request('POST','/api/auth/logout',{...headers,'sec-fetch-site':'same-site'})).status,403);
  assert.equal((await request('POST','/api/auth/logout',{...headers,'x-markly-user':'previous-account'})).status,401);
  assert.equal((await request('GET','/api/auth/me',headers)).status,200);
  const logout=await request('POST','/api/auth/logout',headers);assert.equal(logout.status,200);assert.match(logout.headers['Set-Cookie'],/Max-Age=0/);
  assert.equal((await request('GET','/api/auth/me',headers)).status,401);
});

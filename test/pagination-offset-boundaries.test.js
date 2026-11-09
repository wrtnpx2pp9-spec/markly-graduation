'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const profiles = require('../src/repo/profile.repo');
const plans = require('../src/repo/plan.repo');
const tasks = require('../src/repo/task.repo');
const admin = users.insert(db, { username: 'offset-admin', role: 'admin', passwordHash: 'hash', salt: 'salt', createdAt: 0 });
const deps = { db, notify: { deliver() {} }, security: { authenticate: () => ({ user: admin }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['admin', 'market', 'registration', 'cooperation-history', 'plan', 'task']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
for (let i = 0; i < 55; i++) {
  const person = users.insert(db, { username: `offset-person-${i}`, role: 'supervisor', passwordHash: 'hash', salt: 'salt', createdAt: i + 1 });
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated',capacity_override=1 WHERE id=?").run(person.id);
  profiles.save(db, person.id, { headline: '', bio: '', skills: [], serviceStyle: '', published: true, accepting: true });
  profiles.submitCert(db, person.id, '测试认证', '', '测试材料');
  db.prepare('INSERT INTO registration_applications(id,username,display_name,role,contact,background,expectation,password_hash,salt,receipt_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(`offset-registration-${i}`, `offset-registration-${i}`, '测试申请', 'supervisee', 'isolated', '', '', 'hash', 'salt', `isolated-receipt-${i}`, i);
  db.prepare('INSERT INTO plans(id,title,creator_id,assignee_id,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(`offset-plan-${i}`, '测试计划', admin.id, admin.id, 'active', i);
  db.prepare('INSERT INTO tasks(id,title,creator_id,assignee_id,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(`offset-task-${i}`, '测试任务', admin.id, admin.id, 'pending', i);
}
const routes = [
  ['/api/admin/users', 'users', { limit: '2' }],
  ['/api/market', 'list', {}],
  ['/api/admin/certifications', 'list', {}],
  ['/api/admin/registrations', 'list', {}],
  ['/api/cooperation-history/plans', 'plans', {}],
  ['/api/plans', 'plans', { limit: '2' }],
  ['/api/tasks', 'tasks', { limit: '2' }],
];
async function get(path, query) {
  let result;
  await router.dispatch('GET', path, { method: 'GET', url: path, headers: {} }, {
    writeHead(status) { this.status = status; }, end(text) { result = { http: this.status, ...JSON.parse(text) }; },
  }, query, {});
  assert.equal(result.http, 200, JSON.stringify(result));
  return result;
}
for (const [path, key, query] of routes) {
  for (const [label, offset] of [['超SQLite整数', '9999999999999999999'], ['400位数字', '9'.repeat(400)]]) {
    test(`${path} ${label}offset返回空页`, async () => {
      const result = await get(path, { ...query, offset });
      assert.deepEqual(result[key], []);
      assert.equal(result.nextOffset, null);
    });
  }
  test(`${path} 正常第二页保留分页顺序且不重复首屏`, async () => {
    const first = await get(path, query);
    assert.ok(first[key].length > 0);
    assert.ok(first.nextOffset > 0);
    const second = await get(path, { ...query, offset: String(first.nextOffset) });
    assert.ok(second[key].length > 0);
    const ids = new Set(first[key].map(row => row.id));
    assert.ok(second[key].every(row => !ids.has(row.id)));
  });
}
for (const offset of ['9999999999999999999', '9'.repeat(400)]) test(`仓储直接调用也限制offset长度${offset.length}`, () => {
  assert.deepEqual(users.listWhere(db, { offset }), []);
  assert.deepEqual(plans.list(db, { all: true }, 2, offset), []);
  assert.deepEqual(tasks.list(db, { all: true }, 2, offset), []);
  assert.deepEqual(profiles.marketPage(db, { offset }).list, []);
});
test.after(() => database.closeDb());

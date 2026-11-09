'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
let current, serial = 0;
const deliveries = [];
const deps = { notify: { deliver(db, message) { deliveries.push(message); } }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['plan', 'task', 'daily-planning', 'cooperation-history']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
function actor(role = 'supervisee') {
  return users.insert(db, { username: `product-round3-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function pair() {
  const sup = actor('supervisor'), sub = actor();
  require('../src/repo/cooperation.repo').save(db, sup, sup.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  users.setRelations(db, sub.id, [sup.id]);
  return { sup, sub };
}
function call(user, method, url, body = {}) {
  current = users.byId(db, user.id);
  const parsed = new URL(url, 'http://local');
  let result;
  router.dispatch(method, parsed.pathname, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, Object.fromEntries(parsed.searchParams), body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}

test('任务重复提交保留首次正文且只通知一次，重复审核不改写已确认记录', () => {
  const { sup, sub } = pair();
  const task = ok(sup, 'POST', '/api/tasks', { title: '重复点击验收', assigneeId: sub.id }).task;
  ok(sub, 'POST', `/api/tasks/${task.id}/checkin`, { note: '原始提交' });
  const submitted = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  ok(sub, 'POST', `/api/tasks/${task.id}/checkin`, { note: '重复点击不能覆盖正文' });
  assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id), submitted);
  assert.equal(deliveries.filter(n => n.linkId === task.id && n.kind === 'task_submitted').length, 1);
  ok(sup, 'POST', `/api/tasks/${task.id}/review`, { decision: 'approved' });
  const approved = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  assert.equal(call(sup, 'POST', `/api/tasks/${task.id}/review`, { decision: 'rejected', note: '不能推翻已确认结果' }).status, 409);
  assert.deepEqual(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id), approved);
  assert.equal(deliveries.filter(n => n.linkId === task.id && n.kind === 'task_review').length, 1);
});

test('重复确认休息提案不复制执行日、不重复通知，纯休息阶段不伪造完成率', () => {
  const { sup, sub } = pair();
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const root = ok(sup, 'POST', '/api/plan-bundles', { title: '休息统计边界', assigneeId: sub.id, planningMode: 'rolling', cycles: [{ title: '休息阶段', startDate: date, endDate: date, rhythm: '根据精力安排' }] }).plan;
  ok(sub, 'POST', `/api/plans/${root.id}/agreement`, { decision: 'accept' });
  const stage = db.prepare('SELECT id FROM plans WHERE parent_id=?').get(root.id);
  const url = `/api/plans/${stage.id}/daily-proposals`;
  const draft = ok(sub, 'POST', url, { date, payload: { rest: true, items: [] } }).proposal;
  ok(sub, 'POST', `${url}/${draft.id}/action`, { action: 'submit', version: draft.version });
  const decision = { action: 'accept', version: draft.version + 1 };
  ok(sup, 'POST', `${url}/${draft.id}/action`, decision);
  const before = JSON.stringify(plans.listDays(db, stage.id));
  const sent = deliveries.length;
  assert.equal(call(sup, 'POST', `${url}/${draft.id}/action`, decision).status, 409);
  assert.equal(JSON.stringify(plans.listDays(db, stage.id)), before);
  assert.equal(deliveries.length, sent);
  const history = ok(sub, 'GET', `/api/cooperation-history/plans/${root.id}`);
  for (const record of history.records) {
    assert.equal(record.total, 0);
    assert.equal(record.done, 0);
    assert.equal(record.completed, false);
  }
  assert.equal(history.records.find(p => p.id === stage.id).days[0].checkinState, 'cancelled');
});

test('计划模板拒绝非字符串或空标题正文，返回400且不产生半成品', () => {
  const sup = actor('supervisor');
  for (const invalid of [null, false, true, 1, {}, [], ' ', '']) {
    for (const body of [{ title: invalid, content: '有效内容' }, { title: '有效标题', content: invalid }]) {
      assert.equal(call(sup, 'POST', '/api/plan-templates', body).status, 400, JSON.stringify(body));
    }
  }
  assert.deepEqual(ok(sup, 'GET', '/api/plan-templates').templates, []);
  const saved = ok(sup, 'POST', '/api/plan-templates', { title: '  模板标题  ', content: '  学习内容  ' }).template;
  assert.equal(saved.title, '模板标题');
  assert.equal(saved.content, '学习内容');
});

test.after(() => database.closeDb());

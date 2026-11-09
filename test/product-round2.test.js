'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
const notes = require('../src/repo/note.repo');
let current, serial = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['notification', 'life', 'plan', 'task', 'daily-planning', 'cooperation-history']) {
  require(`../src/controllers/${name}.ctrl`).register(router, deps);
}
function actor(role = 'supervisee') {
  return users.insert(db, { username: `product-round2-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
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

test('单条和全部已读只修改本人的消息，重复标记不影响他人未读数', () => {
  const { sup, sub } = pair();
  const note = user => notes.insert(db, { userId: user.id, kind: 'test', title: '产品验收消息', content: '私有内容' });
  const mine = note(sub), other = note(sup);
  ok(sub, 'PUT', `/api/notifications/${other}/read`);
  assert.equal(notes.unreadCount(db, sup.id), 1);
  assert.deepEqual(ok(sub, 'GET', '/api/notifications').notifications.map(n => n.id), [mine]);
  for (let i = 0; i < 2; i++) ok(sub, 'PUT', `/api/notifications/${mine}/read`);
  assert.equal(notes.unreadCount(db, sub.id), 0);
  note(sub); note(sub);
  ok(sub, 'POST', '/api/notifications/read');
  assert.equal(notes.unreadCount(db, sub.id), 0);
  assert.equal(notes.unreadCount(db, sup.id), 1);
});

test('当前监督关系不授予私人生活日志或附属个人任务正文的读取权限', () => {
  const { sup, sub } = pair();
  const log = ok(sub, 'POST', '/api/life', { content: '个人生活内容', date: '2026-09-25' }).log;
  assert.equal(call(sup, 'GET', `/api/life?userId=${sub.id}`).status, 403);
  assert.equal(call(sup, 'DELETE', `/api/life/${log.id}`).status, 403);
  assert.equal(ok(sub, 'GET', '/api/life').logs[0].content, '个人生活内容');
  const shared = plans.insert(db, { title: '共同计划', description: '', startAt: null, dueAt: null, creatorId: sup.id, assigneeId: sub.id, kind: 'phase', status: 'active', createdAt: Date.now() });
  const personal = ok(sub, 'POST', '/api/tasks', { title: '私人附属任务', planId: shared.id, note: '仅本人可读的内容' }).task;
  const history = user => ok(user, 'GET', `/api/cooperation-history/plans/${shared.id}`).records[0];
  assert.ok(history(sub).tasks.some(t => t.id === personal.id));
  assert.equal(history(sup).tasks.some(t => t.id === personal.id), false);
  assert.equal(JSON.stringify(history(sup)).includes('仅本人可读的内容'), false);
});

test('同一创建时间的 65 份历史计划分页稳定，不重复、不漏掉且不混入第三方', () => {
  const { sup, sub } = pair(), stranger = actor();
  for (let i = 0; i < 65; i++) plans.insert(db, { title: `同刻历史${i}`, description: '', startAt: null, dueAt: null, creatorId: sup.id, assigneeId: sub.id, kind: 'phase', status: 'archived', createdAt: 12345 });
  plans.insert(db, { title: '第三方私有计划', description: '', startAt: null, dueAt: null, creatorId: stranger.id, assigneeId: stranger.id, kind: 'phase', status: 'archived', createdAt: 12345 });
  const ids = [];
  let offset = 0;
  do {
    const page = ok(sub, 'GET', `/api/cooperation-history/plans?personId=${sup.id}&offset=${offset}`);
    ids.push(...page.plans.map(p => p.id));
    offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(ids.length, 65);
  assert.equal(new Set(ids).size, 65);
  assert.deepEqual(ids, db.prepare('SELECT id FROM plans WHERE creator_id=? AND assignee_id=? ORDER BY created_at DESC,id DESC').all(sup.id, sub.id).map(p => p.id));
  assert.deepEqual(ok(stranger, 'GET', `/api/cooperation-history/plans?personId=${sup.id}`).plans, []);
});

test('归档关闭未提交的每日草稿，历史保留给作者但不泄露给合作对象', () => {
  const { sup, sub } = pair();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const root = ok(sup, 'POST', '/api/plan-bundles', { assigneeId: sub.id, title: '滚动草稿隐私', planningMode: 'rolling', cycles: [{ title: '本日阶段', startDate: date, endDate: date, rhythm: '近期协商' }] }).plan;
  ok(sub, 'POST', `/api/plans/${root.id}/agreement`, { decision: 'accept' });
  const stage = db.prepare('SELECT id FROM plans WHERE parent_id=?').get(root.id);
  const proposal = ok(sub, 'POST', `/api/plans/${stage.id}/daily-proposals`, { date, payload: { rest: false, items: [{ title: '未决定的私人草稿' }] }, reason: '尚未提交' }).proposal;
  ok(sup, 'POST', `/api/plans/${root.id}/archive`);
  const history = user => ok(user, 'GET', `/api/cooperation-history/plans/${root.id}`).records.find(p => p.id === stage.id);
  assert.equal(history(sub).dailyProposals[0].id, proposal.id);
  assert.equal(history(sub).dailyProposals[0].status, 'closed');
  assert.deepEqual(history(sup).dailyProposals, []);
  assert.equal(JSON.stringify(history(sup)).includes('未决定的私人草稿'), false);
});

test.after(() => database.closeDb());

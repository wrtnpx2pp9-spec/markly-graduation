'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
let current, serial = 0;
const signals = [];
const deps = { notify: { deliver(_db, message) { signals.push(message); } }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['plan', 'daily-planning']) require(`../src/controllers/${name}.ctrl`).register(router, deps);

function call(user, method, url, body = {}) {
  current = users.byId(db, user.id);
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { http: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.http, 200, JSON.stringify(result));
  return result;
}
function setup() {
  const actor = role => users.insert(db, { username: `draft-conflict-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const sup = actor('supervisor'), sub = actor('supervisee');
  require('../src/repo/cooperation.repo').save(db, sup, sup.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  users.setRelations(db, sub.id, [sup.id]);
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const root = ok(sup, 'POST', '/api/plan-bundles', { assigneeId: sub.id, title: '多设备每日安排', planningMode: 'rolling', cycles: [{ title: '当前阶段', startDate: date, endDate: date, rhythm: '双方协商' }] }).plan;
  ok(sub, 'POST', `/api/plans/${root.id}/agreement`, { decision: 'accept' });
  const stage = db.prepare('SELECT id FROM plans WHERE parent_id=?').get(root.id);
  return { sup, sub, root, stage, date, url: `/api/plans/${stage.id}/daily-proposals` };
}
function body(x, title, draft) {
  return { date: x.date, reason: `${title}的说明`, payload: { rest: false, items: [{ title }] }, ...(draft ? { draftId: draft.id, version: draft.version } : {}) };
}
function save(x, title, draft, who = x.sub) { return ok(who, 'POST', x.url, body(x, title, draft)).proposal; }
function action(x, draft, actionName) { return ok(x.sub, 'POST', `${x.url}/${draft.id}/action`, { action: actionName, version: draft.version }); }
function state(x) {
  return {
    proposals: db.prepare('SELECT * FROM daily_plan_proposals WHERE plan_id=? ORDER BY id').all(x.stage.id),
    days: db.prepare('SELECT * FROM plan_days WHERE plan_id=? ORDER BY id').all(x.stage.id),
    signals: signals.length,
  };
}

test('旧设备保存被拒绝且不写入或通知；读取最新版后须显式保存本机内容', () => {
  const x = setup(), initial = save(x, '初始草稿');
  const remote = save(x, '另一设备的新内容', initial);
  const before = state(x);
  assert.equal(call(x.sub, 'POST', x.url, body(x, '本机未保存内容', initial)).http, 409);
  assert.deepEqual(state(x), before);
  const latest = ok(x.sub, 'GET', x.url).proposals.find(p => p.id === initial.id);
  assert.equal(latest.version, remote.version);
  assert.equal(latest.payload.items[0].title, '另一设备的新内容');
  assert.deepEqual(state(x), before, '仅检查冲突不能写入服务器或发通知');
  const recovered = save(x, '本机未保存内容', latest);
  assert.equal(recovered.id, initial.id);
  assert.equal(recovered.version, remote.version + 1);
  assert.equal(recovered.payload.items[0].title, '本机未保存内容');
  assert.equal(state(x).days.length, 0);
  assert.equal(signals.length, before.signals, '保存私人草稿不发送通知');
});

test('读取冲突后另一设备再次修改，恢复保存仍重新检查版本', () => {
  const x = setup(), initial = save(x, '第一版');
  const inspected = ok(x.sub, 'GET', x.url).proposals[0];
  const remote = save(x, '第二版', initial), before = state(x);
  assert.equal(call(x.sub, 'POST', x.url, body(x, '过期恢复内容', inspected)).http, 409);
  assert.deepEqual(state(x), before);
  assert.equal(ok(x.sub, 'GET', x.url).proposals[0].version, remote.version);
});

test('同一天对方私人草稿造成冲突时，不泄露内容或赋予覆盖权限', () => {
  const x = setup(), other = save(x, '监督者私人思考', undefined, x.sup);
  const before = state(x);
  const conflict = call(x.sub, 'POST', x.url, body(x, '执行人新安排'));
  assert.equal(conflict.http, 409);
  assert.equal(JSON.stringify(conflict).includes('监督者私人思考'), false);
  assert.deepEqual(ok(x.sub, 'GET', x.url).proposals, []);
  assert.equal(call(x.sub, 'POST', x.url, body(x, '猜到标识也不能覆盖', other)).http, 409);
  assert.deepEqual(state(x), before);
});

test('另一设备已提交或撤回后，即使读取最新版本也不能作为草稿覆盖', () => {
  for (const verb of ['submit', 'withdraw']) {
    const x = setup(), initial = save(x, '原本的草稿');
    action(x, initial, verb);
    const latest = ok(x.sub, 'GET', x.url).proposals[0], before = state(x);
    assert.equal(latest.status, verb === 'submit' ? 'submitted' : 'withdrawn');
    for (const version of [initial, latest]) {
      assert.equal(call(x.sub, 'POST', x.url, body(x, '强行恢复旧编辑器', version)).http, 409);
      assert.deepEqual(state(x), before);
    }
    if (verb === 'withdraw') {
      const fresh = save(x, '明确重新提出的新草稿');
      assert.notEqual(fresh.id, initial.id);
      assert.equal(ok(x.sub, 'GET', x.url).proposals.find(p => p.id === initial.id).status, 'withdrawn');
    }
  }
});

test('阶段归档后的冲突读取保持只读，旧版本和新版本都不能恢复写入', () => {
  const x = setup(), initial = save(x, '归档前的私人草稿');
  ok(x.sup, 'POST', `/api/plans/${x.root.id}/archive`);
  const result = ok(x.sub, 'GET', x.url), latest = result.proposals[0], before = state(x);
  assert.equal(result.writable, false);
  assert.equal(latest.status, 'closed');
  for (const version of [initial, latest]) {
    assert.equal(call(x.sub, 'POST', x.url, body(x, '尝试重新写入', version)).http, 409);
    assert.equal(call(x.sub, 'POST', `${x.url}/${initial.id}/action`, { action: 'submit', version: version.version }).http, 409);
    assert.deepEqual(state(x), before);
  }
  assert.deepEqual(ok(x.sup, 'GET', x.url).proposals, []);
});

test.after(() => database.closeDb());

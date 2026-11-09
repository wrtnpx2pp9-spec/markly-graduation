'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const engine = require('../src/plan-import');
let current, serial = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['plan-import', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);

async function call(url, body) {
  let result;
  await router.dispatch('POST', url, { method: 'POST', url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { http: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
async function fixture(transform = value => value) {
  const add = role => users.insert(db, { username: `draft-equality-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = add('supervisor'), assignee = add('supervisee');
  require('../src/repo/cooperation.repo').save(db, supervisor, supervisor.id, { state: 'active', capacity: 2, agreementRef: 'isolated', note: 'isolated', published: true });
  users.setRelations(db, assignee.id, [supervisor.id]);
  current = users.byId(db, supervisor.id);
  const workspace = engine.expand(engine.parseText('目标：阅读\n每天：阅读20分钟').rules,
    { start: '2026-11-09', days: 2, dailyLimit: 60, workdays: [1, 2, 3, 4, 5, 6, 7] }, assignee.id).workspace;
  const bundle = transform(engine.workspaceBundle(workspace));
  const created = await call('/api/plan-drafts', { assigneeId: assignee.id, workspace, bundle });
  assert.equal(created.http, 201, JSON.stringify(created));
  return { draft: created.draft, bundle, supervisor };
}
const reversedKeys = value => Array.isArray(value) ? value.map(reversedKeys)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)])) : value;
const publish = (draft, bundle, version = draft.version) => call('/api/plan-bundles', { ...bundle, draftId: draft.id, draftVersion: version });
function unchanged(x) {
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans WHERE creator_id=?').get(x.supervisor.id).n, 0);
  const row = require('../src/plan-drafts').get(db, x.draft.id, x.supervisor.id);
  assert.equal(row.plan_id, null);
  assert.equal(row.version, x.draft.version);
}

test('已保存草稿允许顶层及嵌套对象键顺序变化后发送', async () => {
  const x = await fixture(), reordered = reversedKeys(x.bundle);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(x.bundle));
  const result = await publish(x.draft, reordered);
  assert.equal(result.http, 200, JSON.stringify(result));
  assert.equal(require('../src/plan-drafts').get(db, x.draft.id, x.supervisor.id).plan_id, result.plan.id);
});
test('草稿真实字段值变化仍拒绝发送且保留未发送状态', async () => {
  const x = await fixture();
  for (const changed of [
    { ...x.bundle, title: '未保存的新标题' },
    { ...x.bundle, description: null },
    { ...x.bundle, cycles: x.bundle.cycles.map(cycle => ({ ...cycle, remindHour: cycle.remindHour + 1 })) },
  ]) {
    assert.equal((await publish(x.draft, changed)).http, 409);
    unchanged(x);
  }
});
test('比较保留JSON对空值、负零和未定义字段的原序列化语义', async () => {
  const x = await fixture(bundle => ({ ...bundle, description: null,
    cycles: bundle.cycles.map(cycle => ({ ...cycle, remindHour: -0 })) }));
  const submitted = { ...reversedKeys(x.bundle), omittedField: undefined };
  assert.equal((await publish(x.draft, submitted)).http, 200);
});
test('日历数组顺序变化仍拒绝发送且不创建计划', async () => {
  const x = await fixture();
  const changed = { ...x.bundle, cycles: x.bundle.cycles.map(cycle => ({ ...cycle, dailyItems: [...cycle.dailyItems].reverse() })) };
  assert.equal((await publish(x.draft, changed)).http, 409);
  unchanged(x);
});
test('历史草稿内容损坏仍返回内容冲突且不创建计划', async () => {
  const x = await fixture();
  db.prepare('UPDATE plan_drafts SET bundle_json=? WHERE id=?').run('{invalid-json', x.draft.id);
  assert.equal((await publish(x.draft, x.bundle)).http, 409);
  unchanged(x);
});
test('结构比较不绕过草稿版本和已发送终态保护', async () => {
  const x = await fixture();
  assert.equal((await publish(x.draft, reversedKeys(x.bundle), x.draft.version + 1)).http, 409);
  unchanged(x);
  assert.equal((await publish(x.draft, x.bundle)).http, 200);
  const count = db.prepare('SELECT COUNT(*) AS n FROM plans WHERE creator_id=?').get(x.supervisor.id).n;
  assert.equal((await publish(x.draft, reversedKeys(x.bundle))).http, 409);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans WHERE creator_id=?').get(x.supervisor.id).n, count);
});
test.after(() => database.closeDb());

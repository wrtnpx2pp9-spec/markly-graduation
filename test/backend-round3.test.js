'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
let current, serial = 0, queries = 0;
const measuredDb = { prepare(sql) { queries++; return db.prepare(sql); }, exec(sql) { return db.exec(sql); } };
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db: measuredDb, deps });
require('../src/controllers/plan.ctrl').register(router, deps);
require('../src/controllers/cooperation-history.ctrl').register(router, deps);
function user(role = 'supervisee') {
  return users.insert(db, { username: `round3-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(actor, method, url, body = {}) {
  current = actor;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}

test('plan writes reject malformed fields without corrupting persisted dates or metadata', () => {
  const actor = user(), startAt = Date.parse('2026-09-01T00:00:00Z'), dueAt = startAt + 86400000;
  const invalid = [
    { title: {} }, { title: ' ' }, { title: 'x'.repeat(121) },
    { description: {} }, { description: 'x'.repeat(1001) }, { dailyContent: [] },
    { startAt: 'tomorrow' }, { dueAt: 'garbage' }, { dueAt: 1e100 },
    { remindBeforeMinutes: -1 }, { remindBeforeMinutes: 1.5 }, { remindBeforeMinutes: 10081 },
    { assigneeId: {} }, { parentId: [] },
  ];
  for (const fields of invalid) assert.equal(call(actor, 'POST', '/api/plans', { title: 'Valid title', ...fields }).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plans WHERE creator_id=?').get(actor.id).n, 0);
  const plan = ok(actor, 'POST', '/api/plans', { title: 'Original title', description: 'Original agreement', startAt, dueAt }).plan;
  const original = { ...plans.byId(db, plan.id) };
  for (const fields of [...invalid, { dueAt: startAt - 1 }, { startAt: dueAt + 1 }]) {
    assert.equal(call(actor, 'PUT', `/api/plans/${plan.id}`, fields).status, 400);
    assert.deepEqual({ ...plans.byId(db, plan.id) }, original);
  }
  const updated = ok(actor, 'PUT', `/api/plans/${plan.id}`, { title: 'New title', description: '', dueAt: dueAt + 86400000, remindBeforeMinutes: 0 }).plan;
  assert.equal(updated.title, 'New title');
  assert.equal(updated.description, '');
  assert.equal(updated.remindBeforeMinutes, 0);
  assert.equal(updated.startAt, startAt);
  assert.equal(ok(actor, 'PUT', `/api/plans/${plan.id}`, { startAt: null, dueAt: null }).plan.startAt, null);
});

test('valid epoch dates are preserved instead of being silently converted to absent dates', () => {
  const actor = user();
  for (const kind of ['task', 'phase']) {
    const plan = ok(actor, 'POST', '/api/plans', { title: 'Epoch boundary', kind, startAt: 0, dueAt: 86400000 }).plan;
    assert.equal(plan.startAt, 0);
  }
});

function historyFixture(stageCount) {
  const sup = user('supervisor'), sub = user();
  const base = { title: 'Archived goal', description: '', creatorId: sup.id, assigneeId: sub.id, startAt: 1, dueAt: 2, status: 'archived', createdAt: 1 };
  db.exec('BEGIN');
  try {
    const root = plans.insert(db, { ...base, kind: 'phase' });
    const stages = [];
    const taskInsert = db.prepare("INSERT INTO tasks(id,plan_id,title,note,creator_id,assignee_id,status,created_at) VALUES(?,?,?,?,?,?,'done',1)");
    const proposalInsert = db.prepare("INSERT INTO daily_plan_proposals(id,plan_id,day_date,proposer_id,base_json,payload_json,reason,submitted_at,created_at,updated_at,status) VALUES(?,?,'2026-09-01',?,'null',?,?,?,1,1,?)");
    for (let i = 0; i < stageCount; i++) {
      const stage = plans.insert(db, { ...base, kind: 'cycle', parentId: root.id, title: `Stage ${i}`, startAt: i + 1 });
      stages.push(stage);
      const dayId = stage.id + '-day';
      plans.insertDays(db, stage.id, [{ id: dayId, seq: 1, day_date: '2026-09-01', content: 'Practice', items: ['Task one', 'Task two'], createdAt: 1 }]);
      plans.addDayComment(db, { dayId, planId: stage.id, authorId: sub.id, authorRole: sub.role, content: 'Shared comment', mood: 'calm', createdAt: 1 });
      taskInsert.run(stage.id + '-shared-task', stage.id, 'Shared task', 'Shared evidence', sup.id, sub.id);
      proposalInsert.run(stage.id + '-public-proposal', stage.id, sub.id, '{"rest":false,"items":[{"title":"Practice"}]}', 'Shared adjustment', 1, 'accepted');
    }
    taskInsert.run(root.id + '-private-task', stages[0].id, 'Private task title', 'Private task body', sub.id, sub.id);
    proposalInsert.run(root.id + '-private-proposal', stages[0].id, sub.id, '{"rest":false,"items":[{"title":"Private draft task"}]}', 'Private draft reason', null, 'draft');
    db.exec('COMMIT');
    return { root, stages, sup, sub };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

for (const count of [40, 520]) {
  test(`history detail retains ${count} stages and private boundaries with bounded batch queries`, t => {
    const fixture = historyFixture(count);
    queries = 0;
    const response = ok(fixture.sup, 'GET', `/api/cooperation-history/plans/${fixture.root.id}`);
    const queryCount = queries;
    t.diagnostic(`${count} stages: ${queryCount} SQL preparations including authorization and summary reads`);
    assert.ok(queryCount <= 20, `expected bounded batches, saw ${queryCount} queries for ${count} stages`);
    assert.equal(response.records.length, count + 1);
    assert.deepEqual(response.records.find(row => row.id === fixture.root.id).days, []);
    for (const record of response.records.filter(row => row.kind === 'cycle')) {
      assert.equal(record.days.length, 1);
      assert.deepEqual(record.days[0].items.map(item => item.title), ['Task one', 'Task two']);
      assert.equal(record.days[0].comments[0].content, 'Shared comment');
      assert.equal(record.tasks.length, 1);
      assert.equal(record.tasks[0].note, 'Shared evidence');
      assert.ok(!Object.hasOwn(record.tasks[0], 'plan_id'));
      assert.equal(record.dailyProposals.length, 1);
      assert.equal(record.dailyProposals[0].payload.items[0].title, 'Practice');
    }
    assert.doesNotMatch(JSON.stringify(response), /Private task|Private draft/);
    const own = ok(fixture.sub, 'GET', `/api/cooperation-history/plans/${fixture.root.id}`);
    const first = own.records.find(row => row.id === fixture.stages[0].id);
    assert.equal(first.tasks.length, 2);
    assert.equal(first.dailyProposals.length, 2);
    assert.equal(call(user('supervisor'), 'GET', `/api/cooperation-history/plans/${fixture.root.id}`).status, 404);
  });
}
test.after(() => database.closeDb());

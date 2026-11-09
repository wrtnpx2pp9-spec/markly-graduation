'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
let current, sequence = 0;
const deps = { security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/cooperation-history.ctrl').register(router);
const historicalSnapshot = JSON.stringify({ total: 9, done: 2, percent: 22 });
function fixture() {
  const actor = role => users.insert(db, { username: `history-rest-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = actor('supervisor'), supervisee = actor('supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const common = { description: '', creatorId: supervisor.id, assigneeId: supervisee.id, startAt: 1, dueAt: 2, status: 'archived', createdAt: Date.now() };
  const root = plans.insert(db, { ...common, title: 'Rest history root', kind: 'phase' });
  const child = plans.insert(db, { ...common, title: 'Rest history child', kind: 'cycle', parentId: root.id });
  // The list deliberately includes orphaned historical stages when an old
  // parent is absent; cover its cycle serializer as well as root aggregation.
  const orphan = plans.insert(db, { ...common, title: 'Rest history orphan', kind: 'cycle', parentId: `missing-parent-${++sequence}` });
  for (const cycle of [child, orphan]) {
    for (const [status, state] of [['done', 'approved'], ['rest', 'unsubmitted'], ['rest', 'approved'], ['pending', 'cancelled']]) {
      const id = `history-rest-day-${++sequence}`;
      plans.insertDays(db, cycle.id, [{ id, seq: sequence, day_date: '2020-01-01', content: 'Preserved historical row', items: [], createdAt: Date.now() }]);
      db.prepare('UPDATE plan_days SET status=?,checkin_state=? WHERE id=?').run(status, state, id);
    }
    db.prepare('INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,locked_at,execution_snapshot,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(`history-rest-review-${++sequence}`, cycle.parent_id, cycle.id, supervisee.id, supervisor.id, 100, historicalSnapshot, 100, 100);
  }
  return { supervisor, supervisee, root, child, orphan };
}
function call(user, url) {
  current = users.byId(db, user.id);
  const parsed = new URL(url, 'http://isolated');
  let result;
  router.dispatch('GET', parsed.pathname, { method: 'GET', url, headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, Object.fromEntries(parsed.searchParams), {});
  assert.equal(result.status, 200);
  return result;
}
function assertExecution(record) {
  assert.ok(record);
  assert.deepEqual({ total: record.total, done: record.done, completed: record.completed }, { total: 1, done: 1, completed: true });
}
for (const role of ['supervisor', 'supervisee']) {
  test(`${role} history list excludes legacy rest from both root and orphan cycle completion`, () => {
    const x = fixture(), other = role === 'supervisor' ? x.supervisee : x.supervisor;
    const response = call(x[role], `/api/cooperation-history/plans?personId=${other.id}`);
    assertExecution(response.plans.find(record => record.id === x.root.id));
    assertExecution(response.plans.find(record => record.id === x.orphan.id));
  });
  test(`${role} history detail aggregates work only while preserving raw rest rows and locked snapshots`, () => {
    const x = fixture();
    const response = call(x[role], `/api/cooperation-history/plans/${x.root.id}`);
    assertExecution(response.records.find(record => record.id === x.root.id));
    const child = response.records.find(record => record.id === x.child.id);
    assertExecution(child);
    assert.equal(child.days.length, 4);
    assert.equal(child.days.filter(day => day.status === 'rest').length, 2);
    assert.deepEqual(child.stageReview.executionSnapshot, JSON.parse(historicalSnapshot));
    const cycle = call(x[role], `/api/cooperation-history/plans/${x.child.id}`).records[0];
    assertExecution(cycle);
    assert.deepEqual(cycle.stageReview.executionSnapshot, JSON.parse(historicalSnapshot));
  });
}
test('history GET remains read-only and retains existing locked execution snapshots for both participants', () => {
  const x = fixture();
  const before = db.prepare('SELECT * FROM phase_stage_reviews WHERE cycle_plan_id IN (?,?) ORDER BY cycle_plan_id').all(x.child.id, x.orphan.id);
  for (const user of [x.supervisor, x.supervisee]) {
    const record = call(user, `/api/cooperation-history/plans/${x.child.id}`).records[0];
    assert.deepEqual(record.stageReview.executionSnapshot, JSON.parse(historicalSnapshot));
  }
  assert.deepEqual(db.prepare('SELECT * FROM phase_stage_reviews WHERE cycle_plan_id IN (?,?) ORDER BY cycle_plan_id').all(x.child.id, x.orphan.id), before);
});
test.after(() => database.closeDb());

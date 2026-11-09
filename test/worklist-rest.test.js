'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['dashboard', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
const actor = role => users.insert(db, { username: `worklist-rest-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
const supervisor = actor('supervisor'), supervisee = actor('supervisee'), outsider = actor('supervisee');
db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
users.setRelations(db, supervisee.id, [supervisor.id]);
const stage = plans.insert(db, { title: 'Worklist rest compatibility', description: '', creatorId: supervisor.id, assigneeId: supervisee.id, kind: 'cycle', status: 'active', startAt: 1, dueAt: Date.now() + 86400000, createdAt: Date.now() });
const ids = {};
for (const [name, status, state] of [['work', 'pending', 'unsubmitted'], ['legacyRest', 'rest', 'unsubmitted'], ['legacyApprovedRest', 'rest', 'approved'], ['agreedRest', 'pending', 'cancelled']]) {
  const id = `worklist-rest-day-${++sequence}`; ids[name] = id;
  plans.insertDays(db, stage.id, [{ id, seq: sequence, day_date: '2030-01-03', content: name, items: [], createdAt: Date.now() }]);
  db.prepare('UPDATE plan_days SET status=?,checkin_state=? WHERE id=?').run(status, state, id);
}
function call(user, url) {
  current = users.byId(db, user.id);
  let result;
  router.dispatch('GET', url, { method: 'GET', url, headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, {}, {});
  return result;
}
for (const user of [supervisor, supervisee]) {
  test(`${user.role} worklist retains pending work and excludes legacy and agreed rest days`, () => {
    const result = call(user, '/api/me/worklist');
    assert.equal(result.status, 200);
    assert.deepEqual(result.days.map(day => day.id), [ids.work]);
    assert.equal(result.days[0].status, 'pending');
    assert.equal(result.days[0].checkinState, 'unsubmitted');
  });
}
test('both participants can still read all original rest rows from the plan days history', () => {
  const before = db.prepare('SELECT * FROM plan_days WHERE plan_id=? ORDER BY id').all(stage.id);
  for (const user of [supervisor, supervisee]) {
    const result = call(user, `/api/plans/${stage.id}/days`);
    assert.equal(result.status, 200);
    assert.deepEqual(new Set(result.days.map(day => day.id)), new Set(Object.values(ids)));
    assert.equal(result.days.find(day => day.id === ids.legacyRest).status, 'rest');
    assert.equal(result.days.find(day => day.id === ids.legacyApprovedRest).checkinState, 'approved');
    assert.equal(result.days.find(day => day.id === ids.agreedRest).checkinState, 'cancelled');
  }
  assert.deepEqual(db.prepare('SELECT * FROM plan_days WHERE plan_id=? ORDER BY id').all(stage.id), before);
});
test('unrelated user does not receive another pair’s work or rest rows', () => {
  const worklist = call(outsider, '/api/me/worklist');
  assert.equal(worklist.status, 200);
  assert.deepEqual(worklist.days, []);
  assert.equal(call(outsider, `/api/plans/${stage.id}/days`).status, 403);
});
test.after(() => database.closeDb());

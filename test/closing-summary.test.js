'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/market.ctrl').register(router, deps);
function actor(role) {
  return users.insert(db, { username: `closing-summary-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function fixture(t, freeze = true) {
  if (freeze) t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-03T04:00:00Z') });
  const supervisor = actor('supervisor'), supervisee = actor('supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  return { supervisor, supervisee };
}
function stage(pair, options = {}) {
  return plans.insert(db, { title: 'Closing stage', description: '', creatorId: pair.supervisor.id, assigneeId: pair.supervisee.id, kind: 'cycle', status: 'active', startAt: Date.now() - 86400000, dueAt: Date.now() + 86400000, createdAt: Date.now(), ...options });
}
function day(stage, state = 'approved', status = 'pending') {
  const id = `closing-day-${++sequence}`;
  plans.insertDays(db, stage.id, [{ id, seq: sequence, day_date: '2030-01-03', content: 'Work', items: [], createdAt: Date.now() }]);
  db.prepare('UPDATE plan_days SET checkin_state=?,status=? WHERE id=?').run(state, status, id);
}
function call(user, personId) {
  current = users.byId(db, user.id);
  const url = `/api/relations/${personId}/closing-summary`;
  let result;
  router.dispatch('GET', url, { method: 'GET', url, headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, {}, {});
  return result;
}
function checkBoth(pair, count) {
  const fromSupervisor = call(pair.supervisor, pair.supervisee.id);
  const fromSupervisee = call(pair.supervisee, pair.supervisor.id);
  assert.deepEqual(fromSupervisor, fromSupervisee);
  assert.equal(fromSupervisor.status, 200);
  assert.equal(fromSupervisor.pendingReviews, count);
  return fromSupervisor;
}
test('fixed completed work plus agreed and legacy rest yields one pending review for both participants', t => {
  const pair = fixture(t), cycle = stage(pair);
  day(cycle); day(cycle, 'cancelled'); day(cycle, 'unsubmitted', 'rest');
  checkBoth(pair, 1);
});
test('rolling stage with all work approved remains absent until due', t => {
  const pair = fixture(t), cycle = stage(pair, { planningMode: 'rolling' });
  day(cycle);
  checkBoth(pair, 0);
});
test('rolling stage past due with no execution days needs a review', t => {
  const pair = fixture(t);
  stage(pair, { planningMode: 'rolling', dueAt: Date.now() - 1 });
  checkBoth(pair, 1);
});
test('locked and archived stages are excluded while ordinary pending work counts are retained', t => {
  const pair = fixture(t), locked = stage(pair, { dueAt: Date.now() - 1 });
  db.prepare('INSERT INTO phase_stage_reviews(id,parent_plan_id,cycle_plan_id,supervisee_id,supervisor_id,locked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(`closing-review-${++sequence}`, 'closing-parent', locked.id, pair.supervisee.id, pair.supervisor.id, Date.now(), Date.now(), Date.now());
  stage(pair, { status: 'archived', dueAt: Date.now() - 1 });
  const pending = stage(pair, { planningMode: 'rolling' }); day(pending, 'submitted');
  db.prepare('INSERT INTO tasks(id,title,creator_id,assignee_id,status,created_at) VALUES(?,?,?,?,?,?)')
    .run(`closing-task-${++sequence}`, 'Pending review', pair.supervisor.id, pair.supervisee.id, 'submitted', Date.now());
  const result = checkBoth(pair, 0);
  assert.equal(result.pendingDays, 1); assert.equal(result.pendingTasks, 1);
});
test('stale active stage in an ended cooperation period does not count after cooperation resumes', t => {
  const pair = fixture(t), old = stage(pair, { dueAt: Date.now() - 1 });
  users.setRelations(db, pair.supervisee.id, []);
  users.setRelations(db, pair.supervisee.id, [pair.supervisor.id]);
  // A stale active row must not bypass the lifecycle guard for the old batch.
  db.prepare("UPDATE plans SET status='active' WHERE id=?").run(old.id);
  assert.notEqual(old.cooperation_period_id, db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(pair.supervisor.id, pair.supervisee.id).id);
  checkBoth(pair, 0);
});
test('unrelated users, administrators and ended relationships retain their original refusal', t => {
  const pair = fixture(t);
  assert.equal(call(actor('supervisor'), pair.supervisee.id).status, 404);
  assert.equal(call(actor('supervisee'), pair.supervisor.id).status, 404);
  assert.equal(call(actor('admin'), pair.supervisor.id).status, 404);
  users.setRelations(db, pair.supervisee.id, []);
  assert.equal(call(pair.supervisor, pair.supervisee.id).status, 404);
  assert.equal(call(pair.supervisee, pair.supervisor.id).status, 404);
});

test('empty, all-rest and exact due-time stages follow the actual review boundary', t => {
  const pair = fixture(t), now = Date.now();
  const cases = [
    [{ dueAt: null }, [], false],
    [{ dueAt: now }, [], false],
    [{ dueAt: now - 1 }, [], true],
    [{ planningMode: 'rolling', dueAt: now }, ['approved'], false],
    [{ planningMode: 'rolling', dueAt: null }, ['approved'], false],
    [{}, ['cancelled', 'rest'], false],
    [{}, ['approved', 'submitted'], false],
    [{}, ['approved'], true],
  ];
  let count = 0;
  for (const [options, days, expected] of cases) {
    const cycle = stage(pair, options);
    for (const state of days) day(cycle, state === 'rest' ? 'unsubmitted' : state, state === 'rest' ? 'rest' : 'pending');
    assert.equal(require('../src/plan-lifecycle').readyForReview(db, cycle, now), expected);
    count += Number(expected);
    checkBoth(pair, count);
  }
});

test('missing and mismatched cooperation periods do not contribute reviews', t => {
  const pair = fixture(t), other = fixture(t, false);
  const missing = stage(pair, { dueAt: Date.now() - 1 });
  const mismatched = stage(pair, { dueAt: Date.now() - 1 });
  const wrongPeriod = db.prepare('SELECT id FROM supervision_periods WHERE supervisor_id=? AND supervisee_id=? AND ended_at IS NULL').get(other.supervisor.id, other.supervisee.id).id;
  db.prepare('UPDATE plans SET cooperation_period_id=NULL WHERE id=?').run(missing.id);
  db.prepare('UPDATE plans SET cooperation_period_id=? WHERE id=?').run(wrongPeriod, mismatched.id);
  checkBoth(pair, 0);
});
test.after(() => database.closeDb());

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
const profiles = require('../src/repo/profile.repo');
const reviews = require('../src/repo/phase-review.repo');
let sequence = 0;
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-03T04:00:00Z') });
  const actor = role => users.insert(db, { username: `rest-stats-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = actor('supervisor'), supervisee = actor('supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  profiles.save(db, supervisor.id, { headline: 'Rest statistics', bio: '', skills: [], serviceStyle: '', published: true, publicVisible: true, accepting: true });
  const stage = plans.insert(db, { title: 'Rest statistics', description: '', creatorId: supervisor.id, assigneeId: supervisee.id, kind: 'cycle', status: 'active', startAt: Date.parse('2030-01-01T00:00:00'), dueAt: Date.parse('2030-01-03T23:59:59'), createdAt: Date.now() });
  for (const [date, state, status] of [
    ['2030-01-01', 'approved', 'done'],
    ['2030-01-02', 'unsubmitted', 'rest'],
    ['2030-01-02', 'approved', 'rest'],
    ['2030-01-02', 'cancelled', 'pending'],
    ['2030-01-03', 'unsubmitted', 'rest'],
  ]) {
    const id = `rest-stat-day-${++sequence}`;
    plans.insertDays(db, stage.id, [{ id, seq: sequence, day_date: date, content: state, items: [], createdAt: Date.now() }]);
    db.prepare('UPDATE plan_days SET status=?,checkin_state=? WHERE id=?').run(status, state, id);
  }
  return { supervisor: users.byId(db, supervisor.id), supervisee, stage };
}
for (const entry of ['stats', 'publicProfile', 'marketProfiles', 'marketPage']) {
  test(`${entry} excludes both legacy rest and agreed cancelled days`, t => {
    const { supervisor } = fixture(t);
    let stats;
    if (entry === 'stats') stats = profiles.stats(db, supervisor.id);
    if (entry === 'publicProfile') stats = profiles.publicProfile(db, supervisor).stats;
    if (entry === 'marketProfiles') stats = profiles.marketProfiles(db).find(p => p.id === supervisor.id).stats;
    if (entry === 'marketPage') stats = profiles.marketPage(db).list.find(p => p.id === supervisor.id).stats;
    assert.deepEqual({ total: stats.total, completed: stats.completed, rate: stats.completionRate }, { total: 1, completed: 1, rate: 100 });
  });
}
test('rank excludes legacy rest from completion and today due counts', t => {
  const { supervisor } = fixture(t);
  const router = require('../src/router').createRouter({ db, deps: { security: { authenticate: () => ({ user: supervisor }) } } });
  require('../src/controllers/rank.ctrl').register(router);
  const call = dim => {
    let result;
    router.dispatch('GET', '/api/rank', { method: 'GET', headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, { scope: 'group', dim }, {});
    assert.equal(result.status, 200);
    return result.list[0];
  };
  const progress = call('plan');
  assert.equal(progress.value, 100);
  assert.equal(progress.sub, '1/1 完成');
  assert.equal(progress.recentTotal, 1);
  assert.equal(call('today').sub, '今日到期 0 · 完成 0');
});
test('new review snapshots exclude legacy rest without rewriting locked snapshots', t => {
  const { supervisor, supervisee, stage } = fixture(t);
  assert.deepEqual(reviews.executionSnapshot(db, stage.id), { total: 1, done: 1, percent: 100 });
  const base = { parentPlanId: 'rest-parent', cyclePlanId: stage.id, supervisorId: supervisor.id, superviseeId: supervisee.id, now: Date.now() };
  reviews.saveSelf(db, { ...base, summary: 'Self', difficulty: '', helpfulMethod: '', nextAction: '' });
  reviews.saveSupervisor(db, { ...base, observation: 'Supervisor', progress: '', suggestion: '', resultLabel: '有所进步', recommendNext: '' });
  const revision = reviews.byCycleId(db, stage.id).content_revision;
  reviews.confirm(db, stage.id, 'supervisor', Date.now(), revision);
  const locked = reviews.confirm(db, stage.id, 'supervisee', Date.now(), revision);
  assert.deepEqual(JSON.parse(locked.execution_snapshot), { total: 1, done: 1, percent: 100 });
  const historical = JSON.stringify({ total: 4, done: 1, percent: 25 });
  db.prepare('UPDATE phase_stage_reviews SET execution_snapshot=? WHERE cycle_plan_id=?').run(historical, stage.id);
  assert.equal(reviews.confirm(db, stage.id, 'supervisee', Date.now(), revision).execution_snapshot, historical);
});
test('fixed stage becomes reviewable when every work day is approved despite legacy rest', t => {
  const { stage } = fixture(t);
  assert.ok(stage.due_at > Date.now());
  assert.equal(require('../src/plan-lifecycle').readyForReview(db, stage), true);
});
test.after(() => database.closeDb());

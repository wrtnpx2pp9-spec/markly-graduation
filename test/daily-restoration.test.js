'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
const daily = require('../src/repo/daily-planning.repo'), reviews = require('../src/repo/phase-review.repo');
let current, sequence = 0, rejectNotification = false;
const deps = { notify: { deliver() { if (rejectNotification) throw new Error('restoration notification failure'); } }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/daily-planning.ctrl').register(router, deps);
function call(user, url, body) {
  current = users.byId(db, user.id);
  let result;
  router.dispatch('POST', url, { method: 'POST', url, headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, {}, body);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}
function fixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-03T13:00:00Z') });
  const actor = role => users.insert(db, { username: `daily-restoration-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = actor('supervisor'), supervisee = actor('supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=2 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const common = { description: '', creatorId: supervisor.id, assigneeId: supervisee.id, startAt: Date.parse('2030-01-03T00:00:00'), dueAt: Date.parse('2030-01-04T23:59:59'), status: 'active', planningMode: 'rolling', createdAt: Date.now() };
  const parent = plans.insert(db, { ...common, title: 'Restoration goal', kind: 'phase' });
  const stage = plans.insert(db, { ...common, title: 'Restoration stage', kind: 'cycle', parentId: parent.id });
  const id = `legacy-restoration-day-${++sequence}`;
  plans.insertDays(db, stage.id, [{ id, seq: 1, day_date: '2030-01-03', content: 'Legacy agreed rest', items: [], createdAt: Date.now() }]);
  db.prepare("UPDATE plan_days SET status='rest' WHERE id=?").run(id);
  const url = `/api/plans/${stage.id}/daily-proposals`;
  const proposal = call(supervisee, url, { date: '2030-01-03', reason: 'Resume work', payload: { rest: false, items: [{ title: 'Read one chapter' }] } }).proposal;
  call(supervisee, `${url}/${proposal.id}/action`, { action: 'submit', version: proposal.version });
  return { supervisor, supervisee, stage, id, proposal, actionUrl: `${url}/${proposal.id}/action` };
}
function assertRestored(x) {
  const snapshot = daily.snapshot(db, x.stage.id, '2030-01-03');
  assert.equal(snapshot.day.status, 'pending');
  assert.equal(snapshot.day.checkin_state, 'unsubmitted');
  assert.deepEqual(snapshot.items.map(item => item.title), ['Read one chapter']);
  assert.deepEqual(reviews.executionSnapshot(db, x.stage.id), { total: 1, done: 0, percent: 0 });
  assert.equal(plans.reminderDayById(db, x.id).day_id, x.id);
  const candidates = plans.listPendingCycleDays(db, '2030-01-02', '2030-01-03', 100, { now: Date.now(), dayStart: Date.parse('2030-01-03T00:00:00') });
  assert.ok(candidates.some(candidate => candidate.day_id === x.id));
  const persisted = db.prepare('SELECT * FROM daily_plan_proposals WHERE id=?').get(x.proposal.id);
  assert.equal(persisted.status, 'accepted');
  assert.equal(JSON.parse(persisted.base_json).day.status, 'rest');
  assert.equal(JSON.parse(persisted.base_json).day.content, 'Legacy agreed rest');
}
test('accepting restored legacy rest reactivates execution statistics and scheduled reminders while retaining proposal history', t => {
  const x = fixture(t);
  call(x.supervisor, x.actionUrl, { action: 'accept', version: 2 });
  assertRestored(x);
});
test('failed acceptance notification rolls restoration back and retry atomically succeeds', t => {
  const x = fixture(t);
  const before = daily.snapshot(db, x.stage.id, '2030-01-03');
  const proposalBefore = db.prepare('SELECT * FROM daily_plan_proposals WHERE id=?').get(x.proposal.id);
  rejectNotification = true;
  try {
    assert.throws(() => call(x.supervisor, x.actionUrl, { action: 'accept', version: 2 }), /restoration notification failure/);
  } finally { rejectNotification = false; }
  assert.deepEqual(daily.snapshot(db, x.stage.id, '2030-01-03'), before);
  assert.deepEqual(db.prepare('SELECT * FROM daily_plan_proposals WHERE id=?').get(x.proposal.id), proposalBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items WHERE day_id=?').get(x.id).n, 0);
  call(x.supervisor, x.actionUrl, { action: 'accept', version: 2 });
  assertRestored(x);
});
test.after(() => database.closeDb());

'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
const daily = require('../src/repo/daily-planning.repo');
let current, serial = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/daily-planning.ctrl').register(router, deps);
function call(actor, url, body) {
  current = actor;
  let result;
  router.dispatch('POST', url, { method: 'POST', url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  return result;
}
function setup() {
  const make = role => users.insert(db, { username: `reminder-race-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const sup = make('supervisor'), sub = make('supervisee');
  require('../src/repo/cooperation.repo').save(db, sup, sup.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  users.setRelations(db, sub.id, [sup.id]);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const plan = plans.insert(db, { title: 'Rolling stage', description: '', creatorId: sup.id, assigneeId: sub.id, kind: 'cycle', planningMode: 'rolling', startAt: +start, dueAt: +start + 86399999, status: 'active', createdAt: Date.now() });
  const dayId = plan.id + '-day';
  plans.insertDays(db, plan.id, [{ id: dayId, seq: 1, day_date: date, content: 'Original work', items: ['Original work'], createdAt: Date.now() }]);
  const snapshot = daily.snapshot(db, plan.id, date), item = snapshot.items[0];
  const url = `/api/plans/${plan.id}/daily-proposals`;
  const created = call(sub, url, { date, payload: { rest: false, items: [{ id: item.id, title: 'Adjusted work' }] }, reason: 'Agreed adjustment' });
  assert.equal(created.status, 200);
  const proposal = created.proposal;
  const action = (actor, name, version) => call(actor, `${url}/${proposal.id}/action`, { action: name, version });
  return { sup, sub, plan, dayId, item, proposal, action };
}

test('reminder markers changing before submit and accept do not invalidate previously stored full snapshots', () => {
  const x = setup();
  const saved = db.prepare('SELECT base_json FROM daily_plan_proposals WHERE id=?').get(x.proposal.id).base_json;
  assert.ok(Object.hasOwn(JSON.parse(saved).day, 'remind_fired_at'));
  assert.ok(Object.hasOwn(JSON.parse(saved).day, 'overdue_fired_at'));
  plans.markDayRemindFired(db, x.dayId, Date.now());
  assert.equal(x.action(x.sub, 'submit', 1).status, 200);
  plans.markDayOverdueFired(db, x.dayId, Date.now());
  assert.equal(x.action(x.sup, 'accept', 2).status, 200);
  assert.equal(plans.dayItemById(db, x.item.id).title, 'Adjusted work');
  const stored = db.prepare('SELECT status,base_json FROM daily_plan_proposals WHERE id=?').get(x.proposal.id);
  assert.equal(stored.status, 'accepted');
  assert.equal(stored.base_json, saved, 'no migration or rewriting of historical proposal snapshots');
});

for (const [name, change] of [
  ['item completion', x => db.prepare("UPDATE plan_day_items SET status='done',done_at=? WHERE id=?").run(Date.now(), x.item.id)],
  ['item title', x => db.prepare("UPDATE plan_day_items SET title='New agreed work' WHERE id=?").run(x.item.id)],
  ['check-in state', x => db.prepare("UPDATE plan_days SET checkin_state='submitted' WHERE id=?").run(x.dayId)],
  ['check-in note', x => db.prepare("UPDATE plan_days SET note='New evidence' WHERE id=?").run(x.dayId)],
  ['help request', x => db.prepare("UPDATE plan_days SET help_note='Please help' WHERE id=?").run(x.dayId)],
]) {
  test(`real ${name} changes still reject stale acceptance even when reminder markers also change`, () => {
    const x = setup();
    assert.equal(x.action(x.sub, 'submit', 1).status, 200);
    plans.markDayRemindFired(db, x.dayId, Date.now());
    change(x);
    assert.equal(x.action(x.sup, 'accept', 2).status, 409);
    const stored = db.prepare('SELECT status,version FROM daily_plan_proposals WHERE id=?').get(x.proposal.id);
    assert.equal(stored.status, 'submitted');
    assert.equal(stored.version, 2);
    assert.notEqual(plans.dayItemById(db, x.item.id).title, 'Adjusted work');
  });
}
test.after(() => database.closeDb());

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['dashboard', 'admin', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);

function actor(role = 'supervisee') {
  return users.insert(db, { username: `overview-contract-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(user, url, method = 'GET', body = {}) {
  current = user;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, body);
  assert.equal(result.status, 200);
  return result;
}
function cooperation() {
  const supervisor = actor('supervisor'), supervisee = actor();
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-test',capacity_override=1 WHERE id=?").run(supervisor.id);
  users.setRelations(db, supervisee.id, [supervisor.id]);
  return { supervisor, supervisee };
}
function cycle(pair, start, end, status = 'active') {
  const base = { creatorId: pair.supervisor.id, assigneeId: pair.supervisee.id, description: '', startAt: Date.parse(start + 'T00:00:00'), dueAt: Date.parse(end + 'T23:59:59.999'), status, createdAt: Date.now() };
  const parent = plans.insert(db, { ...base, title: 'Summary goal', kind: 'phase' });
  return plans.insert(db, { ...base, title: 'Summary stage', kind: 'cycle', parentId: parent.id });
}
function day(stage, date, state) {
  const id = crypto.randomUUID();
  plans.insertDays(db, stage.id, [{ id, seq: 1, day_date: date, content: 'Summary execution', items: ['Practice'], createdAt: Date.now() }]);
  if (['submitted', 'approved'].includes(state)) plans.submitDay(db, id, 'Execution submitted');
  if (state === 'approved') plans.reviewDay(db, id, stage.creator_id, 'approved', 'Confirmed execution');
  if (state === 'cancelled') db.prepare("UPDATE plan_days SET checkin_state='cancelled' WHERE id=?").run(id);
  if (state === 'legacy-rest') db.prepare("UPDATE plan_days SET status='rest' WHERE id=?").run(id);
  return id;
}
function freeze(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2030-01-02T04:00:00Z') });
}

test('overview serializes each plan once and leaves absent review fields null', () => {
  const user = actor(), other = actor();
  const base = { description: '', creatorId: user.id, assigneeId: user.id, startAt: null, dueAt: null, status: 'active', createdAt: Date.now() };
  const ids = new Set();
  for (let index = 0; index < 100; index++) ids.add(plans.insert(db, { ...base, title: `Goal ${index}`, kind: 'phase' }).id);
  plans.insert(db, { ...base, creatorId: other.id, assigneeId: other.id, title: 'Other account private plan', kind: 'phase' });
  const response = call(user, '/api/me/overview');
  const { status, ...payload } = response;
  const publicOnly = { ...payload, plans: response.plans.map(plan => ({ ...plan, review: null, stageReview: null })) };
  console.log(JSON.stringify({ overviewPlans: response.plans.length, responseBytes: Buffer.byteLength(JSON.stringify(payload)), withoutNestedRawRowsBytes: Buffer.byteLength(JSON.stringify(publicOnly)), firstReview: response.plans[0].review, nestedRawRows: response.plans[0].stageReview?.length || 0 }));
  assert.equal(response.plans.length, 100);
  assert.deepEqual(new Set(response.plans.map(plan => plan.id)), ids);
  for (const plan of response.plans) {
    assert.equal(plan.review, null);
    assert.equal(plan.stageReview, null);
    assert.equal(Object.hasOwn(plan, 'creator_id'), false);
  }
  assert.doesNotMatch(JSON.stringify(response), /Other account private plan/);
});

for (const dayCount of [2, 120]) {
  test(`creating a fixed stage of ${dayCount} days returns public days with independent empty detail arrays`, () => {
    const user = actor();
    const parent = call(user, '/api/plans', 'POST', { title: 'Personal fixed goal', kind: 'phase' }).plan;
    const start = new Date('2030-01-01T00:00:00'), end = new Date(start);
    end.setDate(end.getDate() + dayCount - 1);
    end.setHours(23, 59, 59, 999);
    const response = call(user, '/api/plans', 'POST', { title: 'Fixed stage', kind: 'cycle', parentId: parent.id, startAt: +start, dueAt: +end, dailyContent: 'Practice and record' });
    const { status, ...payload } = response;
    const publicOnly = { ...payload, days: response.days.map(day => ({ ...day, comments: [], items: [] })) };
    console.log(JSON.stringify({ fixedStageDays: dayCount, responseBytes: Buffer.byteLength(JSON.stringify(payload)), withoutNestedRawRowsBytes: Buffer.byteLength(JSON.stringify(publicOnly)), firstComments: response.days[0].comments, nestedRawRows: response.days[0].items.length }));
    assert.equal(response.days.length, dayCount);
    assert.equal(new Set(response.days.map(day => day.id)).size, dayCount);
    for (const day of response.days) {
      assert.deepEqual(day.comments, []);
      assert.deepEqual(day.items, []);
      assert.equal(Object.hasOwn(day, 'plan_id'), false);
    }
    const stored = call(user, `/api/plans/${response.plan.id}/days`).days;
    assert.equal(stored.length, dayCount);
    for (const day of stored) {
      assert.deepEqual(day.comments, []);
      assert.equal(day.items.length, 1);
      assert.equal(day.items[0].title, 'Practice and record');
      assert.equal(day.items[0].dayId, day.id);
    }
  });
}

test('portrait counts confirmed execution separately from submissions awaiting review', t => {
  freeze(t);
  const pair = cooperation(), stage = cycle(pair, '2029-12-31', '2030-01-01');
  day(stage, '2029-12-31', 'submitted');
  day(stage, '2030-01-01', 'approved');
  const response = call(actor('admin'), `/api/admin/users/${pair.supervisee.id}/portrait`);
  console.log(JSON.stringify({ portraitSubmittedAndApproved: response.portrait.history.planDays, active: response.portrait.activity.activePlanDays }));
  assert.deepEqual(response.portrait.history.planDays, { total: 2, done: 1, completionRate: 50 });
  assert.deepEqual(response.portrait.activity.activePlanDays, { total: 2, done: 1, completionRate: 50 });
});

test('portrait excludes agreed and legacy rest days while preserving archived execution history', t => {
  freeze(t);
  const pair = cooperation(), active = cycle(pair, '2029-12-28', '2030-01-03');
  day(active, '2029-12-28', 'unsubmitted');
  day(active, '2029-12-29', 'legacy-rest');
  day(active, '2029-12-30', 'cancelled');
  day(active, '2029-12-31', 'submitted');
  day(active, '2030-01-01', 'approved');
  day(active, '2030-01-03', 'unsubmitted');
  const archived = cycle(pair, '2029-12-01', '2029-12-03', 'archived');
  day(archived, '2029-12-01', 'approved');
  day(archived, '2029-12-02', 'submitted');
  day(archived, '2029-12-03', 'cancelled');
  const response = call(actor('admin'), `/api/admin/users/${pair.supervisee.id}/portrait`);
  console.log(JSON.stringify({ portraitWithRestAndArchived: response.portrait.history.planDays, active: response.portrait.activity.activePlanDays }));
  assert.deepEqual(response.portrait.history.planDays, { total: 5, done: 2, completionRate: 40 });
  assert.deepEqual(response.portrait.activity.activePlanDays, { total: 3, done: 1, completionRate: 33 });
  assert.equal(response.portrait.concerns.find(concern => concern.text === '当前计划的已过日期完成较少')?.evidence, '1/3 天已确认');
});

test.after(() => database.closeDb());

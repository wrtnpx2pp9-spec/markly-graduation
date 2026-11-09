'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
let current, serial = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['dashboard', 'task', 'plan', 'market']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
function user(role = 'supervisee') {
  return users.insert(db, { username: `worklist-${++serial}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(actor, method, url, body = {}, query = {}) {
  current = actor;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, query, body);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}
function date(offset) {
  const d = new Date(); d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function setup() {
  const sup = user('supervisor'), otherSup = user('supervisor'), sub = user(), outsider = user();
  for (const actor of [sup, otherSup]) require('../src/repo/cooperation.repo').save(db, actor, actor.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  users.setRelations(db, sub.id, [sup.id, otherSup.id]);
  const old = Date.now() - 180 * 86400000;
  const plan = plans.insert(db, { title: 'Existing cooperation', description: '', creatorId: sup.id, assigneeId: sub.id, kind: 'cycle', startAt: old, dueAt: Date.now() + 86400000, status: 'active', createdAt: old });
  const rows = [
    ['old-submitted', -95, 'submitted', '', ''],
    ['yesterday-help', -1, 'approved', 'I need help with tomorrow', ''],
    ['old-rejected', -120, 'rejected', '', ''],
    ['old-withdrawn', -110, 'withdrawn', '', ''],
    ['yesterday-pending', -1, 'unsubmitted', '', ''],
    ['today-pending', 0, 'unsubmitted', '', ''],
    ['future-pending', 1, 'unsubmitted', '', ''],
    ['resolved-help', -1, 'approved', 'Help requested', 'Answered'],
    ['agreed-rest', -1, 'cancelled', '', ''],
  ];
  for (const [index, [key, offset, state, help, reply]] of rows.entries()) {
    const id = plan.id + '-' + key;
    plans.insertDays(db, plan.id, [{ id, seq: index + 1, day_date: date(offset), content: key, items: [key], createdAt: old }]);
    db.prepare('UPDATE plan_days SET checkin_state=?,help_note=?,help_reply=? WHERE id=?').run(state, help, reply, id);
  }
  return { sup, otherSup, sub, outsider, plan, old };
}
const work = actor => call(actor, 'GET', '/api/me/worklist').days;
const tasks = actor => call(actor, 'GET', '/api/tasks', {}, { window: 'recent' }).tasks;
const planList = actor => call(actor, 'GET', '/api/plans', {}, { window: 'recent' }).plans;

test('worklist preserves cross-day review, unresolved help and old resubmissions for both participants', () => {
  const x = setup();
  for (const actor of [x.sup, x.sub]) {
    const days = work(actor), byContent = new Map(days.map(day => [day.content, day]));
    assert.equal(days.length, 8);
    assert.equal(byContent.get('old-submitted').checkinState, 'submitted');
    assert.equal(byContent.get('yesterday-help').helpNote, 'I need help with tomorrow');
    assert.equal(byContent.get('yesterday-help').helpReply, '');
    assert.equal(byContent.get('yesterday-help').checkinState, 'approved');
    assert.equal(byContent.get('old-rejected').checkinState, 'rejected');
    assert.equal(byContent.get('old-withdrawn').checkinState, 'withdrawn');
    assert.ok(byContent.has('future-pending'), 'future work remains available for client categorization');
    assert.equal(byContent.get('resolved-help').helpReply, 'Answered');
    assert.ok(!byContent.has('agreed-rest'));
    assert.equal(byContent.get('old-submitted').creatorId, x.sup.id);
    assert.equal(byContent.get('old-submitted').assigneeId, x.sub.id);
    assert.deepEqual(days.map(day => day.dayDate), days.map(day => day.dayDate).sort());
  }
  assert.deepEqual(work(x.otherSup), [], 'sharing an assignee does not grant access to another supervisor’s day records');
  assert.deepEqual(work(x.outsider), []);
});

test('recent lists retain old undated pending and submitted tasks and active plans', () => {
  const x = setup();
  const pending = call(x.sup, 'POST', '/api/tasks', { title: 'Undated pending', assigneeId: x.sub.id }).task;
  const submitted = call(x.sup, 'POST', '/api/tasks', { title: 'Undated review', assigneeId: x.sub.id }).task;
  call(x.sub, 'POST', `/api/tasks/${submitted.id}/checkin`, { note: 'Ready for review' });
  db.prepare('UPDATE tasks SET created_at=? WHERE id IN (?,?)').run(x.old, pending.id, submitted.id);
  const personal = call(x.sub, 'POST', '/api/tasks', { title: 'Private undated pending' }).task;
  db.prepare('UPDATE tasks SET created_at=? WHERE id=?').run(x.old, personal.id);
  for (const actor of [x.sup, x.sub]) {
    const rows = new Map(tasks(actor).map(task => [task.id, task]));
    assert.equal(rows.get(pending.id).status, 'pending');
    assert.equal(rows.get(pending.id).dueAt, null);
    assert.equal(rows.get(submitted.id).status, 'submitted');
    assert.equal(rows.get(submitted.id).dueAt, null);
    assert.ok(planList(actor).some(plan => plan.id === x.plan.id));
  }
  assert.ok(tasks(x.sub).some(task => task.id === personal.id));
  assert.ok(!tasks(x.sup).some(task => task.id === personal.id));
  assert.deepEqual(tasks(x.otherSup), []);
  assert.ok(!planList(x.otherSup).some(plan => plan.id === x.plan.id));
});

test('archive removes pending execution days and cancels attached work without hiding other active cooperation', () => {
  const x = setup();
  const otherPlan = plans.insert(db, { title: 'Other active cooperation', description: '', creatorId: x.otherSup.id, assigneeId: x.sub.id, kind: 'cycle', startAt: x.old, dueAt: Date.now() + 86400000, status: 'active', createdAt: x.old });
  plans.insertDays(db, otherPlan.id, [{ id: otherPlan.id + '-day', seq: 1, day_date: date(0), content: 'Other active work', items: ['Other active work'], createdAt: Date.now() }]);
  const attached = call(x.sup, 'POST', '/api/tasks', { title: 'Attached review', assigneeId: x.sub.id, planId: x.plan.id }).task;
  call(x.sub, 'POST', `/api/tasks/${attached.id}/checkin`);
  call(x.sup, 'POST', `/api/plans/${x.plan.id}/archive`);
  for (const actor of [x.sup, x.sub]) {
    assert.ok(!work(actor).some(day => day.planId === x.plan.id));
    const row = tasks(actor).find(task => task.id === attached.id);
    assert.equal(row.status, 'cancelled', 'recent history can remain listed but must not count as pending');
    assert.equal(planList(actor).find(plan => plan.id === x.plan.id).status, 'archived');
  }
  assert.ok(work(x.sub).some(day => day.planId === otherPlan.id));
  assert.ok(work(x.otherSup).some(day => day.planId === otherPlan.id));
  assert.ok(!work(x.sup).some(day => day.planId === otherPlan.id));
  assert.ok(users.activeSupervisorIds(db, x.sub.id).includes(x.otherSup.id));
});

test('ending and renewing cooperation does not resurrect old worklist days or tasks', () => {
  const x = setup();
  const task = call(x.sup, 'POST', '/api/tasks', { title: 'Old undated review', assigneeId: x.sub.id }).task;
  call(x.sub, 'POST', `/api/tasks/${task.id}/checkin`);
  call(x.sub, 'DELETE', `/api/relations/${x.sup.id}`);
  users.setRelations(db, x.sub.id, [x.otherSup.id, x.sup.id]);
  for (const actor of [x.sup, x.sub]) {
    assert.ok(!work(actor).some(day => day.planId === x.plan.id));
    assert.ok(!tasks(actor).some(row => row.id === task.id));
    assert.ok(!planList(actor).some(row => row.id === x.plan.id));
  }
  assert.equal(plans.byId(db, x.plan.id).status, 'archived');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status, 'cancelled');
});
test.after(() => database.closeDb());

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db');
const db = database.getDb();
const users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo');
const notify = require('../src/notify');
let current, serial = 0;
const deps = { notify, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
require('../src/controllers/plan.ctrl').register(router, deps);
// Enqueue only: no worker is started and no external request is made.
notify.setNotifyConfig(db, { enabled: true, webhookUrl: 'http://127.0.0.1:1/isolated-test' });

function fixture() {
  const make = role => users.insert(db, { username: 'help-transaction-' + (++serial), role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
  const supervisor = make('supervisor'), supervisee = make('supervisee');
  require('../src/repo/cooperation.repo').save(db, supervisor, supervisor.id, { state: 'active', capacity: 1, agreementRef: 'test', note: 'test', published: false });
  users.setRelations(db, supervisee.id, [supervisor.id]);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const plan = plans.insert(db, { title: 'Help transaction', description: '', creatorId: supervisor.id, assigneeId: supervisee.id, kind: 'cycle', startAt: +start, dueAt: +start + 86399999, status: 'active', createdAt: Date.now() });
  const dayId = plan.id + '-day';
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  plans.insertDays(db, plan.id, [{ id: dayId, seq: 1, day_date: date, content: 'Work', items: ['Work'], createdAt: Date.now() }]);
  return { supervisor, supervisee, plan, dayId, url: `/api/plans/${plan.id}/days/${dayId}/help` };
}
function call(actor, url, content) {
  current = actor;
  let result;
  router.dispatch('POST', url, { method: 'POST', url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, {}, { content });
  return result;
}
function evidence(dayId) {
  return {
    day: { ...plans.dayById(db, dayId) },
    notifications: db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE link_id=?').get(dayId).count,
    outbox: db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get().count,
    activities: db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE entity_id=?').get(dayId).count,
  };
}

for (const reply of [false, true]) {
  test(`${reply ? '困难回复' : '困难求助'}通知入队失败时完整回滚，重试只保存一份通知`, () => {
    const x = fixture();
    if (reply) assert.equal(call(x.supervisee, x.url, 'Original request').status, 200);
    else db.prepare("UPDATE plan_days SET help_note='Previous request',help_reply='Previous reply' WHERE id=?").run(x.dayId);
    const before = evidence(x.dayId);
    const actor = reply ? x.supervisor : x.supervisee;
    const content = reply ? 'New reply' : 'New request';
    db.exec("CREATE TEMP TRIGGER fail_help_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'help outbox unavailable'); END");
    try {
      assert.throws(() => call(actor, x.url, content), /help outbox unavailable/);
      assert.deepEqual(evidence(x.dayId), before);
    } finally { db.exec('DROP TRIGGER fail_help_outbox'); }
    assert.equal(call(actor, x.url, content).status, 200);
    const after = evidence(x.dayId);
    assert.equal(after.day.help_note, reply ? 'Original request' : 'New request');
    assert.equal(after.day.help_reply, reply ? 'New reply' : '');
    assert.equal(after.notifications, before.notifications + 1);
    assert.equal(after.outbox, before.outbox + 1);
    assert.equal(after.activities, before.activities + 1);
  });
}

test.after(() => database.closeDb());

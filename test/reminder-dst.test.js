'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), users = require('../src/repo/user.repo');
const plans = require('../src/repo/plan.repo'), scheduler = require('../src/scheduler'), notify = require('../src/notify');
let sequence = 0;
function fixture(t, timezone, date, clock) {
  const previousTimezone = process.env.TZ, originalFetch = global.fetch;
  process.env.TZ = timezone;
  const now = +new Date(`${date}T${clock}:00`);
  t.mock.timers.enable({ apis: ['Date'], now });
  const db = database.getDb();
  const user = users.insert(db, { username: `dst-test-${++sequence}`, role: 'supervisee', passwordHash: 'hash', salt: 'salt', createdAt: now });
  const sent = [];
  global.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, body: { cancel: async () => {} } }; };
  t.after(async () => {
    if (notify.outboxStats(db).inFlight || notify.outboxStats(db).sent !== undefined) await notify.startOutbox(db).stop();
    database.closeDb();
    global.fetch = originalFetch;
    if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone;
  });
  const add = (name, remindHour) => {
    const plan = plans.insert(db, { title: name, description: '', creatorId: user.id, assigneeId: user.id, kind: 'cycle', status: 'active', startAt: +new Date(`${date}T00:00:00`), dueAt: +new Date(`${date}T23:59:59`), remindHour, createdAt: now });
    const id = `${name}-${++sequence}`;
    plans.insertDays(db, plan.id, [{ id, seq: 1, day_date: date, content: name, items: [name], createdAt: now }]);
    return id;
  };
  return { db, now, user, sent, add };
}
test('spring transition reminds at the configured local 20:00 rather than 21:00', t => {
  const x = fixture(t, 'America/New_York', '2026-03-08', '20:00'), id = x.add('spring-due', 20);
  assert.deepEqual(scheduler.scanPhaseDays(x.db, x.now, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
  assert.equal(plans.dayById(x.db, id).remind_fired_at, x.now);
});
test('autumn transition filters not-yet-due hours before batch limit and reminds each at its local hour', t => {
  const x = fixture(t, 'America/New_York', '2026-11-01', '19:00');
  const later = x.add('a-later', 20), due = x.add('z-due', 19);
  assert.deepEqual(scheduler.scanPhaseDays(x.db, x.now, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
  assert.equal(plans.dayById(x.db, due).remind_fired_at, x.now);
  assert.equal(plans.dayById(x.db, later).remind_fired_at, null);
  const at20 = +new Date('2026-11-01T20:00:00');
  assert.deepEqual(scheduler.scanPhaseDays(x.db, at20, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
  assert.equal(plans.dayById(x.db, later).remind_fired_at, at20);
  assert.deepEqual(scheduler.scanPhaseDays(x.db, at20, { batchSize: 1 }), { planReminds: 0, planMissed: 0 });
});
for (const [label, date, clock, expected] of [
  ['spring due', '2026-03-08', '20:00', 1],
  ['autumn early', '2026-11-01', '19:00', 0],
  ['autumn due', '2026-11-01', '20:00', 1],
]) {
  test(`external delivery recheck observes local wall time for ${label}`, async t => {
    const x = fixture(t, 'America/New_York', date, clock), id = x.add(label, 20);
    notify.setNotifyConfig(x.db, { enabled: true, webhookUrl: 'https://notify.invalid/isolated-dst-test' });
    plans.markDayRemindFired(x.db, id, x.now);
    notify.deliver(x.db, { userId: x.user.id, recipientUser: x.user, kind: 'plan_remind', title: label, content: label, linkType: 'day', linkId: id });
    const queued = x.db.prepare('SELECT payload FROM notification_outbox').get();
    assert.equal(JSON.parse(queued.payload).reminderSnapshot.remindHour, 20);
    await notify.processOutbox(x.db, 1);
    assert.equal(x.sent.length, expected);
  });
}
for (const timezone of ['UTC', 'Asia/Shanghai']) {
  test(`${timezone} keeps ordinary 20:00 reminder boundaries unchanged`, t => {
    const x = fixture(t, timezone, '2026-03-08', '19:00'), id = x.add('ordinary-due', 20);
    assert.deepEqual(scheduler.scanPhaseDays(x.db, x.now, { batchSize: 1 }), { planReminds: 0, planMissed: 0 });
    const at20 = +new Date('2026-03-08T20:00:00');
    assert.deepEqual(scheduler.scanPhaseDays(x.db, at20, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
    assert.equal(plans.dayById(x.db, id).remind_fired_at, at20);
  });
}

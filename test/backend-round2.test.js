'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
process.env.TZ = 'Asia/Shanghai';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo');
let current, sequence = 0;
const deps = { notify: { deliver() {} }, security: { authenticate: () => ({ user: current }) } };
const router = require('../src/router').createRouter({ db, deps });
for (const name of ['notification', 'life', 'task', 'plan']) require(`../src/controllers/${name}.ctrl`).register(router, deps);
function user(role = 'supervisee') {
  return users.insert(db, { username: `round2-${++sequence}`, role, passwordHash: 'hash', salt: 'salt', createdAt: Date.now() });
}
function call(actor, method, url, body = {}, query = {}) {
  current = actor;
  let result;
  router.dispatch(method, url, { method, url, headers: {} }, {
    writeHead(status) { this.status = status; },
    end(text) { result = { status: this.status, ...JSON.parse(text) }; },
  }, query, body);
  return result;
}
function ok(...args) {
  const result = call(...args);
  assert.equal(result.status, 200, JSON.stringify(result));
  return result;
}

for (const resource of ['notifications', 'life']) {
  test(`${resource}: paginates beyond 500 records with deterministic timestamp ties and account isolation`, () => {
    const actor = user(), other = user();
    const expected = [];
    const sql = resource === 'notifications'
      ? "INSERT INTO notifications(id,user_id,kind,title,content,created_at) VALUES(?,?,'test','Reminder','Private body',1000)"
      : "INSERT INTO life_logs(id,user_id,log_date,content,created_at) VALUES(?,?,'2026-09-20','Private life',1000)";
    const insert = db.prepare(sql);
    for (let i = 0; i < 525; i++) {
      const id = actor.id + '-' + String(i).padStart(4, '0');
      expected.unshift(id);
      insert.run(id, actor.id);
    }
    insert.run(other.id + '-private', other.id);
    const key = resource === 'life' ? 'logs' : 'notifications';
    for (const limit of [100, 500]) {
      let offset = 0, ids = [];
      do {
        const page = ok(actor, 'GET', `/api/${resource}`, {}, { limit: String(limit), offset: String(offset) });
        assert.ok(page[key].length <= limit);
        ids.push(...page[key].map(row => row.id));
        if (resource === 'notifications') assert.equal(page.unread, 525);
        offset = page.nextOffset;
      } while (offset !== null);
      assert.deepEqual(ids, expected);
    }
    if (resource === 'notifications') {
      const poll = ok(actor, 'GET', '/api/notifications', {}, { limit: '20' });
      assert.equal(poll.notifications.length, 20);
      assert.equal(poll.nextOffset, 20);
      assert.equal(poll.unread, 525);
    }
    assert.equal(ok(actor, 'GET', `/api/${resource}`, {}, { offset: '9'.repeat(400) })[key].length, 0);
  });
}

test('life rejects malformed content, moods and impossible dates without persisting partial records', () => {
  const actor = user();
  const invalid = [
    {}, { content: {} }, { content: [] }, { content: 42 }, { content: ' \n ' }, { content: 'a'.repeat(10001) },
    { content: 'Valid', date: '2026-02-30' }, { content: 'Valid', date: '2026-13-01' },
    { content: 'Valid', date: '' }, { content: 'Valid', date: null }, { content: 'Valid', date: {} },
    { content: 'Valid', mood: {} }, { content: 'Valid', mood: 'x'.repeat(51) },
  ];
  for (const body of invalid) assert.equal(call(actor, 'POST', '/api/life', body).status, 400, JSON.stringify(body).slice(0, 100));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs WHERE user_id=?').get(actor.id).n, 0);
  const log = ok(actor, 'POST', '/api/life', { content: '  Leap day reflection  ', date: '2024-02-29', mood: ' 😊 ' }).log;
  assert.equal(log.content, 'Leap day reflection');
  assert.equal(log.date, '2024-02-29');
  assert.equal(log.mood, '😊');
});

test('life default date follows the configured local day after Shanghai midnight', t => {
  const actor = user();
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-20T17:15:00Z') });
  const log = ok(actor, 'POST', '/api/life', { content: 'After midnight' }).log;
  assert.equal(log.date, '2026-09-21');
});

test('life date filters work independently and invalid ranges return a client error', () => {
  const actor = user();
  for (const date of ['2026-09-18', '2026-09-19', '2026-09-20']) ok(actor, 'POST', '/api/life', { content: date, date });
  assert.deepEqual(ok(actor, 'GET', '/api/life', {}, { from: '2026-09-19' }).logs.map(row => row.date), ['2026-09-20', '2026-09-19']);
  assert.deepEqual(ok(actor, 'GET', '/api/life', {}, { to: '2026-09-19' }).logs.map(row => row.date), ['2026-09-19', '2026-09-18']);
  assert.equal(call(actor, 'GET', '/api/life', {}, { from: '2026-09-20', to: '2026-09-19' }).status, 400);
  assert.equal(call(actor, 'GET', '/api/life', {}, { to: '2026-02-30' }).status, 400);
});

test('task detail opens old notification targets and reports archived evidence as read only', () => {
  const actor = user(), stranger = user();
  const plan = ok(actor, 'POST', '/api/plans', { title: 'Old personal plan' }).plan;
  const task = ok(actor, 'POST', '/api/tasks', { title: 'Old evidence', planId: plan.id }).task;
  ok(actor, 'POST', `/api/tasks/${task.id}/checkin`, { note: 'Original completed work' });
  assert.equal(ok(actor, 'GET', `/api/tasks/${task.id}`).writable, true);
  ok(actor, 'POST', `/api/plans/${plan.id}/archive`);
  const ancient = Date.now() - 180 * 86400000;
  db.prepare('UPDATE tasks SET created_at=?,done_at=? WHERE id=?').run(ancient, ancient, task.id);
  assert.ok(!ok(actor, 'GET', '/api/tasks', {}, { window: 'recent' }).tasks.some(row => row.id === task.id));
  const detail = ok(actor, 'GET', `/api/tasks/${task.id}`);
  assert.equal(detail.task.checkinNote, 'Original completed work');
  assert.equal(detail.writable, false);
  assert.equal(call(stranger, 'GET', `/api/tasks/${task.id}`).status, 404);
  assert.equal(call(actor, 'GET', '/api/tasks/missing').status, 404);
});

test('shared task detail survives ending a relation without granting access to a new supervisor', () => {
  const supervisor = user('supervisor'), next = user('supervisor'), actor = user();
  for (const sup of [supervisor, next]) require('../src/repo/cooperation.repo').save(db, sup, sup.id, { state: 'active', capacity: 2, agreementRef: 'test', note: 'test', published: true });
  users.setRelations(db, actor.id, [supervisor.id]);
  const task = ok(supervisor, 'POST', '/api/tasks', { title: 'Shared evidence', assigneeId: actor.id }).task;
  assert.equal(ok(actor, 'GET', `/api/tasks/${task.id}`).writable, true);
  users.setRelations(db, actor.id, [next.id]);
  for (const participant of [supervisor, actor]) {
    const detail = ok(participant, 'GET', `/api/tasks/${task.id}`);
    assert.equal(detail.writable, false);
    assert.equal(detail.task.status, 'cancelled');
  }
  assert.equal(call(next, 'GET', `/api/tasks/${task.id}`).status, 404);
});
test.after(() => database.closeDb());

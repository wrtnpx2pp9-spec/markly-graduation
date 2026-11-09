'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const db = getDb();
const users = require('../src/repo/user.repo');
const current = users.insert(db, { username: 'summary-boundaries', role: 'supervisee', displayName: '统计测试', passwordHash: 'hash', salt: 'salt', createdAt: 0 });
const router = require('../src/router').createRouter({ db, deps: { security: { authenticate: () => ({ user: current }) } } });
require('../src/controllers/rank.ctrl').register(router);
const originalZone = process.env.TZ;

function freeze(t, zone, now) {
  process.env.TZ = zone;
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  t.after(() => { t.mock.timers.reset(); if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; });
}
function rank(dim = 'today') {
  let result;
  router.dispatch('GET', '/api/rank', { headers: {} }, { writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, ...JSON.parse(text) }; } }, { scope: 'all', dim }, {});
  assert.equal(result.status, 200);
  return result.list.find(row => row.id === current.id);
}
function task(id, due, done = null) {
  db.prepare('INSERT INTO tasks(id,title,creator_id,assignee_id,status,due_at,done_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, '统计任务', current.id, current.id, done === null ? 'pending' : 'done', Date.parse(due), done === null ? null : Date.parse(done), 0);
}
function planDay(id, date) {
  db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,status,created_at) VALUES(?,?,?,?,'active',0)").run(id, '统计计划', current.id, current.id);
  db.prepare("INSERT INTO plan_days(id,plan_id,seq,day_date,status,checkin_state,created_at) VALUES(?,?,1,?,'done','approved',0)").run(id + '-day', id, date);
}
test.beforeEach(() => db.exec('DELETE FROM tasks; DELETE FROM plan_days; DELETE FROM plans; DELETE FROM life_logs'));

test('排行榜春季短日排除次日凌晨任务', t => {
  freeze(t, 'America/New_York', '2026-03-08T16:00:00Z');
  task('next-day', '2026-03-09T04:30:00Z');
  assert.equal(rank().sub, '今日到期 0 · 完成 0');
});
test('排行榜秋季长日包含当天最后一小时任务', t => {
  freeze(t, 'America/New_York', '2026-11-01T17:00:00Z');
  task('late-today', '2026-11-02T04:30:00Z');
  assert.equal(rank().sub, '今日到期 1 · 完成 0');
});
test('排行榜近期范围固定为七个本地日历日', t => {
  freeze(t, 'America/New_York', '2026-03-10T16:00:00Z');
  planDay('out-of-window', '2026-03-03');
  planDay('window-start', '2026-03-04');
  assert.equal(rank('plan').recentTotal, 1);
});
test('排行榜同一天完成普通任务与执行日只计一个活跃日', t => {
  freeze(t, 'Asia/Shanghai', '2026-10-10T00:10:00Z');
  task('morning-task', '2026-10-10T00:05:00Z', '2026-10-10T00:05:00Z');
  planDay('same-day', '2026-10-10');
  const row = rank('checkin');
  assert.equal(row.recentDone, 2);
  assert.equal(row.recentActiveDays, 1);
});
test('排行榜两条完成时间跨 UTC 日期但同一本地日只计一次活跃', t => {
  freeze(t, 'Asia/Shanghai', '2026-10-10T04:00:00Z');
  task('before-utc-midnight', '2026-10-09T23:55:00Z', '2026-10-09T23:55:00Z');
  task('after-utc-midnight', '2026-10-10T00:05:00Z', '2026-10-10T00:05:00Z');
  assert.equal(rank('checkin').recentActiveDays, 1);
});
test('用户画像上海凌晨按本地日期包含今天已确认执行日', t => {
  freeze(t, 'Asia/Shanghai', '2026-10-09T16:10:00Z');
  planDay('today-portrait', '2026-10-10');
  assert.equal(require('../src/user-portrait').get(db, current.id).activity.activePlanDays.done, 1);
});
test('用户画像近十四天记录不截断为六十条且排除未来记录', t => {
  freeze(t, 'Asia/Shanghai', '2026-10-10T04:00:00Z');
  const insert = db.prepare('INSERT INTO life_logs(id,user_id,log_date,content,mood,created_at) VALUES(?,?,?,?,?,?)');
  for (let i = 0; i < 71; i++) insert.run('recent-' + i, current.id, '2026-10-10', '正文不得进入摘要', '平静', i);
  insert.run('future-life', current.id, '2026-10-11', '未来记录', '未来心情', 100);
  const portrait = require('../src/user-portrait').get(db, current.id);
  assert.equal(portrait.activity.lifeCheckins14d, 71);
  assert.deepEqual(portrait.activity.moods, ['平静']);
  assert.doesNotMatch(JSON.stringify(portrait), /正文不得进入摘要/);
});
test('用户画像生活记录的十四日窗口包含首日并排除前一天', t => {
  freeze(t, 'Asia/Shanghai', '2026-10-10T04:00:00Z');
  const insert = db.prepare('INSERT INTO life_logs(id,user_id,log_date,content,created_at) VALUES(?,?,?,?,0)');
  insert.run('life-window-start', current.id, '2026-09-27', '窗口首日');
  insert.run('life-before-window', current.id, '2026-09-26', '窗口之前');
  const portrait = require('../src/user-portrait').get(db, current.id);
  assert.equal(portrait.activity.lifeCheckins14d, 1);
  assert.equal(portrait.history.lifeCheckins, 2);
});
test.after(() => closeDb());

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-reminder-continuity-'));
process.env.DB_PATH = path.join(dir, 'app.db');
const { getDb, closeDb } = require('../src/db');
let db = getDb();
const users = require('../src/repo/user.repo');
const tasks = require('../src/repo/task.repo');
const plans = require('../src/repo/plan.repo');
const wechatRepo = require('../src/repo/wechat.repo');
const settings = require('../src/repo/setting.repo');
const scheduler = require('../src/scheduler');
const notify = require('../src/notify');
const nativeFetch = global.fetch;

function reset() {
  db.exec(`DELETE FROM notification_outbox; DELETE FROM notifications;
    DELETE FROM tasks; DELETE FROM plan_day_items; DELETE FROM plan_days; DELETE FROM plans;
    DELETE FROM supervision_relations; DELETE FROM supervision_periods; DELETE FROM users;
    DELETE FROM wechat_bindings; DELETE FROM wechat_deliveries; DELETE FROM daily_plan_proposals;`);
  notify.setNotifyConfig(db, { enabled: false });
  settings.set(db, 'wechat_ilink_config', JSON.stringify({ enabled: false }));
  notify.setWechat(null);
}
function person(id, role = 'supervisee', status = 1) {
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at,cooperation_state,agreement_ref,capacity_override) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, id, role, 'hash', 'salt', id, status, Date.now(), 'active', 'test-agreement', 10);
  return users.byId(db, id);
}
function task(id, creator = id, assignee = creator, dueAt = Date.now() - 1000) {
  return tasks.insert(db, { title: id, creatorId: creator, assigneeId: assignee, dueAt, remindBeforeMinutes: 0, status: 'pending', createdAt: dueAt - 1000, planId: null, note: '' });
}
function pair() {
  person('owner', 'supervisor'); person('worker');
  users.setRelations(db, 'worker', ['owner']);
}
function phase(id, creator, assignee, now) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const dayDate = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const plan = plans.insert(db, { title: id, creatorId: creator, assigneeId: assignee, kind: 'cycle', startAt: +start, dueAt: +start + 86400000, remindHour: 0, status: 'active', createdAt: now, description: '' });
  const dayId = id + '-day';
  plans.insertDays(db, plan.id, [{ id: dayId, seq: 1, day_date: dayDate, content: id, items: [id], createdAt: now }]);
  return { plan, dayId };
}

test.beforeEach(reset);

test('停用个人账号不消耗提醒标记，恢复后只补发一次', () => {
  person('personal', 'supervisee', 0);
  const row = task('personal');
  assert.deepEqual(scheduler.fire(db), { reminds: 0, overdue: 0, overdueEscalations: 0 });
  assert.equal(tasks.byId(db, row.id).remind_fired_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 0);
  users.setStatus(db, 'personal', 1);
  assert.deepEqual(scheduler.fire(db), { reminds: 1, overdue: 1, overdueEscalations: 0 });
  assert.deepEqual(scheduler.fire(db), { reminds: 0, overdue: 0, overdueEscalations: 0 });
});

test('失效账号、角色和合作批次在任务提醒限量前剔除，暂停新增服务仍提醒既有合作', () => {
  const now = Date.now();
  pair();
  const valid = task('valid', 'owner', 'worker', now - 100);
  db.prepare("UPDATE users SET cooperation_state='paused' WHERE id='owner'").run();
  person('disabled', 'supervisee', 0);
  const disabled = task('disabled', 'disabled', 'disabled', now - 10000);
  person('wrong-owner', 'supervisee'); person('wrong-worker');
  db.prepare("INSERT INTO supervision_relations(id,supervisor_id,supervisee_id,status,created_at) VALUES ('wrong-relation','wrong-owner','wrong-worker','active',0)").run();
  db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at) VALUES ('wrong-period','wrong-owner','wrong-worker',0)").run();
  const wrong = task('wrong', 'wrong-owner', 'wrong-worker', now - 9000);
  const ended = task('ended', 'owner', 'worker', now - 8000);
  db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at,ended_at) VALUES ('old-period','owner','worker',0,1)").run();
  db.prepare("UPDATE tasks SET cooperation_period_id='old-period' WHERE id=?").run(ended.id);
  assert.deepEqual(scheduler.fire(db, { batchSize: 1 }), { reminds: 1, overdue: 1, overdueEscalations: 0 });
  assert.ok(tasks.byId(db, valid.id).remind_fired_at);
  for (const row of [disabled, wrong, ended]) {
    assert.equal(tasks.byId(db, row.id).remind_fired_at, null, row.title);
    assert.equal(tasks.byId(db, row.id).overdue_fired_at, null, row.title);
    tasks.setOverdueFired(db, row.id, now - 86400001);
  }
  assert.deepEqual(tasks.listDueOverdueEscalation(db, now, 86400000, 1), []);
});

test('阶段日期限量前剔除停用账号和旧合作批次，恢复后继续提醒', () => {
  const now = Date.now();
  pair();
  person('disabled', 'supervisee', 0);
  const disabled = phase('a-disabled', 'disabled', 'disabled', now);
  const ended = phase('b-ended', 'owner', 'worker', now);
  db.prepare("INSERT INTO supervision_periods(id,supervisor_id,supervisee_id,started_at,ended_at) VALUES ('old-period','owner','worker',0,1)").run();
  db.prepare("UPDATE plans SET cooperation_period_id='old-period' WHERE id=?").run(ended.plan.id);
  const valid = phase('z-valid', 'owner', 'worker', now);
  db.prepare("UPDATE users SET cooperation_state='paused' WHERE id='owner'").run();
  assert.deepEqual(scheduler.scanPhaseDays(db, now, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
  assert.ok(plans.dayById(db, valid.dayId).remind_fired_at);
  assert.equal(plans.dayById(db, disabled.dayId).remind_fired_at, null);
  assert.equal(plans.dayById(db, ended.dayId).remind_fired_at, null);
  users.setStatus(db, 'disabled', 1);
  assert.deepEqual(scheduler.scanPhaseDays(db, now, { batchSize: 1 }), { planReminds: 1, planMissed: 0 });
  assert.deepEqual(scheduler.scanPhaseDays(db, now, { batchSize: 1 }), { planReminds: 0, planMissed: 0 });
});

function externalChannels(t) {
  const sent = [];
  global.fetch = async (url, opts) => { sent.push({ channel: 'global', payload: JSON.parse(opts.body) }); return { ok: true, body: { cancel: async () => {} } }; };
  notify.setNotifyConfig(db, { enabled: true, webhookUrl: 'https://notify.invalid/test' });
  settings.set(db, 'wechat_ilink_config', JSON.stringify({ enabled: true }));
  const manager = { userStatus: () => ({ hasCredentials: true }), sendToUser: async (_db, id, text) => { sent.push({ channel: 'wechat', id, text }); } };
  notify.setWechat(manager);
  for (const id of ['owner', 'worker']) wechatRepo.bindUserWxid(db, { userId: id, wxid: 'wx-' + id, contextToken: 'context-' + id });
  t.after(() => { global.fetch = nativeFetch; notify.setWechat(null); });
  return sent;
}

async function drainAll() {
  let sent = 0;
  for (let batch = 0; batch < 20; batch++) {
    const outcome = await notify.processOutbox(db);
    sent += outcome.sent;
    if (!outcome.scanned) return { sent };
  }
  assert.fail('independent reminder queue did not drain');
}

function renameThroughApi(modulePath, route, id, title) {
  let handler, response;
  require(modulePath).register({ add(method, path, fn) { if (method === 'PUT' && path === route) handler = fn; } }, { notify });
  const res = { writeHead(status) { this.status = status; }, end(body) { response = { status: this.status, body: JSON.parse(body) }; } };
  handler({ db, user: users.byId(db, 'worker'), params: { id }, body: { title }, res });
  assert.equal(response.status, 200);
  return response.body;
}

test('已入队任务催办在完成、停用、角色变更、解绑重绑或重新排期后跳过两个外部通道，历史站内通知保留', async t => {
  const changes = [
    ['submitted', row => tasks.setStatus(db, row.id, 'submitted', null, '证据')],
    ['disabled', () => users.setStatus(db, 'worker', 0)],
    ['role', () => users.update(db, 'owner', { role: 'supervisee' })],
    ['rebind', () => { users.setRelations(db, 'worker', []); users.setRelations(db, 'worker', ['owner']); }],
    ['reschedule', row => tasks.update(db, row.id, { title: row.title, note: '', assigneeId: 'worker', dueAt: Date.now() + 86400000, remindBeforeMinutes: 0 })],
  ];
  for (const [name, change] of changes) {
    reset(); pair();
    const sent = externalChannels(t);
    const row = task(name, 'owner', 'worker');
    scheduler.fire(db);
    const noteCount = db.prepare('SELECT COUNT(*) n FROM notifications').get().n;
    assert.equal(noteCount, 4);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n, 8);
    change(row);
    assert.equal((await drainAll()).sent, 0, name);
    assert.deepEqual(sent, [], name);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, noteCount, name);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='sent' AND last_error='skipped'").get().n, 8, name);
  }
});

test('已入队阶段提醒在归档、休息确认、提交或内容调整后停止外发，未失效提醒正常送达', async t => {
  const changes = [
    ['archived', x => db.prepare("UPDATE plans SET status='archived' WHERE id=?").run(x.plan.id)],
    ['rest', x => db.prepare("UPDATE plan_days SET checkin_state='cancelled' WHERE id=?").run(x.dayId)],
    ['submitted', x => plans.submitDay(db, x.dayId, '完成', '')],
    ['content', x => db.prepare("UPDATE plan_days SET content='重新协商的内容',remind_fired_at=NULL WHERE id=?").run(x.dayId)],
    ['hour', x => db.prepare('UPDATE plans SET remind_hour=23 WHERE id=?').run(x.plan.id)],
  ];
  for (const [name, change] of changes) {
    reset(); pair();
    const sent = externalChannels(t);
    const x = phase(name, 'owner', 'worker', Date.now());
    scheduler.scanPhaseDays(db);
    change(x);
    assert.equal((await drainAll()).sent, 0, name);
    assert.deepEqual(sent, [], name);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 2, name);
  }
  reset(); pair();
  const sent = externalChannels(t);
  phase('valid', 'owner', 'worker', Date.now());
  scheduler.scanPhaseDays(db);
  db.prepare("UPDATE users SET cooperation_state='paused' WHERE id='owner'").run();
  assert.equal((await drainAll()).sent, 4);
  assert.equal(sent.length, 4);
});

test('个人任务和阶段在基础角色转换后仍持续提醒，webhook 使用当前身份', async t => {
  pair();
  const sent = externalChannels(t);
  task('personal', 'worker', 'worker');
  phase('personal-phase', 'worker', 'worker', Date.now());
  scheduler.fire(db); scheduler.scanPhaseDays(db);
  users.update(db, 'worker', { role: 'supervisor' });
  assert.equal((await drainAll()).sent, 6);
  assert.equal(sent.length, 6);
  assert.ok(sent.filter(x => x.channel === 'global').every(x => x.payload.recipient.role === 'supervisor'));
});

test('真实 PUT 改名保留个人任务和阶段提醒标记，已入队外发使用当前标题且仅一次', async t => {
  pair();
  const sent = externalChannels(t);
  const row = task('原任务标题', 'worker', 'worker');
  const x = phase('原阶段标题', 'worker', 'worker', Date.now());
  scheduler.fire(db); scheduler.scanPhaseDays(db);
  const taskBefore = tasks.byId(db, row.id);
  const dayBefore = plans.dayById(db, x.dayId);
  renameThroughApi('../src/controllers/task.ctrl', '/api/tasks/:id', row.id, '改名后任务');
  renameThroughApi('../src/controllers/plan.ctrl', '/api/plans/:id', x.plan.id, '改名后阶段');
  assert.equal(tasks.byId(db, row.id).remind_fired_at, taskBefore.remind_fired_at);
  assert.equal(tasks.byId(db, row.id).overdue_fired_at, taskBefore.overdue_fired_at);
  assert.equal(plans.dayById(db, x.dayId).remind_fired_at, dayBefore.remind_fired_at);
  assert.equal((await drainAll()).sent, 6);
  assert.equal(sent.length, 6);
  for (const delivery of sent) {
    const title = delivery.channel === 'global' ? delivery.payload.title : delivery.text.split('\n')[0];
    assert.match(title, /改名后任务|改名后阶段/);
  }
  assert.equal((await notify.processOutbox(db)).scanned, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications').get().n, 3);
});

test('webhook 等待期间角色和标题变化后命令使用当前内容，停用账号阻止第二次外部操作', async t => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const commands = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.kill = () => {};
    child.stdin = new EventEmitter();
    child.stdin.write = value => commands.push(JSON.parse(value));
    child.stdin.end = () => queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  const notifyPath = require.resolve('../src/notify');
  const previousModule = require.cache[notifyPath];
  delete require.cache[notifyPath];
  const commandNotify = require('../src/notify');
  require.cache[notifyPath] = previousModule;
  t.after(() => { childProcess.spawn = originalSpawn; global.fetch = nativeFetch; });
  for (const mode of ['rename', 'disable']) {
    reset(); person('worker');
    commandNotify.setNotifyConfig(db, { enabled: true, webhookUrl: 'https://notify.invalid/test', command: 'mock-command' });
    const row = task('等待前标题', 'worker', 'worker', Date.now() + 60000);
    tasks.update(db, row.id, { title: row.title, note: '', assigneeId: 'worker', dueAt: row.due_at, remindBeforeMinutes: 30 });
    scheduler.fire(db);
    global.fetch = async () => {
      if (mode === 'rename') {
        renameThroughApi('../src/controllers/task.ctrl', '/api/tasks/:id', row.id, '等待后标题');
        users.update(db, 'worker', { role: 'supervisor' });
      } else users.setStatus(db, 'worker', 0);
      return { ok: true, body: { cancel: async () => {} } };
    };
    assert.equal((await commandNotify.processOutbox(db)).sent, 1);
    assert.equal(commands.length, 1, mode);
    assert.match(commands[0].title, /等待后标题/);
    assert.equal(commands[0].recipient.role, 'supervisor');
  }
});

test('提醒快照跨 SQLite 重启仍有效，终态历史反馈继续投递，旧无快照队列仍校验停用账号', async t => {
  pair();
  externalChannels(t);
  const valid = task('valid', 'owner', 'worker');
  const stale = task('stale', 'owner', 'worker');
  scheduler.fire(db);
  tasks.setStatus(db, stale.id, 'done', Date.now(), '已确认');
  closeDb(); db = getDb();
  const sent = externalChannels(t);
  assert.equal((await drainAll()).sent, 8);
  assert.equal(sent.length, 8);
  assert.ok(sent.filter(x => x.channel === 'global').every(x => x.payload.link.id === valid.id));
  notify.deliver(db, { userId: 'worker', recipientUser: users.byId(db, 'worker'), kind: 'task_review', title: '已完成任务的确认反馈', content: '历史保留', linkType: 'task', linkId: stale.id });
  assert.equal((await drainAll()).sent, 2);
  db.prepare("INSERT INTO notification_outbox(id,channel,payload,status,next_attempt_at,created_at) VALUES ('legacy-disabled','global',?,'pending',0,?)")
    .run(JSON.stringify({ recipient: { id: 'worker', role: 'supervisee' }, kind: 'task_remind', title: valid.title, link: { type: 'task', id: valid.id } }), Date.now());
  users.setStatus(db, 'worker', 0);
  assert.equal((await drainAll()).sent, 0);
  assert.equal(db.prepare("SELECT last_error FROM notification_outbox WHERE id='legacy-disabled'").get().last_error, 'skipped');
});

test.after(() => {
  global.fetch = nativeFetch; notify.setWechat(null); closeDb();
  const target = path.resolve(dir);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith('markly-reminder-continuity-'));
  fs.rmSync(target, { recursive: true, force: true });
});

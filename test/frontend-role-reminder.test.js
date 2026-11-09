'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = name => fs.readFileSync(`public/js/${name}.js`, 'utf8');
function client(packets = []) {
  const sent = [], controls = new Map();
  function Notification(title, options) { sent.push({ title, ...options }); }
  Notification.permission = 'granted';
  const context = vm.createContext({
    document: { hidden: false, getElementById: () => null, querySelectorAll: () => [], addEventListener() {}, querySelector: selector => controls.get(selector) },
    window: { Notification, addEventListener() {} }, Notification,
    localStorage: { removeItem() {} }, sessionStorage: { getItem: () => null },
    setInterval: () => 1, clearInterval() {},
    fetch: async () => ({ ok: true, status: 200, json: async () => packets.shift() }),
  });
  vm.runInContext(source('core') + '\n' + source('auth'), context);
  vm.runInContext("token='session-a';me={id:'a',role:'supervisee',identity:'mentee',displayName:'执行人',username:'member'};", context);
  return { context, controls, sent, run: code => vm.runInContext(code, context) };
}
const packet = rows => ({ notifications: rows, unread: rows.filter(row => !row.isRead).length, nextOffset: null });
const note = (id, createdAt, isRead = false) => ({ id, createdAt, isRead, title: id, content: '隔离提醒' });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

for (const [role, identity, label] of [['supervisor', 'mentor', 'Mentor'], ['supervisee', 'mentee', 'Mentee']]) {
  test(`${label}在提醒设置仍显示注册时身份`, () => {
    const c = client();
    c.run(source('settings'));
    c.run(`me.role='${role}';me.identity='${identity}';loadWxBindCard=()=>{};`);
    for (const id of ['cfg-save', 'settings-back']) c.controls.set('#' + id, { closest: () => ({ remove() {} }) });
    const panel = { innerHTML: '' };
    c.context.renderSettings(panel);
    assert.match(panel.innerHTML, new RegExp(`<span class="roletag">${label}</span>`));
  });
}

test('任务提前0分钟提醒不会显示成默认30分钟', () => {
  const c = client();
  c.run(source('tasks'));
  const markup = c.context.renderTaskList([{ id: 'at-due', title: '到时提醒', remindBeforeMinutes: 0, status: 'pending' }], 'dashboard');
  assert.match(markup, /提前0分钟提醒/);
});

test('初次通知为空后首条新提醒可以弹出，重复读取不会重复弹出', async () => {
  const incoming = note('first', 10);
  const c = client([packet([]), packet([incoming]), packet([incoming])]);
  await c.run('loadNotes()');
  assert.equal(c.sent.length, 0);
  await c.run('_pollTimer=1;pollNotifications()');
  await c.run('pollNotifications()');
  assert.deepEqual(c.sent.map(row => row.title), ['first']);
});

test('同毫秒新通知由ID区分且不会重复提醒', async () => {
  const old = note('first', 20), later = note('second', 20);
  const c = client([packet([old]), packet([later, old]), packet([later, old])]);
  await c.run('loadNotes()');
  await c.run('_pollTimer=1;pollNotifications()');
  await c.run('loadNotes()');
  assert.deepEqual(c.sent.map(row => row.title), ['second']);
});

test('已经在其他设备阅读的新通知不再弹桌面提醒', async () => {
  const c = client([packet([note('baseline', 10)]), packet([note('read-elsewhere', 30, true)])]);
  await c.run('loadNotes()');
  await c.run('_pollTimer=1;pollNotifications()');
  assert.deepEqual(c.sent, []);
});

test('加载历史消息不会补弹提醒或倒退当前通知水位', async () => {
  const c = client([packet([note('current', 100)]), packet([note('old', 10)]), packet([note('later', 101), note('current', 100)])]);
  await c.run('loadNotes()');
  await c.run('loadNotes(100)');
  assert.equal(c.run('st.lastSeenNoteAt'), 100);
  assert.equal(c.sent.length, 0);
  await c.run('_pollTimer=1;pollNotifications()');
  assert.deepEqual(c.sent.map(row => row.title), ['later']);
});

test('换账号后重新建立提醒水位，初次历史不弹且该账号首条提醒可弹', async () => {
  const c = client([packet([note('a-old', 10)]), packet([]), packet([note('b-first', 10)])]);
  c.run('closeModal=()=>{}');
  await c.run('loadNotes()');
  c.run("logoutLocal();token='session-b';me={id:'b',role:'supervisor',identity:'mentor'};");
  await c.run('loadNotes()');
  await c.run('_pollTimer=1;pollNotifications()');
  assert.deepEqual(c.sent.map(row => row.title), ['b-first']);
});

test('迟到轮询不能把较新消息页已经读取的通知恢复为未读', async () => {
  const gate = deferred(), unread = note('same-note', 100);
  const c = client([packet([unread]), gate.promise, packet([note('same-note', 100, true)])]);
  await c.run('loadNotes()');
  const polling = c.run('_pollTimer=1;pollNotifications()');
  await c.run('loadNotes()');
  gate.resolve(packet([unread]));
  await polling;
  assert.equal(c.run('unread'), 0);
  assert.equal(c.run('st.notes[0].isRead'), true);
});

test('迟到消息首页不能覆盖较新轮询的未读状态', async () => {
  const gate = deferred(), unread = note('same-note', 100);
  const c = client([packet([unread]), gate.promise, packet([note('same-note', 100, true)])]);
  await c.run('loadNotes()');
  const loading = c.run('loadNotes()');
  await c.run('_pollTimer=1;pollNotifications()');
  gate.resolve(packet([unread, note('outside-poll-window', 10, true)]));
  await loading;
  assert.equal(c.run('unread'), 0);
  assert.equal(c.run('st.notes[0].isRead'), true);
  assert.equal(c.run("st.notes.some(row=>row.id==='outside-poll-window')"), true);
});

test('历史分页迟到仍加入旧消息，但不会覆盖较新轮询的已读状态和徽标', async () => {
  const gate = deferred(), unread = note('same-note', 100);
  const c = client([packet([unread]), gate.promise, packet([note('same-note', 100, true)])]);
  await c.run('loadNotes()');
  const history = c.run('loadNotes(100)');
  await c.run('_pollTimer=1;pollNotifications()');
  gate.resolve(packet([unread, note('old-page', 10, true)]));
  await history;
  assert.equal(c.run('unread'), 0);
  assert.equal(c.run("st.notes.find(row=>row.id==='same-note').isRead"), true);
  assert.equal(c.run("st.notes.some(row=>row.id==='old-page')"), true);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

const source = name => fs.readFileSync(`public/js/${name}.js`, 'utf8');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function client(fetch) {
  const context = vm.createContext({
    document: { getElementById: () => null, querySelectorAll: () => [], hidden: false, addEventListener() {} },
    localStorage: { removeItem() {} }, sessionStorage: { getItem: () => null },
    fetch, setInterval: () => ({}), clearInterval() {},
  });
  vm.runInContext(source('core') + '\n' + source('auth'), context);
  vm.runInContext("closeModal=()=>{};renderLogin=()=>{};token='account-a';me={id:'a',role:'supervisee'};", context);
  return { context, run: code => vm.runInContext(code, context) };
}
function response(data, status = 200) {
  return { ok: status === 200, status, json: async () => data };
}

test('同批成功响应与401交错时退出后不能写回旧任务计划和每日安排', async () => {
  const gate = deferred();
  const c = client(async path => ({
    ok: path !== '/api/expired', status: path === '/api/expired' ? 401 : 200,
    json: () => path.includes('worklist') ? gate.promise.then(() => ({ days: [{ id: 'private-a-day' }] }))
      : path === '/api/expired' ? gate.promise.then(() => ({ error: 'expired' }))
      : Promise.resolve(path.includes('/tasks') ? { tasks: [{ id: 'private-a-task' }], nextOffset: null }
        : { plans: [{ id: 'private-a-plan' }], nextOffset: null }),
  }));
  const loading = c.run('loadSection()'), expired = c.run("api('GET','/api/expired')");
  await flush(); gate.resolve();
  await Promise.allSettled([loading, expired]);

  assert.equal(c.run('me'), null);
  assert.equal(c.run('st.tasks.length + st.plans.length + st.workDays.length'), 0);
});

for (const [loader, payload, key] of [
  ['loadNotes()', { notifications: [{ id: 'private-a-note', createdAt: 1 }], unread: 1, nextOffset: null }, 'notes'],
  ['loadLife()', { logs: [{ id: 'private-a-life', content: '旧账号私人日记' }], nextOffset: null }, 'logs'],
]) test(`${loader}成功响应与401交错时不能回填退出后的私有列表`, async () => {
  const gate = deferred();
  const c = client(async path => ({ ok: path !== '/api/expired', status: path === '/api/expired' ? 401 : 200,
    json: () => gate.promise.then(() => path === '/api/expired' ? { error: 'expired' } : payload) }));
  const loading = c.run(loader), expired = c.run("api('GET','/api/expired')");
  await flush(); gate.resolve();
  await Promise.allSettled([loading, expired]);

  assert.equal(c.run('me'), null);
  assert.equal(c.run(`st.${key}.length`), 0);
  assert.equal(c.run('unread'), 0);
});

test('loadAll的已完成身份响应不能在另一请求退出后恢复旧账号', async () => {
  const gate = deferred(), people = deferred();
  const c = client(async path => {
    if (path === '/api/people') return people.promise;
    return { ok: path !== '/api/expired', status: path === '/api/expired' ? 401 : 200,
      json: () => gate.promise.then(() => path === '/api/expired' ? { error: 'expired' }
        : { user: { id: 'a', role: 'supervisee' }, unread: 1 }) };
  });
  const loading = c.run('loadAll()'), expired = c.run("api('GET','/api/expired')");
  await flush(); gate.resolve(); await flush();
  try { assert.equal(c.run('me'), null); }
  finally {
    people.resolve(response({ people: [] }, 401));
    await Promise.allSettled([loading, expired]);
  }
});

test('旧账号请求网络失败不能覆盖新账号的网络提示', async () => {
  const gate = deferred(), shown = [];
  const c = client(() => gate.promise);
  c.context.showNetworkStatus = message => shown.push(message);
  const request = c.run("api('GET','/api/life')");
  c.run("token='account-b';me={id:'b',role:'supervisee'};");
  gate.reject(Error('isolated disconnect'));

  await assert.rejects(request, error => error.code === 'session_changed');
  assert.deepEqual(shown, []);
});

test('换账号不会被旧通知轮询阻塞且旧轮询结束不能解除新轮询的并发锁', async () => {
  const requests = [];
  const c = client(() => { const gate = deferred(); requests.push(gate); return gate.promise; });
  c.run('startPolling()');
  c.run("logoutLocal();setToken('',{id:'b',role:'supervisee'});");
  assert.equal(requests.length, 2, '新账号需要立即发起自己的通知读取');
  requests[0].resolve(response({ notifications: [{ id: 'old-a', createdAt: 1 }], unread: 1 }));
  await flush();
  await c.run('pollNotifications()');
  assert.equal(requests.length, 2, '旧账号 finally 不能清除新账号正在读取的锁');
  requests[1].resolve(response({ notifications: [{ id: 'new-b', createdAt: 2 }], unread: 1 }));
  await flush();
  assert.equal(c.run('st.notes[0].id'), 'new-b');
  c.run('logoutLocal()');
});

test('旧启动任务失败不能覆盖已经登录的新账号页面', async () => {
  const gate = deferred(), entered = deferred(), app = { innerHTML: '' }, retry = {};
  const context = vm.createContext({ $app: app,
    document: { getElementById: id => id === 'startup-retry' ? retry : null }, esc: String,
    token: 'account-a', me: { id: 'a' }, networkOnline: true,
    api: async (_method, path) => path === '/api/status' ? { bootstrapped: true } : { user: { id: 'a' } },
    setToken() {}, loadAll: async () => { entered.resolve(); await gate.promise; },
    routeProfileHash() {}, startPolling() {}, clearNetworkStatus() {}, renderSetup() {}, renderLogin() {},
  });
  vm.runInContext(source('boot'), context);
  await entered.promise;
  context.token = 'account-b'; context.me = { id: 'b' }; app.innerHTML = '新账号页面';
  gate.reject(Error('会话已变化，请重新打开页面')); await flush();

  assert.equal(app.innerHTML, '新账号页面');
});

function notesClient() {
  const buttons = new Map(['notif-read', 'notif-perm'].map(id => ['#' + id, { disabled: false, textContent: '', isConnected: true }]));
  const requests = [], messages = [], state = { view: 'notes', notes: [{ id: 'old', title: '旧通知', content: '', isRead: false, createdAt: 10 }], notesNextOffset: 200, lastSeenNoteAt: 10 };
  const panel = { isConnected: true, set innerHTML(_markup) {}, querySelectorAll: () => [] };
  const context = vm.createContext({ st: state, token: 'account-a', me: { id: 'a' }, unread: 1, notesReadRevision: 0,
    esc: String, fmtTime: () => '', updateBadge() {}, maybeDesktopNotify() {}, toast: message => messages.push(message),
    $: selector => buttons.get(selector), window: {},
    mergeNotes: (a, b) => [...new Map([...a, ...b].map(row => [row.id, row])).values()],
    api: (method, path) => { const gate = deferred(); requests.push({ ...gate, method, path }); return gate.promise; },
  });
  vm.runInContext(source('auth') + '\n' + source('notes'), context);
  context.renderNotes(panel);
  return { context, state, requests, messages, read: buttons.get('#notif-read') };
}

test('全部已读只乐观更新提交快照并刷新新消息的真实未读状态', async () => {
  const c = notesClient(), saving = c.read.onclick();
  c.state.notes.push({ id: 'arrived-later', title: '后来到达', createdAt: 20, isRead: false });
  c.context.unread = 2;
  c.requests[0].resolve({ ok: true }); await flush();
  assert.equal(c.context.unread, 1);
  assert.equal(c.state.notes.find(row => row.id === 'arrived-later').isRead, false);
  assert.equal(c.requests.length, 2);
  assert.equal(c.requests[1].method, 'GET');
  c.requests[1].resolve({ notifications: [{ id: 'arrived-later', createdAt: 20, isRead: false }], unread: 1, nextOffset: 100 });
  await saving;

  assert.equal(c.context.unread, 1);
  assert.equal(c.state.notes.find(row => row.id === 'arrived-later').isRead, false);
  assert.equal(c.state.notes.find(row => row.id === 'old').isRead, true);
  assert.equal(c.state.notesNextOffset, 200, '刷新应保留已加载旧页的翻页位置');
});

test('全部已读后的刷新失败保留后来未读消息且重试只读取不重复提交', async () => {
  const c = notesClient(), saving = c.read.onclick();
  c.state.notes.push({ id: 'arrived-later', createdAt: 20, isRead: false }); c.context.unread = 2;
  c.requests[0].resolve({ ok: true }); await flush();
  assert.equal(c.requests.length, 2);
  c.requests[1].reject(Error('isolated read unavailable')); await saving;
  assert.equal(c.context.unread, 1);
  assert.equal(c.state.notes.find(row => row.id === 'arrived-later').isRead, false);
  assert.match(c.read.textContent, /重试.*状态/);
  assert.match(c.messages.at(-1), /已.*标记.*状态.*刷新/);
  const retry = c.read.onclick();
  assert.equal(c.requests[2].method, 'GET');
  c.requests[2].resolve({ notifications: c.state.notes, unread: 1, nextOffset: null }); await retry;
  assert.equal(c.requests.filter(request => request.method === 'POST').length, 1);
});

test('轮询已更新服务器未读数时保守标记不能扣掉后来消息的唯一未读数', async () => {
  const c = notesClient(), saving = c.read.onclick();
  c.state.notes.push({ id: 'arrived-later', createdAt: 20, isRead: false });
  c.context.unread = 1; // The server already marked the old page; its cached row is still stale.
  c.requests[0].resolve({ ok: true }); await flush();
  try {
    assert.equal(c.context.unread, 1);
    assert.equal(c.state.notes.find(row => row.id === 'arrived-later').isRead, false);
  } finally {
    c.requests[1].reject(Error('isolated read unavailable'));
    await saving;
  }
});

for (const outcome of ['success', 'failure']) test(`旧账号全部已读的迟到${outcome}不能修改新账号消息或读取修订号`, async () => {
  const c = notesClient(), saving = c.read.onclick();
  c.context.token = 'account-b'; c.context.me = { id: 'b' };
  c.state.notes = [{ id: 'b-only', createdAt: 30, isRead: false }]; c.context.unread = 1;
  const revision = c.context.notesReadRevision;
  if (outcome === 'success') c.requests[0].resolve({ ok: true });
  else c.requests[0].reject(Error('old account failure'));
  await saving;

  assert.equal(c.state.notes[0].isRead, false);
  assert.equal(c.context.unread, 1);
  assert.equal(c.context.notesReadRevision, revision);
  assert.deepEqual(c.messages, []);
});

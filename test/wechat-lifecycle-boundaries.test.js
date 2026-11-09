'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.DB_PATH = ':memory:';
const { getDb, closeDb } = require('../src/db');
const { createWechat } = require('../src/wechat');
const wechatRepo = require('../src/repo/wechat.repo');
const { MockIlinkServer } = require('../src/wechat/mock-server');
const db = getDb();

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-wechat-lifecycle-'));
  const userId = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,'supervisee','hash','salt','隔离微信用户',1,?)").run(userId, userId, Date.now());
  const manager = createWechat(db, { stateDir: dir });
  await manager.setConfig({ enabled: true, mode: 'mock' });
  const instance = manager.userInstance(userId);
  t.after(async () => {
    await manager.stop();
    db.prepare('DELETE FROM wechat_bindings WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM wechat_bot_instances WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM users WHERE id=?').run(userId);
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('markly-wechat-lifecycle-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { manager, instance, userId };
}

function seedQr(instance, userId, key = 'isolated-old-qr') {
  const qr = { qrcodeKey: key, qrcodeContent: key, createdAt: Date.now() };
  instance.writeJson('qrcode.json', qr);
  db.prepare("INSERT INTO wechat_bot_instances(user_id,mode,connection_state,updated_at,created_at) VALUES (?,'mock','awaiting_scan',?,?)").run(userId, qr.createdAt, qr.createdAt);
  return qr;
}

function holdConfirmation(instance) {
  const entered = deferred();
  const gate = deferred();
  let pollStarts = 0;
  instance.startPolling = () => { pollStarts++; };
  instance.client = async () => ({
    getQrcodeStatus: async () => {
      entered.resolve();
      await gate.promise;
      return { confirmed: true, credentials: { botToken: 'isolated-late-token' } };
    },
    getBotQrcode: async () => ({ qrcodeKey: 'isolated-new-qr', qrcodeContent: 'isolated-new-qr', createdAt: Date.now() }),
  });
  return { entered, gate, pollStarts: () => pollStarts };
}

test('解绑完成后迟到的扫码确认不能恢复凭据或启动轮询', async t => {
  const { manager, instance, userId } = await fixture(t);
  seedQr(instance, userId);
  const held = holdConfirmation(instance);
  const refresh = manager.refreshUserBinding(userId);
  await held.entered.promise;
  await manager.selfUnbind(userId);
  held.gate.resolve();
  await refresh;

  assert.equal(instance.credentials(), null);
  assert.equal(instance.qr(), null);
  assert.equal(held.pollStarts(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM wechat_bot_instances WHERE user_id=?').get(userId).n, 0);
});

test('新二维码替换后旧扫码确认不能覆盖新绑定流程', async t => {
  const { manager, instance, userId } = await fixture(t);
  seedQr(instance, userId);
  const held = holdConfirmation(instance);
  const refresh = manager.refreshUserBinding(userId);
  await held.entered.promise;
  await manager.startUserBinding(userId, true);
  held.gate.resolve();
  await refresh;

  assert.equal(instance.credentials(), null);
  assert.equal(instance.qr().qrcodeKey, 'isolated-new-qr');
  assert.equal(held.pollStarts(), 0);
});

test('获取二维码的旧请求在解绑完成后不能重建二维码文件', async t => {
  const { manager, instance, userId } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  instance.client = async () => ({ getBotQrcode: async () => {
    entered.resolve();
    await gate.promise;
    return { qrcodeKey: 'isolated-late-qr', qrcodeContent: 'isolated-late-qr', createdAt: Date.now() };
  } });
  const binding = manager.startUserBinding(userId);
  await entered.promise;
  await manager.selfUnbind(userId);
  gate.resolve();
  await binding;

  assert.equal(instance.qr(), null);
  assert.equal(instance.credentials(), null);
});

test('扫码确认等待期间本地二维码过期后不能接受迟到凭据', async t => {
  const { manager, instance, userId } = await fixture(t);
  const qr = seedQr(instance, userId);
  const held = holdConfirmation(instance);
  const refresh = manager.refreshUserBinding(userId);
  await held.entered.promise;
  const originalNow = Date.now;
  try {
    Date.now = () => qr.createdAt + 5 * 60 * 1000;
    held.gate.resolve();
    await refresh;
  } finally {
    Date.now = originalNow;
  }
  assert.equal(instance.credentials(), null);
  assert.equal(held.pollStarts(), 0);
});

test('遗留轮询租约拒绝时不会阻塞定时器且退避可以停止', async t => {
  const { instance } = await fixture(t);
  instance.writeJson('credentials.json', { bot_token: 'isolated-token' });
  const originalCredentials = instance.credentials.bind(instance);
  let credentialChecks = 0;
  let updateCalls = 0;
  instance.credentials = () => { credentialChecks++; return originalCredentials(); };
  instance.client = async () => ({ getUpdates: async () => {
    updateCalls++;
    instance.stopped = true;
    return { messages: [], cursor: 'isolated-cursor' };
  } });
  db.prepare('INSERT INTO scheduler_leases(name,owner,locked_until) VALUES (?,?,?)').run(instance.leaseName, 'isolated-crashed-owner', Date.now() + 300);
  const timer = new Promise(resolve => setTimeout(() => resolve(updateCalls), 20));
  instance.startPolling();
  const updatesBeforeTimer = await timer;
  await instance.stop();

  assert.equal(updatesBeforeTimer, 0, '定时器应在旧租约过期前执行');
  assert.ok(credentialChecks <= 3, '租约拒绝必须退避，不能反复读取凭据和争用 SQLite');
  assert.equal(instance.pollPromise, null);
});

test('停止必须等在途轮询结束且丢弃停止后迟到的入站消息', async t => {
  const { instance, userId } = await fixture(t);
  instance.writeJson('credentials.json', { bot_token: 'isolated-token' });
  const entered = deferred();
  const gate = deferred();
  instance.client = async () => ({ getUpdates: async () => {
    entered.resolve();
    await gate.promise;
    return { messages: [{ fromUserId: 'isolated-wxid', contextToken: 'isolated-context', text: '1' }], cursor: 'isolated-late-cursor' };
  } });
  instance.startPolling();
  await entered.promise;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const stopping = instance.stop().then(() => { settled = true; });
  try {
    t.mock.timers.tick(2001);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled, false, '不能以超时 race 代替真正停止轮询');
  } finally {
    gate.resolve();
    await stopping;
    if (instance.pollPromise) await instance.pollPromise;
    t.mock.timers.reset();
  }
  assert.equal(wechatRepo.getByUserId(db, userId), null);
  assert.equal(instance.readText('cursor.txt'), '');
});

test('管理器开始停机后迟到扫码结果及新绑定请求不能重启轮询', async t => {
  const { manager, instance, userId } = await fixture(t);
  seedQr(instance, userId);
  const held = holdConfirmation(instance);
  const refresh = manager.refreshUserBinding(userId);
  await held.entered.promise;
  await manager.stop();
  held.gate.resolve();
  await refresh;

  assert.equal(instance.credentials(), null);
  assert.equal(held.pollStarts(), 0);
  await assert.rejects(manager.startUserBinding(userId), error => error.code === 'ILINK_STOPPED');
});

test('停止等待尚未完成的模拟客户端启动并关闭迟到服务', async t => {
  const { manager, instance, userId } = await fixture(t);
  const entered = deferred();
  const gate = deferred();
  const originalStart = MockIlinkServer.prototype.start;
  const originalStop = MockIlinkServer.prototype.stop;
  MockIlinkServer.prototype.start = async function () {
    entered.resolve();
    await gate.promise;
    this.server = {};
    this.url = 'http://127.0.0.1:1';
    return this;
  };
  MockIlinkServer.prototype.stop = async function () { this.server = null; };
  const binding = manager.startUserBinding(userId);
  await entered.promise;
  let settled = false;
  const stopping = manager.stop().then(() => { settled = true; });
  try {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(settled, false, '未完成的客户端启动仍属于本实例生命周期');
  } finally {
    gate.resolve();
    await Promise.all([binding, stopping]);
    MockIlinkServer.prototype.start = originalStart;
    MockIlinkServer.prototype.stop = originalStop;
  }
  assert.equal(instance.mock.running, false);
  assert.equal(instance.qr(), null);
});

test('停用与重新启用交错时等待旧轮询结束再启动新轮询', async t => {
  const { manager, instance } = await fixture(t);
  instance.writeJson('credentials.json', { bot_token: 'isolated-token' });
  const entered = deferred();
  const gate = deferred();
  let updateCalls = 0;
  instance.client = async () => ({ getUpdates: async ({ signal }) => {
    if (++updateCalls === 1) {
      entered.resolve();
      await gate.promise;
    } else {
      await new Promise(resolve => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', resolve, { once: true });
      });
    }
    return { messages: [], cursor: 'isolated-cursor' };
  } });
  instance.startPolling();
  await entered.promise;
  const disabling = manager.setConfig({ enabled: false });
  const enabling = manager.setConfig({ enabled: true });
  gate.resolve();
  await Promise.all([disabling, enabling]);
  for (let i = 0; i < 5; i++) await Promise.resolve();

  assert.equal(manager.getConfig().enabled, true);
  assert.ok(instance.pollPromise, '最终配置启用时轮询不能因旧 stop 未结束而遗漏重启');
  assert.equal(updateCalls, 2);
});

test.after(() => closeDb());

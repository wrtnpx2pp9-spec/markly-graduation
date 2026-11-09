'use strict';
/**
 * 微信 iLink 通知通道（Markly内部实现，接口由控制器暴露）。
 * 职责：
 *   1) 机器人扫码绑定（真实 iLink 或本地模拟服务）
 *   2) 每个账号独立机器人完成扫码后，用户发送数字 1 绑定并持续刷新 context_token
 *   3) 主动推送：向已绑定用户发送文本提醒（to_user_id + context_token）
 * 配置存在 settings.wechat_ilink_config：
 *   { enabled: bool, mode: 'mock'|'real', mockUrl: 自动记录 }
 */
const crypto = require('crypto');
const userRepo = require('../repo/user.repo');
const settingRepo = require('../repo/setting.repo');
const wechatRepo = require('../repo/wechat.repo');
const state = require('./state');
const { IlinkClient, DEFAULT_BASE_URL, httpJsonRequest } = require('./client');
const { MockIlinkServer } = require('./mock-server');
const { qrcodeSvg } = require('./qr');
const { WechatUserInstance } = require('./user-instance');

const CONFIG_KEY = 'wechat_ilink_config';
const LOCAL_QRCODE_EXPIRE_MS = 5 * 60 * 1000;
const POLL_GAP_MS = 250;
const NO_CREDENTIALS_RETRY_MS = 5000;
const ERROR_RETRY_MS = 3000;
const OFFICIAL_BASE_URL = DEFAULT_BASE_URL;

function defaultConfig() {
  return { enabled: false, mode: 'mock', baseUrl: OFFICIAL_BASE_URL, mockUrl: '' };
}

function loadConfig(db) {
  const raw = settingRepo.get(db, CONFIG_KEY) || '{}';
  try { return { ...defaultConfig(), ...JSON.parse(raw), baseUrl: OFFICIAL_BASE_URL }; } catch { return defaultConfig(); }
}
function saveConfig(db, cfg) {
  settingRepo.set(db, CONFIG_KEY, JSON.stringify(cfg || {}));
}

const CONNECTION_STATES = {
  unbound: { display: '未绑定', hint: '尚未绑定微信机器人。' },
  awaiting_scan: { display: '等待扫码', hint: '请用微信扫描二维码完成绑定。' },
  authenticated: { display: '已绑定', hint: 'iLink 机器人已绑定，可收发微信消息。' },
  expired: { display: '二维码已过期', hint: '二维码已过期，请重新生成。' },
  auth_failed: { display: '凭证失效', hint: '机器人凭证已失效，请解绑后重新扫码。' },
};

function qrLocallyExpired(qrcode, now) {
  return qrcode && now - qrcode.createdAt >= LOCAL_QRCODE_EXPIRE_MS;
}

function maskWxid(wxid) {
  const s = String(wxid || '');
  if (s.length <= 8) return s;
  return s.slice(0, 4) + '…' + s.slice(-4);
}

function createWechat(db, { stateDir, mockPort, realBaseUrl } = {}) {
  if (stateDir) state.setStateDir(stateDir);
  // 轮询租约按“状态目录”区分：同目录（多进程部署同一机器人的备份实例）互斥，不同目录（测试/演示）互不干扰
  const leaseName = 'ilink_poller_' + crypto.createHash('sha1').update(state.stateDir()).digest('hex').slice(0, 12);
  const manager = {};
  let mock = null;
  let pollPromise = null;
  let pollAbort = null;
  let pollStopped = false;
  let lastPollStatus = { ok: true, detail: '', at: 0 };
  let leaseOwner = crypto.randomUUID();
  let config = loadConfig(db);
  let stopped = false;
  let stopPromise = null;
  const userInstances = new Map();
  const usersStateRoot = stateDir || state.stateDir();
  function userInstance(userId) {
    const key = String(userId);
    let instance = userInstances.get(key);
    if (!instance) {
      instance = new WechatUserInstance({ db, userId: key, stateDir: usersStateRoot, mode: config.mode, realBaseUrl: realBaseUrl || OFFICIAL_BASE_URL });
      userInstances.set(key, instance);
    }
    return instance;
  }
  manager.userInstance = userInstance;
  manager.userStatus = (userId) => userInstance(userId).status();
  function assertRunning() {
    if (stopped) throw Object.assign(new Error('微信通道正在停止'), { code: 'ILINK_STOPPED', statusCode: 503 });
  }
  manager.startUserBinding = async (userId, force = false) => {
    assertRunning();
    if (!config.enabled) throw new Error('管理员尚未启用微信推送');
    return userInstance(userId).startBinding(force);
  };
  manager.refreshUserBinding = async (userId) => {
    assertRunning();
    return config.enabled ? userInstance(userId).refreshBinding() : manager.userStatus(userId);
  };
  manager.mockConfirmUserBinding = async (userId) => {
    assertRunning();
    if (!config.enabled) throw new Error('管理员尚未启用微信推送');
    return userInstance(userId).mockConfirmScan();
  };
  manager.userMockLog = async (userId) => userInstance(userId).mockLog();
  manager.removeUserInstance = async (userId) => {
    const key = String(userId);
    const instance = userInstance(key);
    await instance.clear();
    userInstances.delete(key);
  };

  // ---------------- 配置 ----------------
  manager.getConfig = () => ({ ...config, mockUrl: config.mockUrl || (mock && mock.running ? mock.url : '') });
  manager.setConfig = async (patch) => {
    assertRunning();
    const next = {
      ...config,
      enabled: patch.enabled != null ? !!patch.enabled : config.enabled,
      mode: patch.mode === 'real' || patch.mode === 'mock' ? patch.mode : config.mode,
      baseUrl: OFFICIAL_BASE_URL,
    };
    const modeChanged = next.mode !== config.mode;
    if (next.mode === 'real' && config.mode === 'mock' && mock && mock.running) await stopMock();
    assertRunning();
    config = next;
    saveConfig(db, next);
    if (modeChanged) {
      const userIds = new Set([...userInstances.keys(), ...db.prepare('SELECT user_id FROM wechat_bot_instances').all().map((row) => String(row.user_id))]);
      for (const userId of userIds) {
        wechatRepo.unbindByUserId(db, userId);
        await userInstance(userId).clear();
        userInstances.delete(userId);
      }
    }
    if (!next.enabled) {
      await Promise.all([...userInstances.values()].map((instance) => instance.stop()));
    } else {
      for (const instance of userInstances.values()) {
        if (instance.stopPromise) await instance.stopPromise;
        if (stopped || !config.enabled || userInstances.get(instance.userId) !== instance) continue;
        instance.mode = config.mode;
        if (instance.credentials()) instance.startPolling();
      }
    }
    return manager.getConfig();
  };

  // ---------------- 本地模拟服务 ----------------
  async function ensureMock() {
    if (mock && mock.running) return mock;
    mock = new MockIlinkServer();
    const port = Number(mockPort) || 0;
    await mock.start({ port });
    if (port) config = { ...config, mockUrl: mock.url };
    return mock;
  }
  async function stopMock() {
    if (mock && mock.running) await mock.stop();
  }
  manager.ensureMock = ensureMock;
  manager.getMock = () => (mock && mock.running ? mock : null);
  async function mockCall(pathname, body) {
    const m = await ensureMock();
    const { status, json } = await httpJsonRequest(`${m.url}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body == null ? undefined : JSON.stringify(body),
      timeoutMs: 8000,
    });
    if (status !== 200 || !json) throw new Error('模拟服务调用失败');
    return json;
  }
  manager.mockLog = async () => {
    const m = await ensureMock();
    const { json } = await httpJsonRequest(`${m.url}/mock/log?limit=50`, { timeoutMs: 8000 });
    return { running: true, url: m.url, ...(json || { sent: [], inbound: [] }) };
  };
  manager.mockConfirmScan = async () => {
    await mockCall('/mock/confirm-scan');
    return refreshBinding();
  };
  manager.mockExpireQr = async () => {
    await mockCall('/mock/expire-qr');
    return refreshBinding();
  };
  manager.mockInject = async ({ fromUserId, text }) => {
    const json = await mockCall('/mock/inject', { from_user_id: fromUserId, text });
    if (json && json.ret === 0 && json.data && json.data.message) {
      const handled = processInboundMessages([json.data.message]);
      return { injected: true, handled };
    }
    throw new Error('模拟微信发送失败（模拟服务未就绪）');
  };

  // ---------------- 基础 URL ----------------
  function resolveBaseUrl() {
    if (config.mode === 'mock') {
      return mock && mock.running ? mock.url : config.mockUrl || '';
    }
    return config.mode === 'real' ? (realBaseUrl || OFFICIAL_BASE_URL) : (mock && mock.running ? mock.url : config.mockUrl || '');
  }
  /** mock 模式下先确保本地模拟服务已启动，再继续。 */
  async function ensureReady() {
    if (config.mode === 'mock' && !(mock && mock.running)) await ensureMock();
  }
  function buildClient() {
    const baseUrl = resolveBaseUrl();
    if (!baseUrl) throw Object.assign(new Error('iLink 地址未就绪（本地模拟服务未启动）'), { code: 'ILINK_UNREADY' });
    return new IlinkClient({ baseUrl });
  }

  // ---------------- 绑定状态 ----------------
  function publicStatus(now = Date.now()) {
    const credentials = state.loadCredentials();
    const qrcode = state.loadQrcode();
    const persisted = state.loadStatus();
    const hasCredentials = !!credentials;
    const locallyExpired = qrLocallyExpired(qrcode, now);
    let connectionState;
    if (persisted.connection_state === 'auth_failed') connectionState = 'auth_failed';
    else if (hasCredentials) connectionState = 'authenticated';
    else if (locallyExpired) connectionState = 'expired';
    else connectionState = persisted.connection_state || 'unbound';
    if (connectionState === 'auth_failed' && !hasCredentials) connectionState = 'unbound';
    const awaitingScan = connectionState === 'awaiting_scan' && !locallyExpired && qrcode;
    const meta = CONNECTION_STATES[connectionState] || CONNECTION_STATES.unbound;
    return {
      connectionState,
      displayText: meta.display,
      hint: meta.hint,
      hasCredentials,
      botId: credentials ? credentials.ilinkBotId : '',
      ownerId: credentials ? maskWxid(credentials.ilinkUserId) : '',
      qrcodeKey: qrcode ? qrcode.qrcodeKey : '',
      hasQrcode: !!awaitingScan,
      qrcodeSvg: awaitingScan ? qrcodeSvg(qrcode.qrcodeContent) : '',
      qrcodeExpiresInSec: awaitingScan ? Math.max(0, Math.floor((qrcode.createdAt + LOCAL_QRCODE_EXPIRE_MS - now) / 1000)) : 0,
      lastError: persisted.last_error || '',
      updatedAt: persisted.updated_at || 0,
      poll: lastPollStatus,
    };
  }
  manager.status = () => publicStatus();

  // ---------------- 机器人扫码绑定 ----------------
  async function refreshBinding() {
    const now = Date.now();
    const credentials = state.loadCredentials();
    if (credentials) {
      state.saveStatus({ connection_state: 'authenticated', last_error: '' });
      startPollerIfNeeded();
      return publicStatus(now);
    }
    const qrcode = state.loadQrcode();
    if (!qrcode) {
      state.saveStatus({ connection_state: 'unbound', last_error: '' });
      startPollerIfNeeded();
      return publicStatus(now);
    }
    if (qrLocallyExpired(qrcode, now)) {
      state.saveStatus({ connection_state: 'expired', last_error: '' });
      return publicStatus(now);
    }
    await ensureReady();
    const client = buildClient();
    try {
      const result = await client.getQrcodeStatus(qrcode.qrcodeKey);
      if (result.confirmed) {
        const creds = result.credentials;
        if (!creds || !creds.botToken) throw Object.assign(new Error('扫码已确认但缺少 bot_token'), { code: 'ILINK_MISSING_TOKEN' });
        state.saveCredentials(creds);
        state.clearQrcode();
        state.clearCursor();
        state.saveStatus({ connection_state: 'authenticated', last_error: '', authenticated_at: now });
        startPollerIfNeeded();
      } else if (result.expired) {
        state.saveStatus({ connection_state: 'expired', last_error: '' });
      } else {
        state.saveStatus({ connection_state: 'awaiting_scan', last_error: '', qrcode_status: result.rawState });
      }
    } catch (error) {
      state.saveStatus({ connection_state: 'awaiting_scan', last_error: String(error.message || error).slice(0, 300) });
    }
    return publicStatus(now);
  }
  manager.refreshBinding = refreshBinding;

  manager.startBinding = async (force) => {
    if (force) state.clearAll();
    const credentials = state.loadCredentials();
    if (credentials && !force) {
      await refreshBinding();
      return publicStatus();
    }
    await ensureReady();
    const client = buildClient();
    const qrcode = await client.getBotQrcode();
    state.saveQrcode(qrcode);
    state.saveStatus({ connection_state: 'awaiting_scan', last_error: '', qrcode_status: 'pending' });
    return publicStatus();
  };

  manager.unbindBinding = async () => {
    state.clearAll();
    state.saveStatus({ connection_state: 'unbound', last_error: '' });
    startPollerIfNeeded();
    return publicStatus();
  };

  // ---------------- 用户绑定 ----------------
  manager.userBinding = (userId) => wechatRepo.getByUserId(db, userId);
  manager.bindingCount = () => wechatRepo.count(db);


  manager.selfUnbind = async (userId) => {
    const wxid = wechatRepo.unbindByUserId(db, userId);
    await userInstance(userId).clear();
    if (wxid) wechatRepo.logDelivery(db, { userId, wxid, direction: 'out', kind: 'unbind', text: '已解除微信绑定', status: 'sent' });
    return { unbound: true };
  };

  // ---------------- 主动推送 ----------------
  function logUserDelivery(theDb, delivery) {
    try { wechatRepo.logDelivery(theDb, delivery); }
    catch (error) { console.error('[wechat] delivery log error:', error.message); }
  }
  /**
   * 向某个Markly账号推送微信文本。
   * 返回 {status:'sent'}；未绑定账号 / 机器人未绑定抛 Error（带 code）。
   */
  async function sendToUser(dbArg, userId, text, opts = {}) {
    const theDb = dbArg || db;
    if (!config.enabled) throw Object.assign(new Error('微信推送通道未启用'), { code: 'ILINK_DISABLED' });
    const instance = userInstance(userId);
    const binding = wechatRepo.getByUserId(theDb, userId);
    if (!binding || !binding.wxid || !binding.contextToken) {
      throw Object.assign(new Error('该账号未绑定微信'), { code: 'ILINK_USER_UNBOUND', userId });
    }
    const user = userRepo.byId(theDb, userId);
    if (!user || user.status !== 1) throw Object.assign(new Error('账号已停用'), { code: 'ILINK_USER_DISABLED', userId });
    try {
      await instance.sendText(text, { clientId: opts.clientId });
    } catch (error) {
      logUserDelivery(theDb, { userId, wxid: binding.wxid, direction: 'out', kind: opts.kind || 'send', text, status: 'failed', error: error.message });
      if (error && (error.kind === 'session' || error.kind === 'auth')) wechatRepo.invalidateContext(theDb, userId, binding.wxid);
      throw error;
    }
    // Auxiliary logging cannot turn a completed external send into an outbox retry.
    logUserDelivery(theDb, { userId, wxid: binding.wxid, direction: 'out', kind: opts.kind || 'send', text, status: 'sent' });
    return { status: 'sent', userId };
  }
  manager.sendToUser = sendToUser;
  manager.deliveries = (userId, limit) => wechatRepo.listDeliveries(db, userId, limit);

  // ---------------- 入站处理 ----------------
  /** 发送回复失败只记日志，绝不影响主流程。 */
  function safeReply(fromUserId, contextToken, text) {
    try {
      const credentials = state.loadCredentials();
      if (!credentials) return;
      const client = buildClient();
      Promise.resolve(client.sendText({ toUserId: fromUserId, contextToken, text, credentials })).catch(() => {});
    } catch {
      // 模拟服务未就绪等情况：静默忽略
    }
  }

  // 全局机器人已停用。入站处理只存在于每个账号自己的 WechatUserInstance，
  // 其唯一首次绑定指令是向该机器人发送数字 1。
  function processInboundMessages() { return []; }

  // ---------------- 轮询 worker ----------------
  async function pollOnce(signal) {
    const credentials = state.loadCredentials();
    if (!credentials) {
      state.saveStatus({ connection_state: 'unbound', last_error: '' });
      lastPollStatus = { ok: false, detail: 'no_credentials', at: Date.now() };
      return { ok: false, reason: 'no_credentials' };
    }
    await ensureReady();
    const client = buildClient();
    try {
      const result = await client.getUpdates({ cursor: state.loadCursor(), credentials, signal });
      const handled = processInboundMessages(result.messages);
      state.saveCursor(result.cursor);
      state.saveStatus({ connection_state: 'authenticated', last_error: '' });
      lastPollStatus = { ok: true, detail: handled.length ? `inbound ${handled.length}` : 'poll', at: Date.now() };
      return { ok: true, messages: result.messages.length, handled };
    } catch (error) {
      if (error && (error.kind === 'session' || error.kind === 'auth')) {
        state.saveStatus({ connection_state: 'auth_failed', last_error: String(error.message || error).slice(0, 300) });
        lastPollStatus = { ok: false, detail: error.message, at: Date.now() };
        return { ok: false, reason: 'auth', error };
      }
      lastPollStatus = { ok: false, detail: String(error.message || error).slice(0, 300), at: Date.now() };
      return { ok: false, reason: 'error', error };
    }
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function pollLoop() {
    while (!pollStopped) {
      const signal = pollAbort && pollAbort.signal;
      // 多进程部署时用 lease 保证只有一个实例在长轮询
      const now = Date.now();
      const leaseHeld = db.prepare(
        `INSERT INTO scheduler_leases(name, owner, locked_until) VALUES ('${leaseName}', ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, locked_until=excluded.locked_until WHERE scheduler_leases.locked_until<? OR scheduler_leases.owner=?`
      ).run(leaseOwner, now + 120000, now, leaseOwner).changes > 0;
      if (!leaseHeld) { await sleep(3000); continue; }
      const outcome = await pollOnce(signal);
      if (pollStopped) break;
      if (!outcome.ok && outcome.reason === 'no_credentials') await sleep(NO_CREDENTIALS_RETRY_MS);
      else if (!outcome.ok && outcome.reason === 'auth') await sleep(15000);
      else await sleep(POLL_GAP_MS);
    }
  }

  manager.startPolling = () => {
    if (pollPromise) return manager;
    pollStopped = false;
    pollAbort = new AbortController();
    if (config.mode === 'mock') {
      ensureMock().catch((error) => console.error('[wechat] mock start error:', error.message));
    }
    pollPromise = (async () => {
      try {
        await pollLoop();
      } finally {
        // 归还轮询租约，便于同库重启/多实例交接
        try { db.prepare(`DELETE FROM scheduler_leases WHERE name='${leaseName}' AND owner=?`).run(leaseOwner); } catch {}
        pollPromise = null;
      }
    })();
    return manager;
  };
  manager.stopPolling = () => {
    pollStopped = true;
    if (pollAbort) {
      pollAbort.abort();
      pollAbort = null;
    }
  };
  manager.isPolling = () => !!pollPromise;

  /** 依据“通道开启 + 机器人已绑定”自动启停入站轮询。 */
  function startPollerIfNeeded() {
    if (config.enabled && state.hasCredentials()) manager.startPolling();
    else manager.stopPolling();
  }

  // ---------------- 模拟演示辅助 ----------------
  manager.userMockWxid = (userId) => 'mockwx_' + crypto.createHash('sha1').update(String(userId)).digest('hex').slice(0, 12) + '@im.wechat';
  /** 模拟“该用户用自己微信给机器人发了一条消息”，并立即处理入站（mock 模式演示用）。 */
  manager.simulateUserInbound = async (userId, text) => {
    if (config.mode !== 'mock') throw Object.assign(new Error('仅本地模拟模式下可模拟发送'), { code: 'ILINK_NOT_MOCK' });
    return userInstance(userId).simulateInbound(text);
  };

  /** 停止轮询并等待其退出（中止在途长轮询）。 */
  async function stopPoller() {
    manager.stopPolling();
    const pending = pollPromise;
    if (pending) {
      try { await Promise.race([pending, sleep(4000)]); } catch {}
    }
  }

  // ---------------- 生命周期 ----------------
  manager.start = async () => {
    if (stopPromise) await stopPromise;
    stopPromise = null;
    stopped = false;
    config = loadConfig(db);
    for (const row of db.prepare('SELECT user_id FROM wechat_bot_instances').all()) {
      const instance = userInstance(row.user_id);
      if (config.enabled && instance.credentials()) instance.startPolling();
    }
    return manager;
  };
  manager.stop = async () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    const pendingUsers = [...userInstances.values()].map((instance) => instance.stop());
    stopPromise = Promise.all([stopPoller(), stopMock(), ...pendingUsers]).then(() => undefined);
    return stopPromise;
  };

  return manager;
}

module.exports = {
  createWechat, loadConfig, saveConfig, defaultConfig,
  CONFIG_KEY, maskWxid, qrcodeSvg,
};

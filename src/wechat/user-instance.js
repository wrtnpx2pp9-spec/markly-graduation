'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { IlinkClient, DEFAULT_BASE_URL, httpJsonRequest, normalizeInboundMessage } = require('./client');
const { MockIlinkServer } = require('./mock-server');
const { qrcodeSvg } = require('./qr');

const QR_EXPIRE_MS = 5 * 60 * 1000;
const OFFICIAL_BASE_URL = DEFAULT_BASE_URL;
const POLL_RETRY_MS = 1000;

function waitForRetry(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, POLL_RETRY_MS);
    signal.addEventListener('abort', finish, { once: true });
  });
}

class WechatUserInstance {
  constructor({ db, userId, stateDir, mode = 'mock', mockPort = 0, realBaseUrl = '' }) {
    this.db = db;
    this.userId = String(userId);
    this.mode = mode === 'real' ? 'real' : 'mock';
    this.stateDir = path.join(stateDir, 'users', crypto.createHash('sha256').update(this.userId).digest('hex'));
    this.realBaseUrl = realBaseUrl || OFFICIAL_BASE_URL;
    this.mockPort = mockPort;
    this.mock = null;
    this.mockPromise = null;
    this.pollPromise = null;
    this.abort = null;
    this.stopped = true;
    this.bindingGeneration = 0;
    this.stopPromise = null;
    this.lastPoll = { ok: true, detail: '', at: 0 };
    this.leaseOwner = crypto.randomUUID();
    this.leaseName = `ilink_user_${crypto.createHash('sha1').update(this.userId).digest('hex').slice(0, 20)}`;
  }

  file(name) { return path.join(this.stateDir, name); }
  ensureDir() { fs.mkdirSync(this.stateDir, { recursive: true }); }
  readJson(name) { try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); } catch { return null; } }
  writeJson(name, value) {
    this.ensureDir();
    const tmp = this.file(`.${name}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file(name));
  }
  readText(name) { try { return fs.readFileSync(this.file(name), 'utf8').trim(); } catch { return ''; } }
  writeText(name, value) { this.ensureDir(); fs.writeFileSync(this.file(name), String(value || ''), { mode: 0o600 }); }
  remove(name) { try { fs.rmSync(this.file(name), { force: true }); } catch {} }
  credentials() {
    const c = this.readJson('credentials.json');
    if (!c || !(c.bot_token || c.botToken)) return null;
    return { botToken: c.bot_token || c.botToken, ilinkBotId: c.ilink_bot_id || c.ilinkBotId || '', ilinkUserId: c.ilink_user_id || c.ilinkUserId || '' };
  }
  qr() { return this.readJson('qrcode.json'); }
  status() {
    const c = this.credentials(); const qr = this.qr();
    const binding = require('../repo/wechat.repo').getByUserId(this.db, this.userId);
    const state = c ? (binding?.wxid && binding?.contextToken ? 'authenticated' : 'awaiting_message') : qr && Date.now() - Number(qr.createdAt || 0) < QR_EXPIRE_MS ? 'awaiting_scan' : qr ? 'expired' : 'unbound';
    return { userId: this.userId, connectionState: state, hasCredentials: !!c, qrcodeKey: qr?.qrcodeKey || '', hasQrcode: state === 'awaiting_scan', qrcodeSvg: state === 'awaiting_scan' ? qrcodeSvg(qr.qrcodeContent) : '', qrcodeExpiresInSec: state === 'awaiting_scan' ? Math.max(0, Math.floor((qr.createdAt + QR_EXPIRE_MS - Date.now()) / 1000)) : 0, poll: this.lastPoll };
  }
  async ensureMock() {
    if (this.mockPromise) return this.mockPromise;
    if (this.mock?.running) return this.mock;
    const mock = this.mock = new MockIlinkServer();
    this.mockPromise = mock.start({ port: this.mockPort }).then(() => mock).finally(() => { this.mockPromise = null; });
    return this.mockPromise;
  }
  baseUrl() { return this.mode === 'mock' ? this.mock.url : this.realBaseUrl; }
  async client() { if (this.mode === 'mock') await this.ensureMock(); return new IlinkClient({ baseUrl: this.baseUrl() }); }
  async startBinding(force = false) {
    if (force) {
      const stopping = this.stop();
      const generation = this.bindingGeneration;
      await stopping;
      if (generation !== this.bindingGeneration) return this.status();
      this.remove('credentials.json'); this.remove('qrcode.json'); this.remove('cursor.txt');
    } else if (this.stopPromise) return this.status();
    const c = this.credentials(); if (c && !force) { this.startPolling(); return this.status(); }
    const generation = ++this.bindingGeneration;
    const now = Date.now();
    this.db.prepare("INSERT INTO wechat_bot_instances(user_id, mode, connection_state, updated_at, created_at) VALUES (?, ?, 'unbound', ?, ?) ON CONFLICT(user_id) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at").run(this.userId, this.mode, now, now);
    const client = await this.client();
    if (generation !== this.bindingGeneration) return this.status();
    const qr = await client.getBotQrcode();
    if (generation !== this.bindingGeneration) return this.status();
    this.writeJson('qrcode.json', qr);
    this.db.prepare("UPDATE wechat_bot_instances SET connection_state='awaiting_scan', updated_at=? WHERE user_id=?").run(Date.now(), this.userId);
    return this.status();
  }
  async refreshBinding() {
    if (this.stopPromise) return this.status();
    if (this.credentials()) { this.startPolling(); return this.status(); }
    const qr = this.qr(); if (!qr || Date.now() - Number(qr.createdAt || 0) >= QR_EXPIRE_MS) return this.status();
    const generation = this.bindingGeneration;
    const isCurrentQr = () => {
      const current = this.qr();
      return generation === this.bindingGeneration && current?.qrcodeKey === qr.qrcodeKey && current?.createdAt === qr.createdAt && Date.now() - Number(current?.createdAt || 0) < QR_EXPIRE_MS;
    };
    const client = await this.client();
    if (!isCurrentQr()) return this.status();
    const result = await client.getQrcodeStatus(qr.qrcodeKey);
    if (!isCurrentQr()) return this.status();
    if (result.confirmed && result.credentials?.botToken) {
      this.bindingGeneration++;
      this.writeJson('credentials.json', { bot_token: result.credentials.botToken, ilink_bot_id: result.credentials.ilinkBotId || '', ilink_user_id: result.credentials.ilinkUserId || '' });
      this.remove('qrcode.json'); this.remove('cursor.txt'); this.startPolling();
      this.db.prepare("UPDATE wechat_bot_instances SET connection_state='awaiting_message', updated_at=? WHERE user_id=?").run(Date.now(), this.userId);
    }
    return this.status();
  }
  async mockConfirmScan() {
    if (this.mode !== 'mock') throw new Error('仅本地模拟模式可模拟扫码');
    const generation = this.bindingGeneration;
    const mock = await this.ensureMock();
    if (generation !== this.bindingGeneration) return this.status();
    await httpJsonRequest(`${mock.url}/mock/confirm-scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeoutMs: 8000 });
    if (generation !== this.bindingGeneration) return this.status();
    return this.refreshBinding();
  }
  async handleMessage(message) {
    if (message && !message.fromUserId) message = normalizeInboundMessage(message);
    if (!message || !message.fromUserId || !message.contextToken) return null;
    const text = String(message.text || '').trim();
    const existing = require('../repo/wechat.repo').getByUserId(this.db, this.userId);
    if (existing?.wxid === message.fromUserId) {
      require('../repo/wechat.repo').refreshContext(this.db, this.userId, message.contextToken, message.fromUserId, '');
      return { action: 'refresh', userId: this.userId };
    }
    if (text !== '1') return null;
    require('../repo/wechat.repo').bindUserWxid(this.db, { userId: this.userId, wxid: message.fromUserId, contextToken: message.contextToken, nickname: '' });
    this.db.prepare("UPDATE wechat_bot_instances SET connection_state='authenticated', updated_at=? WHERE user_id=?").run(Date.now(), this.userId);
    require('../repo/wechat.repo').logDelivery(this.db, { userId: this.userId, wxid: message.fromUserId, direction: 'in', kind: 'bind', text, status: 'sent' });
    return { action: 'bind', userId: this.userId, wxid: message.fromUserId };
  }
  async pollOnce() {
    const generation = this.bindingGeneration;
    const signal = this.abort?.signal;
    const cancelled = () => this.stopped || signal?.aborted || generation !== this.bindingGeneration;
    const credentials = this.credentials(); if (!credentials) return false;
    const now = Date.now();
    const held = this.db.prepare("INSERT INTO scheduler_leases(name, owner, locked_until) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner, locked_until=excluded.locked_until WHERE scheduler_leases.locked_until<? OR scheduler_leases.owner=?").run(this.leaseName, this.leaseOwner, now + 120000, now, this.leaseOwner).changes > 0;
    if (!held) return false;
    const client = await this.client();
    if (cancelled()) return true;
    const result = await client.getUpdates({ cursor: this.readText('cursor.txt'), credentials, signal });
    if (cancelled()) return true;
    for (const message of result.messages) {
      if (cancelled()) return true;
      await this.handleMessage(message);
    }
    if (cancelled()) return true;
    this.writeText('cursor.txt', result.cursor);
    this.lastPoll = { ok: true, detail: result.messages.length ? `inbound ${result.messages.length}` : 'poll', at: Date.now() };
    return true;
  }
  startPolling() {
    if (this.stopPromise || this.pollPromise || !this.credentials()) return;
    this.stopped = false; this.abort = new AbortController();
    const signal = this.abort.signal;
    this.pollPromise = (async () => {
      while (!this.stopped) {
        try {
          if (!await this.pollOnce()) await waitForRetry(signal);
        } catch (error) {
          if (signal.aborted) break;
          this.lastPoll = { ok: false, detail: String(error.message || error).slice(0, 300), at: Date.now() };
          await waitForRetry(signal);
        }
      }
    })().finally(() => { this.pollPromise = null; });
  }
  async sendText(text, { clientId } = {}) {
    const credentials = this.credentials(); if (!credentials) throw Object.assign(new Error('该用户的微信机器人尚未扫码绑定'), { code: 'ILINK_USER_BOT_UNBOUND' });
    const binding = require('../repo/wechat.repo').getByUserId(this.db, this.userId);
    if (!binding?.wxid || !binding.contextToken) throw Object.assign(new Error('请先让该微信向自己的机器人发送 1'), { code: 'ILINK_USER_UNBOUND' });
    try { await (await this.client()).sendText({ toUserId: binding.wxid, contextToken: binding.contextToken, text, credentials, clientId }); }
    catch (error) { if (error.kind === 'session' || error.kind === 'auth') require('../repo/wechat.repo').invalidateContext(this.db, this.userId, binding.wxid); throw error; }
  }
  async simulateInbound(text) {
    const mock = await this.ensureMock(); const fromUserId = `mockwx_${crypto.createHash('sha1').update(this.userId).digest('hex').slice(0, 12)}@im.wechat`;
    const response = await httpJsonRequest(`${mock.url}/mock/inject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from_user_id: fromUserId, text }), timeoutMs: 8000 });
    const message = response.json?.data?.message; const result = await this.handleMessage(message); return { fromUserId, result };
  }
  async mockLog() { const mock = await this.ensureMock(); return { sent: [...mock.sentLog], inbound: [...mock.inboundLog], url: mock.url }; }
  async clear() {
    const stopping = this.stop();
    for (const name of ['credentials.json', 'qrcode.json', 'cursor.txt']) this.remove(name);
    this.db.prepare('DELETE FROM wechat_bot_instances WHERE user_id=?').run(this.userId);
    await stopping;
  }
  async stop() {
    this.bindingGeneration++;
    this.stopped = true;
    this.abort?.abort();
    if (!this.stopPromise) {
      this.stopPromise = (async () => {
        if (this.pollPromise) await this.pollPromise;
        if (this.mockPromise) await this.mockPromise.catch(() => {});
        try { this.db.prepare('DELETE FROM scheduler_leases WHERE name=? AND owner=?').run(this.leaseName, this.leaseOwner); } catch {}
        if (this.mock?.running) await this.mock.stop();
      })().finally(() => { this.stopPromise = null; });
    }
    await this.stopPromise;
  }
}

module.exports = { WechatUserInstance, OFFICIAL_BASE_URL };

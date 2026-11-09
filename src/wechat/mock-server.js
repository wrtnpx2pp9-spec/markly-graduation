'use strict';
/**
 * 本地模拟 iLink 服务（供没有真实微信时演示/联调用）。
 * 与真实 iLink 协议端点一致：
 *   GET  /ilink/bot/get_bot_qrcode
 *   GET  /ilink/bot/get_qrcode_status
 *   POST /ilink/bot/getupdates     （长轮询收消息）
 *   POST /ilink/bot/sendmessage    （发送记录到 outbox，界面可查看）
 * 外加模拟操作端点（前缀 /mock/，供Markly界面驱动“扫码确认 / 从微信发消息 / 查看已发”）：
 *   POST /mock/confirm-scan        模拟微信扫码并确认绑定
 *   POST /mock/expire-qr           模拟二维码过期
 *   POST /mock/inject              模拟某个微信用户向机器人发消息
 *   GET  /mock/log                 查看机器人发出去的消息（模拟微信收件箱）
 *   GET  /mock/state               模拟服务状态
 */
const http = require('http');
const crypto = require('crypto');

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

const CONFIRM_STATUSES = new Set(['confirm', 'confirmed', 'success', 'authorized', 'ok']);
const EXPIRED_STATUSES = new Set(['expired', 'timeout', 'canceled', 'cancel']);

class MockIlinkServer {
  constructor() {
    this.server = null;
    this.port = 0;
    this.url = '';
    this.requests = 0;
    this.sentLog = [];        // 机器人发出的消息（模拟对方微信收到的推送）
    this.inboundLog = [];     // 收到“微信用户”发来的消息
    this.waiters = [];        // 挂起的长轮询
    this.qr = { key: '', status: 'wait', createdAt: 0, content: '' };
    this.seq = 0;
    this.token = '';
    this.confirmedAt = 0;
    this.failAuth = false;    // 模拟 token 失效（-14）
    this.lastCursorSeq = 0;
  }

  start({ port = 0 } = {}) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        this.url = `http://127.0.0.1:${this.port}`;
        resolve(this);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      const wake = [...this.waiters];
      this.waiters = [];
      wake.forEach((w) => { try { w.onClose(); } catch {} });
      const server = this.server;
      this.server = null;
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      server.close(() => finish());
      // 立即断开保活/挂起连接（长轮询等），避免 close 回调永远等不到
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      setTimeout(finish, 1500).unref?.();
    });
  }

  get running() { return !!this.server; }

  // ---------------- 状态机 ----------------
  newQrcode() {
    this.qr = {
      key: `mock_qr_${crypto.randomBytes(6).toString('hex')}`,
      status: 'wait',
      content: `https://mock-ilink.local/q/${crypto.randomBytes(6).toString('hex')}`,
      createdAt: Date.now(),
    };
    this.token = '';
    this.confirmedAt = 0;
    return this.qr;
  }
  confirmScan() {
    if (!this.qr.key) this.newQrcode();
    if (EXPIRED_STATUSES.has(this.qr.status)) return false;
    this.qr.status = 'confirmed';
    this.confirmedAt = Date.now();
    this.token = `mockbot_${crypto.randomBytes(10).toString('hex')}`;
    return true;
  }
  expireQrcode() {
    this.qr.status = 'expired';
  }

  // ---------------- 入站（模拟微信用户给机器人发消息） ----------------
  /** @returns 产生的入站消息 */
  injectMessage(fromUserId, text) {
    this.seq += 1;
    const message = {
      seq: this.seq,
      message_id: Date.now() * 1000 + this.seq,
      from_user_id: fromUserId,
      to_user_id: `bot_${this.qr.key || 'mock'}@im.bot`,
      client_id: `mock-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      create_time_ms: Date.now(),
      update_time_ms: Date.now(),
      message_type: 1,
      message_state: 2,
      context_token: `mockctx_${Buffer.from(fromUserId).toString('base64url')}_${this.seq}`,
      item_list: [{ type: 1, text_item: { text: String(text || '') } }],
    };
    this.inboundLog.unshift(message);
    this.inboundLog = this.inboundLog.slice(0, 200);
    const waiters = [...this.waiters];
    this.waiters = [];
    waiters.forEach((w) => w.resolve());
    return message;
  }

  // ---------------- HTTP ----------------
  async handle(req, res) {
    this.requests += 1;
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const method = req.method;
    const path = url.pathname;
    if (method === 'GET' && path === '/mock/state') {
      return sendJson(res, 200, { ok: true, url: this.url, qrStatus: this.qr.status, sent: this.sentLog.length, inbound: this.inboundLog.length });
    }
    if (method === 'GET' && path === '/mock/log') {
      const limit = Math.min(100, Number.parseInt(url.searchParams.get('limit'), 10) || 20);
      return sendJson(res, 200, { sent: this.sentLog.slice(0, limit), inbound: this.inboundLog.slice(0, limit) });
    }
    if (method === 'POST' && path === '/mock/confirm-scan') {
      const ok = this.confirmScan();
      return sendJson(res, 200, { ok, status: this.qr.status });
    }
    if (method === 'POST' && path === '/mock/expire-qr') {
      this.expireQrcode();
      return sendJson(res, 200, { ok: true, status: this.qr.status });
    }
    if (method === 'POST' && path === '/mock/inject') {
      const body = await readBody(req);
      const fromUserId = String(body.from_user_id || '').trim();
      const text = String(body.text || '');
      if (!fromUserId || !text) return sendJson(res, 400, { ret: -2, errmsg: '缺少 from_user_id 或 text' });
      const message = this.injectMessage(fromUserId, text);
      return sendJson(res, 200, { ret: 0, data: { message } });
    }

    // ---- 协议端点 ----
    if (method === 'GET' && path === '/ilink/bot/get_bot_qrcode') {
      this.newQrcode();
      return sendJson(res, 200, {
        ret: 0,
        data: {
          qrcode_item: {
            qrcode_key: this.qr.key,
            qrcode_img_content: this.qr.content,
          },
        },
      });
    }
    if (method === 'GET' && path === '/ilink/bot/get_qrcode_status') {
      const key = url.searchParams.get('qrcode') || '';
      const data = { status: 'wait', qrcode_key: key };
      if (key === this.qr.key) {
        if (this.qr.status === 'confirmed') {
          data.status = 'confirmed';
          data.bot_token = this.token;
          data.ilink_bot_id = `mockbot@im.bot`;
          data.ilink_user_id = `mockowner_${this.qr.key}@im.wechat`;
          data.authorization_item = { bot_token: this.token, ilink_bot_id: 'mockbot@im.bot', ilink_user_id: `mockowner_${this.qr.key}@im.wechat` };
        } else if (this.qr.status === 'expired') {
          data.status = 'expired';
        }
      }
      return sendJson(res, 200, { ret: 0, data: { qrcode_status_item: data } });
    }
    if (method === 'POST' && path === '/ilink/bot/getconfig') {
      return sendJson(res, 200, { ret: 0, data: {} });
    }
    if (method === 'POST' && path === '/ilink/bot/sendmessage') {
      const body = await readBody(req);
      const msg = (body && body.msg) || {};
      const token = String(msg.context_token || '').trim();
      const toUserId = String(msg.to_user_id || '').trim();
      const texts = (msg.item_list || []).map((item) => String(((item || {}).text_item || {}).text || '')).filter(Boolean);
      if (!toUserId || !token) return sendJson(res, 200, { ret: -2, errmsg: '缺少 to_user_id 或 context_token' });
      if (this.failAuth) return sendJson(res, 200, { ret: -14, errmsg: 'session timeout' });
      this.sentLog.unshift({
        id: String(msg.client_id || crypto.randomUUID()),
        to_user_id: toUserId,
        text: texts.join('\n'),
        at: Date.now(),
      });
      this.sentLog = this.sentLog.slice(0, 200);
      return sendJson(res, 200, { ret: 0 });
    }
    if (method === 'POST' && path === '/ilink/bot/getupdates') {
      const body = await readBody(req);
      const buf = String((body && body.get_updates_buf) || '');
      let fromSeq = 0;
      try {
        const decoded = Buffer.from(buf, 'base64').toString('utf8');
        if (decoded) fromSeq = Number(JSON.parse(decoded).seq) || 0;
      } catch {}
      const waitMs = Math.min(8000, Math.max(0, Number((body && body.longpolling_timeout_ms) || 1000)));
      const respond = () => {
        const pending = this.inboundLog.filter((m) => m.seq > fromSeq).sort((a, b) => a.seq - b.seq);
        const nextSeq = pending.length ? pending[pending.length - 1].seq : fromSeq;
        return sendJson(res, 200, {
          ret: 0,
          msgs: pending,
          get_updates_buf: Buffer.from(JSON.stringify({ seq: nextSeq })).toString('base64'),
          longpolling_timeout_ms: waitMs,
        });
      };
      const timeout = setTimeout(respond, Math.min(waitMs, 5000));
      const waiter = {
        resolve: () => { clearTimeout(timeout); respond(); },
        onClose: () => {
          clearTimeout(timeout);
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
        },
      };
      req.on('close', () => waiter.onClose());
      // 有新消息时提前返回
      const existing = this.inboundLog.filter((m) => m.seq > fromSeq);
      if (existing.length) { clearTimeout(timeout); return respond(); }
      this.waiters.push(waiter);
      return;
    }
    return sendJson(res, 404, { ret: -1, errmsg: `模拟服务未知端点 ${path}` });
  }
}

module.exports = { MockIlinkServer, CONFIRM_STATUSES, EXPIRED_STATUSES };

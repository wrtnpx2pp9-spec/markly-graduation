'use strict';
/**
 * 微信 iLink / ClawBot HTTP 客户端（零外部依赖，基于 node:http/https，每次请求独立连接，不保活）。
 * 协议依据 Markly 项目适配实现及社区协议说明（ilinkai.weixin.qq.com）整理：
 *   - 二维码扫码绑定个人微信作为机器人（bot_type=3）；
 *   - getupdates 长轮询收消息；
 *   - sendmessage 带 to_user_id + context_token 主动推送（每条会话消息都绑定 context_token，
 *     回复/主动推送必须回传该用户最近一次的 context_token）。
 */
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = '131336'; // (2<<16)|(1<<8)|8
const ILINK_CHANNEL_VERSION = '2.1.8';
const CONFIRMED_STATUSES = new Set(['confirm', 'confirmed', 'success', 'authorized', 'ok']);
const EXPIRED_STATUSES = new Set(['expired', 'timeout', 'canceled', 'cancel']);
const LONG_POLL_MAX_MS = 35000;

class IlinkError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'IlinkError';
    this.code = opts.code;         // HTTP 状态或 ret
    this.kind = opts.kind || 'api'; // api | http | network | json | session | auth
    this.payload = opts.payload || null;
  }
}

function randomWechatUin() {
  const value = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function pickString(value, keys) {
  for (const key of keys) {
    const item = value && typeof value === 'object' ? value[key] : null;
    if (item == null) continue;
    const text = String(item).trim();
    if (text) return text;
  }
  return '';
}

function parseCredentialsFromStatus(status) {
  const auth = status.authorization_item && typeof status.authorization_item === 'object'
    ? status.authorization_item : {};
  const botToken = pickString(status, ['bot_token', 'token']) || pickString(auth, ['bot_token', 'token']);
  if (!botToken) return null;
  return {
    botToken,
    ilinkBotId: pickString(status, ['ilink_bot_id', 'bot_id']) || pickString(auth, ['ilink_bot_id', 'bot_id']),
    ilinkUserId: pickString(status, ['ilink_user_id', 'user_id']) || pickString(auth, ['ilink_user_id', 'user_id']),
  };
}

function extractItemTexts(itemList) {
  const parts = [];
  for (const item of Array.isArray(itemList) ? itemList : []) {
    if (!item || typeof item !== 'object') continue;
    const type = Number(item.type);
    if (type === 1) {
      const text = String(((item.text_item || {}).text) || '').trim();
      if (text) parts.push(text);
    } else if (type === 2) parts.push('[图片]');
    else if (type === 3) parts.push('[语音]');
    else if (type === 4) {
      const name = String(((item.file_item || {}).file_name) || '').trim();
      parts.push(name ? `[文件:${name}]` : '[文件]');
    } else if (type === 5) parts.push('[视频]');
  }
  return parts;
}

/** 把 getupdates 返回的一条原始协议消息归一成 {msgId, fromUserId, toUserId, contextToken, text}，无法归一返回 null。 */
function normalizeInboundMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let payload = raw;
  if (!payload.item_list && !payload.items && payload.msg && typeof payload.msg === 'object') payload = payload.msg;
  const fromUserId = pickString(payload, ['from_user_id', 'from', 'sender_id', 'from_username']);
  const toUserId = pickString(payload, ['to_user_id', 'to', 'to_username']);
  const contextToken = pickString(payload, ['context_token', 'reply_context_token']);
  const msgId = pickString(payload, ['msg_id', 'message_id', 'id', 'client_msg_id', 'client_id']);
  const itemList = payload.item_list || payload.items || [];
  const text = extractItemTexts(itemList).join('\n');
  if (!fromUserId || !contextToken || !text) return null;
  return { msgId: msgId || crypto.randomUUID(), fromUserId, toUserId, contextToken, text };
}

/**
 * 单次 HTTP(S) JSON 请求：返回 { status, body(json object) }。
 * 每次请求独立 socket（不保活），超时用 setTimeout 中止，便于服务停止与进程退出。
 */
function httpJsonRequest(fullUrl, { method = 'GET', headers = {}, body, timeoutMs = 30000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(fullUrl); } catch (error) { return reject(new IlinkError('非法 URL: ' + fullUrl, { kind: 'api' })); }
    const transport = parsed.protocol === 'https:' ? https : http;
    const AgentClass = parsed.protocol === 'https:' ? https.Agent : http.Agent;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 30000));
    // 专用 agent：不保活、只此一次请求使用，结束即销毁，避免连接把进程/测试拖住
    const agent = new AgentClass({ keepAlive: false, maxSockets: 1 });
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      try { agent.destroy(); } catch {}
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    function onExternalAbort() {
      fail(new IlinkError('iLink 请求已被取消', { kind: 'network', code: 'abort' }));
      request.destroy();
    }
    const request = transport.request(parsed, {
      method,
      headers,
      signal: controller.signal,
      agent,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        if (text.trim()) {
          try { json = JSON.parse(text); } catch { json = null; }
        }
        resolve({ status: response.statusCode || 0, text, json });
      });
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        reject(new IlinkError(`iLink 请求超时(>${Math.max(1, Number(timeoutMs) || 30000)}ms)`, { kind: 'network', code: 'timeout' }));
      } else {
        reject(new IlinkError(`iLink 网络错误: ${error.message}`, { kind: 'network' }));
      }
    });
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort);
    }
    if (body != null) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

class IlinkClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 30000 } = {}) {
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** 通用请求：拼公共请求头 + base_info，解析 ret/errcode。 */
  async request(method, path, { params, body, credentials, timeoutMs, signal } = {}) {
    const url = new URL(path, this.baseUrl);
    if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const headers = {
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': randomWechatUin(),
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    };
    if (credentials) {
      headers.AuthorizationType = 'ilink_bot_token';
      headers.Authorization = 'Bearer ' + credentials.botToken;
    }
    let jsonBody;
    if (body != null) {
      jsonBody = body.base_info ? body : { ...body, base_info: { channel_version: ILINK_CHANNEL_VERSION } };
    }
    const { status, text, json } = await httpJsonRequest(url.toString(), {
      method,
      headers,
      body: jsonBody == null ? undefined : JSON.stringify(jsonBody),
      timeoutMs: timeoutMs || this.timeoutMs,
      signal,
    });
    if (status === 401 || status === 403) {
      throw new IlinkError(`iLink ${path} 鉴权失败 HTTP ${status}`, { kind: 'auth', code: status });
    }
    if (status < 200 || status >= 300) {
      throw new IlinkError(`iLink ${path} 返回 HTTP ${status}: ${String(text || '').slice(0, 200)}`, { kind: 'http', code: status });
    }
    if (json == null) throw new IlinkError(`iLink ${path} 返回了无法解析的 JSON`, { kind: 'json' });
    const payload = json;
    const ret = payload.ret != null ? Number(payload.ret) : null;
    if (ret != null && ret !== 0) {
      const msg = pickString(payload, ['errmsg', 'msg']) || `iLink ${path} ret=${ret}`;
      if (ret === -14) throw new IlinkError(msg, { kind: 'session', code: ret, payload });
      throw new IlinkError(msg, { kind: 'api', code: ret, payload });
    }
    const errcode = payload.errcode != null ? payload.errcode : null;
    if (errcode != null && errcode !== 0 && errcode !== '0') {
      const msg = pickString(payload, ['errmsg', 'msg']) || `iLink ${path} errcode=${errcode}`;
      if (Number(errcode) === -14) throw new IlinkError(msg, { kind: 'session', code: -14, payload });
      throw new IlinkError(msg, { kind: 'api', code: errcode, payload });
    }
    return payload;
  }

  // ---------------- 绑定（无需凭证） ----------------
  async getBotQrcode() {
    const payload = await this.request('GET', '/ilink/bot/get_bot_qrcode', { params: { bot_type: '3' } });
    let data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (data.qrcode_item && typeof data.qrcode_item === 'object') data = data.qrcode_item;
    const qrcodeKey = pickString(data, ['qrcode_key', 'qrcode', 'key']);
    const qrcodeContent = pickString(data, ['qrcode_img_content', 'qrcode_content', 'qrcode_url']);
    if (!qrcodeKey || !qrcodeContent) {
      throw new IlinkError('获取绑定二维码失败：响应缺少 qrcode_key 或二维码内容', { kind: 'api', payload });
    }
    return { qrcodeKey, qrcodeContent, createdAt: Date.now() };
  }

  /** 轮询扫码状态，返回 { state, credentials? }。 */
  async getQrcodeStatus(qrcodeKey) {
    const payload = await this.request('GET', '/ilink/bot/get_qrcode_status', { params: { qrcode: qrcodeKey } });
    let data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    if (data.qrcode_status_item && typeof data.qrcode_status_item === 'object') data = data.qrcode_status_item;
    const state = pickString(data, ['status', 'qrcode_status']).toLowerCase();
    const confirmed = CONFIRMED_STATUSES.has(state);
    return {
      state: confirmed ? 'confirmed' : EXPIRED_STATUSES.has(state) ? 'expired' : state || 'pending',
      rawState: state,
      credentials: confirmed ? parseCredentialsFromStatus(data) : null,
      confirmed: !!confirmed,
      expired: EXPIRED_STATUSES.has(state),
    };
  }

  // ---------------- 入站长轮询 ----------------
  async getUpdates({ cursor = '', timeoutMs = LONG_POLL_MAX_MS, credentials, signal } = {}) {
    const t = Math.min(LONG_POLL_MAX_MS, Math.max(1000, Number(timeoutMs) || LONG_POLL_MAX_MS));
    const payload = await this.request('POST', '/ilink/bot/getupdates', {
      credentials,
      timeoutMs: t + 15000, // 本地超时要比服务端长轮询窗口大
      signal,
      body: { get_updates_buf: String(cursor || ''), longpolling_timeout_ms: t },
    });
    const data = payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const rawMessages = data.msg_list || data.messages || data.msgs || [];
    const nextCursor = pickString(data, ['get_updates_buf', 'next_get_updates_buf', 'cursor']) || String(cursor || '');
    const preferNextTimeout = Number(data.longpolling_timeout_ms);
    const messages = [];
    for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
      const normalized = normalizeInboundMessage(raw);
      if (normalized) messages.push(normalized);
    }
    return {
      messages,
      cursor: nextCursor,
      nextTimeoutMs: Number.isFinite(preferNextTimeout) && preferNextTimeout > 0 ? preferNextTimeout : t,
    };
  }

  // ---------------- 出站推送 ----------------
  async sendText({ toUserId, contextToken, text, clientId, credentials }) {
    const trimmedText = String(text || '').trim();
    if (!trimmedText) throw new IlinkError('发送内容为空');
    await this.request('POST', '/ilink/bot/sendmessage', {
      credentials,
      body: {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          message_type: 2,
          message_state: 2,
          client_id: clientId || `sp-pp-${crypto.randomUUID()}`,
          item_list: [{ type: 1, text_item: { text: trimmedText } }],
        },
      },
    });
    return true;
  }

  /** 探活：凭证是否仍有效（真实模式用 getconfig 验证）。 */
  async probe(credentials) {
    const body = {};
    if (credentials.ilinkUserId) body.ilink_user_id = credentials.ilinkUserId;
    await this.request('POST', '/ilink/bot/getconfig', { body, credentials });
    return true;
  }
}

IlinkClient.DEFAULT_BASE_URL = DEFAULT_BASE_URL;

module.exports = {
  IlinkClient, IlinkError, DEFAULT_BASE_URL,
  normalizeInboundMessage, extractItemTexts, pickString, httpJsonRequest,
};

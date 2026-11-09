'use strict';
/**
 * 微信 iLink 状态存储：凭证 / 二维码 / 轮询游标 / 绑定状态，落盘到本地目录
 * （默认 <项目>/data/ilink-state，可用环境变量 ILINK_STATE_DIR 覆盖，便于测试）。
 * 凭证以 0600 权限写入，避免泄露 bot_token。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _stateDir = process.env.ILINK_STATE_DIR || path.join(__dirname, '..', '..', 'data', 'ilink-state');

function setStateDir(dir) {
  _stateDir = dir;
}
function stateDir() {
  return _stateDir;
}
function ensureDir() {
  fs.mkdirSync(_stateDir, { recursive: true });
}

function credentialsPath() { return path.join(_stateDir, 'credentials.json'); }
function qrcodePath() { return path.join(_stateDir, 'qrcode.json'); }
function cursorPath() { return path.join(_stateDir, 'cursor.txt'); }
function statusPath() { return path.join(_stateDir, 'status.json'); }

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  ensureDir();
  const tmp = path.join(_stateDir, `.${path.basename(file)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readText(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return String(raw || '').trim();
  } catch {
    return '';
  }
}

function writeText(file, content) {
  ensureDir();
  const tmp = path.join(_stateDir, `.${path.basename(file)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  fs.writeFileSync(tmp, String(content || ''), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function remove(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

// ---------------- 凭证 ----------------
function loadCredentials() {
  const payload = readJson(credentialsPath());
  const botToken = String(payload.bot_token || '').trim();
  if (!botToken) return null;
  return {
    botToken,
    ilinkBotId: String(payload.ilink_bot_id || '').trim(),
    ilinkUserId: String(payload.ilink_user_id || '').trim(),
  };
}
function saveCredentials(credentials) {
  writeJson(credentialsPath(), {
    bot_token: credentials.botToken,
    ilink_bot_id: credentials.ilinkBotId || '',
    ilink_user_id: credentials.ilinkUserId || '',
  });
}
function clearCredentials() {
  remove(credentialsPath());
}
function hasCredentials() {
  return !!loadCredentials();
}

// ---------------- 二维码（待扫码状态） ----------------
function loadQrcode() {
  const payload = readJson(qrcodePath());
  if (!payload.qrcodeKey && !payload.qrcodeContent) return null;
  return {
    qrcodeKey: String(payload.qrcodeKey || ''),
    qrcodeContent: String(payload.qrcodeContent || ''),
    createdAt: Number(payload.createdAt) || 0,
  };
}
function saveQrcode(qrcode) {
  writeJson(qrcodePath(), qrcode);
}
function clearQrcode() {
  remove(qrcodePath());
}

// ---------------- 轮询游标 ----------------
function loadCursor() {
  return readText(cursorPath());
}
function saveCursor(cursor) {
  writeText(cursorPath(), cursor || '');
}
function clearCursor() {
  remove(cursorPath());
}

// ---------------- 绑定状态（面向界面） ----------------
const DEFAULT_STATUS = { connection_state: 'unbound', updated_at: Date.now() };
function loadStatus() {
  return { ...DEFAULT_STATUS, ...readJson(statusPath()) };
}
function saveStatus(patch) {
  const next = { ...loadStatus(), ...patch, updated_at: Date.now() };
  writeJson(statusPath(), next);
  return next;
}

/** 一次性清空全部 iLink 登录态（解绑/换号时使用）。 */
function clearAll() {
  clearCredentials();
  clearQrcode();
  clearCursor();
  remove(statusPath());
}

module.exports = {
  setStateDir, stateDir, ensureDir,
  loadCredentials, saveCredentials, clearCredentials, hasCredentials,
  loadQrcode, saveQrcode, clearQrcode,
  loadCursor, saveCursor, clearCursor,
  loadStatus, saveStatus, clearAll,
  readJson, writeJson, readText, writeText,
};

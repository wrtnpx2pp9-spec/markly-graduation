'use strict';
/**
 * 微信 iLink 数据访问：用户微信绑定 + 收发记录。
 * 所有 SQL 集中在此；业务逻辑在 src/wechat/ 与控制器里，不直接写 SQL。
 */
const crypto = require('crypto');

function toBinding(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    wxid: row.wxid,
    contextToken: row.context_token,
    nickname: row.nickname || '',
    boundAt: row.bound_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function getByUserId(db, userId) {
  return toBinding(db.prepare('SELECT * FROM wechat_bindings WHERE user_id=?').get(userId));
}
function getByWxid(db, wxid) {
  return toBinding(db.prepare('SELECT * FROM wechat_bindings WHERE wxid=?').get(wxid));
}
function count(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM wechat_bindings').get().c;
}
function listRecent(db, limit = 50) {
  return db.prepare('SELECT * FROM wechat_bindings ORDER BY last_seen_at DESC LIMIT ?').all(
    Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50))
  ).map(toBinding);
}
function activeCount(db) {
  return db.prepare("SELECT COUNT(*) AS c FROM wechat_bindings WHERE context_token<>''").get().c;
}

/** 把某个 wxid 的微信会话绑定到 app 用户；若该 wxid 已被别人绑定会转移到新用户。 */
function bindUserWxid(db, { userId, wxid, contextToken, nickname }) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM wechat_bindings WHERE wxid=?').run(wxid);
    db.prepare(
      `INSERT INTO wechat_bindings(user_id, wxid, context_token, nickname, bound_at, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         wxid=excluded.wxid, context_token=excluded.context_token,
         nickname=excluded.nickname, bound_at=excluded.bound_at, last_seen_at=excluded.last_seen_at`
    ).run(userId, wxid, contextToken || '', nickname || '', now, now, now);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
  return getByUserId(db, userId);
}

/** 用户主动解绑。 */
function unbindByUserId(db, userId) {
  const row = db.prepare('DELETE FROM wechat_bindings WHERE user_id=? RETURNING wxid').get(userId);
  return row ? row.wxid : null;
}

/** 用户已绑定时，任何入站消息刷新 context_token / last_seen。 */
function refreshContext(db, userId, contextToken, wxid, nickname) {
  db.prepare(
    'UPDATE wechat_bindings SET context_token=?, last_seen_at=?, nickname=COALESCE(NULLIF(?, \'\'), nickname) WHERE user_id=?'
  ).run(contextToken || '', Date.now(), (nickname || '').trim(), userId);
}
function invalidateContext(db, userId, wxid) {
  db.prepare('UPDATE wechat_bindings SET context_token=?, last_seen_at=? WHERE user_id=? AND wxid=?').run('', Date.now(), userId, wxid);
}

// ---------------- 收发记录 ----------------
function logDelivery(db, { userId, wxid, direction = 'out', kind = 'send', text, status = 'sent', error = '' }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO wechat_deliveries(id, user_id, wxid, direction, kind, text, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, userId || null, wxid || '', direction, kind, String(text || '').slice(0, 2000), status, String(error || '').slice(0, 500), Date.now());
  // 轻量裁剪：每个用户只保留最近 200 条收发记录
  db.prepare('DELETE FROM wechat_deliveries WHERE user_id=? AND id NOT IN (SELECT id FROM wechat_deliveries WHERE user_id=? ORDER BY created_at DESC LIMIT 200)')
    .run(userId || '', userId || '');
  return id;
}
function listDeliveries(db, userId, limit = 20) {
  const safe = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  return db.prepare(
    'SELECT * FROM wechat_deliveries WHERE user_id=? ORDER BY created_at DESC LIMIT ?'
  ).all(userId, safe).map(toDelivery);
}
/** 管理端：跨用户最近收发记录（带账号昵称）。 */
function listRecentDeliveries(db, limit = 40) {
  const safe = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 40));
  return db.prepare(
    `SELECT d.*, u.display_name AS user_display_name, u.username AS user_username
     FROM wechat_deliveries d LEFT JOIN users u ON u.id = d.user_id
     ORDER BY d.created_at DESC LIMIT ?`
  ).all(safe).map((row) => ({ ...toDelivery(row), userDisplayName: row.user_display_name || '', userUsername: row.user_username || '' }));
}
/** 管理端：已绑定账号列表（带昵称）。 */
function listBindingsWithUsers(db) {
  return db.prepare(
    `SELECT b.*, u.display_name AS user_display_name, u.username AS user_username
     FROM wechat_bindings b LEFT JOIN users u ON u.id = b.user_id
     ORDER BY b.last_seen_at DESC`
  ).all().map((row) => ({ ...toBinding(row), userDisplayName: row.user_display_name || '', userUsername: row.user_username || '' }));
}
function toDelivery(row) {
  return {
    id: row.id, userId: row.user_id, wxid: row.wxid, direction: row.direction,
    kind: row.kind, text: row.text, status: row.status, error: row.error, createdAt: row.created_at,
  };
}

module.exports = {
  toBinding,
  getByUserId, getByWxid, count, listRecent, activeCount,
  bindUserWxid, unbindByUserId, refreshContext, invalidateContext,
  logDelivery, listDeliveries, listRecentDeliveries, listBindingsWithUsers,
};

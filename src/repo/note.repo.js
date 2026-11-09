'use strict';
/** 通知数据访问。 */
const crypto = require('crypto');

function toNote(n) {
  return {
    id: n.id,
    userId: n.user_id,
    kind: n.kind,
    title: n.title,
    content: n.content,
    linkType: n.link_type,
    linkId: n.link_id,
    isRead: n.is_read,
    createdAt: n.created_at,
  };
}

function insert(db, { userId, kind, title, content, linkType, linkId, createdAt }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO notifications(id, user_id, kind, title, content, link_type, link_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'
  ).run(id, userId, kind, title, content || '', linkType || '', linkId || '', createdAt || Date.now());
  return id;
}
function listForUser(db, userId, limit = 100, offset = 0) {
  const safeLimit = Math.min(501, Math.max(1, Number.parseInt(limit, 10) || 100));
  const safeOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(offset, 10) || 0));
  return db.prepare('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?').all(userId, safeLimit, safeOffset);
}
function unreadCount(db, userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0').get(userId).c;
}
function markAllRead(db, userId) {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(userId);
}
function markOneRead(db, id, userId) {
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(id, userId);
}

module.exports = { toNote, insert, listForUser, unreadCount, markAllRead, markOneRead };

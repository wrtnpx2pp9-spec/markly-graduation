'use strict';
/** 生活记录数据访问。 */
const crypto = require('crypto');

function toLog(l) {
  if (!l) return null;
  return { id: l.id, userId: l.user_id, date: l.log_date, content: l.content, mood: l.mood, createdAt: l.created_at };
}

function byId(db, id) {
  return db.prepare('SELECT * FROM life_logs WHERE id=?').get(id);
}
function list(db, userId, from, to, limit, offset = 0) {
  // Reserve an extra row for the API's next-page detection at its 500-row cap.
  const safeLimit = Math.min(501, Math.max(1, Number.parseInt(limit, 10) || 100));
  const safeOffset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(offset, 10) || 0));
  const where = ['user_id=?'], args = [userId];
  if (from) { where.push('log_date>=?'); args.push(from); }
  if (to) { where.push('log_date<=?'); args.push(to); }
  return db.prepare('SELECT * FROM life_logs WHERE ' + where.join(' AND ') + ' ORDER BY log_date DESC, created_at DESC, id DESC LIMIT ? OFFSET ?').all(...args, safeLimit, safeOffset);
}
function insert(db, { userId, date, content, mood, createdAt }) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO life_logs(id, user_id, log_date, content, mood, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, date, content, mood, createdAt);
  return byId(db, id);
}
function remove(db, id) {
  db.prepare('DELETE FROM life_logs WHERE id=?').run(id);
}

module.exports = { toLog, byId, list, insert, remove };

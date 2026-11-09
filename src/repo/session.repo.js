'use strict';
/** 会话数据访问。 */
const crypto = require('crypto');
const digest = token => 'sha256:' + crypto.createHash('sha256').update(token).digest('hex');

function create(db, userId, expiresAt) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(digest(token), userId, Date.now(), expiresAt);
  return token;
}
function find(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return undefined;
  const hashed = digest(token);
  const current = db.prepare('SELECT * FROM sessions WHERE token=?').get(hashed);
  if (current) return current;
  const legacy = db.prepare('SELECT * FROM sessions WHERE token=?').get(token);
  if (legacy) db.prepare('UPDATE sessions SET token=? WHERE token=?').run(hashed, token);
  return legacy;
}
function remove(db, token) {
  db.prepare('DELETE FROM sessions WHERE token IN (?, ?)').run(token, digest(token));
}
function removeAllForUser(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
}
function purgeExpired(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = { create, find, remove, removeAllForUser, purgeExpired };

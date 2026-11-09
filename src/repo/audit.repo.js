'use strict';
const crypto = require('crypto');

function record(db, { actorId, method, path, ip, createdAt = Date.now() }) {
  db.prepare('INSERT INTO audit_logs(id, actor_id, method, path, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(crypto.randomUUID(), actorId || null, method, path, ip || '', createdAt);
}

function list(db, limit = 100) {
  const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || 100));
  return db.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?').all(safeLimit);
}

function toAudit(row) {
  return { id: row.id, actorId: row.actor_id, method: row.method, path: row.path, ip: row.ip, createdAt: row.created_at };
}

module.exports = { record, list, toAudit };

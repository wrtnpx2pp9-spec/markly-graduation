'use strict';
/** 通知控制器。 */
const noteRepo = require('../repo/note.repo');
const { sendJson } = require('../router');

function register(router) {
  router.add('GET', '/api/notifications', (c) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(c.query.limit, 10) || 100));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(c.query.offset, 10) || 0));
    const rows = noteRepo.listForUser(c.db, c.user.id, limit + 1, offset);
    sendJson(c.res, 200, { notifications: rows.slice(0, limit).map(noteRepo.toNote), unread: noteRepo.unreadCount(c.db, c.user.id), nextOffset: rows.length > limit ? offset + limit : null });
  });

  router.add('POST', '/api/notifications/read', (c) => {
    noteRepo.markAllRead(c.db, c.user.id);
    sendJson(c.res, 200, { ok: true });
  });

  router.add('PUT', '/api/notifications/:id/read', (c) => {
    noteRepo.markOneRead(c.db, c.params.id, c.user.id);
    sendJson(c.res, 200, { ok: true });
  });
}

module.exports = { register };

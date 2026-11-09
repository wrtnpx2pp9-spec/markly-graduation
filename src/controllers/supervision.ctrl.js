'use strict';
const userRepo = require('../repo/user.repo');
const { sendJson, sendError } = require('../router');

function register(router) {
  router.add('GET', '/api/supervision', (c) => {
    if (c.user.role !== 'supervisor') return sendError(c.res, 403, '只有监督者可以管理监督关系');
    const active = userRepo.activeSuperviseeIds(c.db, c.user.id);
    const available = userRepo.assignableSuperviseeIds(c.db, c.user.id).filter((id) => !active.includes(id));
    sendJson(c.res, 200, { active, available, used: userRepo.relationCount(c.db, c.user.id), capacity: userRepo.supervisorCapacity(c.db, c.user.id) });
  });

  router.add('POST', '/api/supervision/:id/bind', (c) => {
    const { db, user, params } = c;
    if (user.role !== 'supervisor') return sendError(c.res, 403, '只有监督者可以绑定用户');
    if (userRepo.activeSuperviseeIds(db, user.id).includes(params.id)) return sendJson(c.res, 200, { ok: true, reused: true });
    return sendError(c.res, 409, '请通过合作协商，由监督者确认接手并在计划接受后建立监督关系');
  });

  router.add('DELETE', '/api/supervision/:id/bind', (c) => {
    const { db, user, params } = c;
    if (user.role !== 'supervisor') return sendError(c.res, 403, '只有监督者可以解除绑定');
    const current = userRepo.activeSupervisorIds(db, params.id);
    if (!current.includes(user.id)) return sendError(c.res, 404, '绑定关系不存在');
    try {
      db.exec('BEGIN IMMEDIATE');
      userRepo.setRelations(db, params.id, current.filter((id) => id !== user.id));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 200, { ok: true });
  });
}

module.exports = { register };

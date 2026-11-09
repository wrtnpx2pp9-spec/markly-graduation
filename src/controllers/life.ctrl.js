'use strict';
/** 生活记录控制器。 */
const lifeRepo = require('../repo/life.repo');
const { sendJson, sendError } = require('../router');
const { validDate } = require('../plan-import');

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function register(router) {
  router.add('GET', '/api/life', (c) => {
    const { db, query, user } = c;
    const requestedUserId = query.userId || user.id;
    if (requestedUserId !== user.id && user.role !== 'admin') return sendError(c.res, 403, '无权查看该用户的生活记录');
    if ((query.from && !validDate(query.from)) || (query.to && !validDate(query.to)) || (query.from && query.to && query.from > query.to)) return sendError(c.res, 400, '请选择有效的日期范围，结束日期不能早于开始日期');
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit, 10) || 100));
    const offset = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Number.parseInt(query.offset, 10) || 0));
    const rows = lifeRepo.list(db, requestedUserId, query.from, query.to, limit + 1, offset);
    sendJson(c.res, 200, { logs: rows.slice(0, limit).map(lifeRepo.toLog), nextOffset: rows.length > limit ? offset + limit : null });
  });

  router.add('POST', '/api/life', (c) => {
    const { db, user, body } = c;
    if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 10000) return sendError(c.res, 400, '请填写1至10000字的生活记录');
    const date = body.date === undefined ? localDate() : body.date;
    if (!validDate(date)) return sendError(c.res, 400, '请选择有效的记录日期');
    if (body.mood !== undefined && (typeof body.mood !== 'string' || body.mood.length > 50)) return sendError(c.res, 400, '心情请填写50字以内的文字或表情');
    const log = lifeRepo.insert(db, {
      userId: user.id,
      date,
      content: body.content.trim(),
      mood: body.mood?.trim() || '',
      createdAt: Date.now(),
    });
    sendJson(c.res, 200, { log: lifeRepo.toLog(log) });
  });

  router.add('DELETE', '/api/life/:id', (c) => {
    const { db, user, params } = c;
    const r = lifeRepo.byId(db, params.id);
    if (!r) return sendError(c.res, 404, '记录不存在');
    if (r.user_id !== user.id) return sendError(c.res, 403, '只能删除自己的记录');
    lifeRepo.remove(db, r.id);
    sendJson(c.res, 200, { ok: true });
  });
}

module.exports = { register };

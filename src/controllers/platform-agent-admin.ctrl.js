'use strict';
const { sendJson, sendError } = require('../router');
function register(router, deps) {
  router.addRole('GET', '/api/admin/platform-agent/reports', c => sendJson(c.res, 200, { reports: deps.platformAgent.reports(c.user) }), ['admin']);
  router.addRole('POST', '/api/admin/platform-agent/reauth', async (c) => {
    try { sendJson(c.res, 200, deps.platformAgent.reauth(c.user, c.body?.secondaryPassword, c.authToken)); }
    catch (error) { sendError(c.res, error.statusCode || 400, error.message || '二级验证失败'); }
  }, ['admin']);
  router.addRole('POST', '/api/admin/platform-agent/runs', async (c) => {
    try { sendJson(c.res, 200, await deps.platformAgent.run(c.user, c.body, c.authToken, c.req.headers['x-platform-agent-reauth'])); }
    catch (error) { sendError(c.res, error.statusCode || 400, error.message || '平台 Pi 调用失败'); }
  }, ['admin']);
}
module.exports = { register };

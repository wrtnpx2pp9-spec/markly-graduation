'use strict';
/** 通知配置控制器（预留外部通知接口）。 */
const { URL } = require('url');
const { sendJson, sendError } = require('../router');

function register(router, deps) {
  const { notify } = deps;

  router.add('GET', '/api/notifyconfig', (c) => {
    if (c.user.role !== 'admin') return sendError(c.res, 403, '只有管理员可以查看通知配置');
    sendJson(c.res, 200, { config: notify.getNotifyConfig(c.db) });
  });

  router.add('PUT', '/api/notifyconfig', (c) => {
    if (c.user.role !== 'admin') return sendError(c.res, 403, '只有管理员可以修改通知配置');
    const b = c.body || {};
    let webhookUrl = '';
    if (b.webhookUrl) {
      try {
        const parsed = new URL(String(b.webhookUrl));
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return sendError(c.res, 400, 'Webhook 地址不合法');
        webhookUrl = parsed.toString();
      } catch { return sendError(c.res, 400, 'Webhook 地址不合法'); }
    }
    const cfg = { enabled: !!b.enabled, webhookUrl, command: String(b.command || '').trim() };
    notify.setNotifyConfig(c.db, cfg);
    sendJson(c.res, 200, { ok: true, config: cfg });
  });
}

module.exports = { register };

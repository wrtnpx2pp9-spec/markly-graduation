'use strict';
/**
 * 微信 iLink 控制器：
 *   /api/ilink/*      管理员：用户级机器人通道配置 / 收发日志
 *   /api/wechat/bind* 登录用户自助：独立机器人扫码 / 发送 1 / 测试推送 / 解绑
 */
const wechatRepo = require('../repo/wechat.repo');
const { sendJson, sendError } = require('../router');
const { maskWxid } = require('../wechat');

function safeBinding(binding) {
  if (!binding) return null;
  return {
    wxidMasked: maskWxid(binding.wxid),
    wxid: binding.wxid, // 仅限本人接口返回；不暴露 context_token
    boundAt: binding.boundAt,
    lastSeenAt: binding.lastSeenAt,
  };
}

function register(router, deps) {
  const { wechat } = deps;
  if (!wechat) throw new Error('微信 iLink 管理器未注入');
  const adm = (method, pattern, handler) => router.addRole(method, pattern, handler, ['admin']);

  // ---------------- 管理员：机器人绑定与通道 ----------------
  adm('GET', '/api/ilink/status', (c) => {
    const bindings = wechatRepo.listBindingsWithUsers(c.db);
    sendJson(c.res, 200, {
      config: wechat.getConfig(),
      binding: { connectionState: 'per_user', displayText: '用户独立实例', hasCredentials: false, hasQrcode: false },
      boundUsers: bindings.map((b) => ({
        userId: b.userId,
        displayName: b.userDisplayName || b.userUsername || '',
        wxidMasked: maskWxid(b.wxid),
        boundAt: b.boundAt,
        lastSeenAt: b.lastSeenAt,
      })),
    });
  });

  adm('POST', '/api/ilink/config', async (c) => {
    const b = c.body || {};
    const cfg = await wechat.setConfig({
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      mode: b.mode,
      baseUrl: undefined,
    });
    sendJson(c.res, 200, { ok: true, config: cfg });
  });

  adm('POST', '/api/ilink/bind', async (c) => {
    sendError(c.res, 410, '全局机器人绑定已停用，请让每个用户在自己的设置页面绑定独立机器人');
  });

  adm('POST', '/api/ilink/refresh', async (c) => {
    sendError(c.res, 410, '全局机器人已停用');
  });

  adm('POST', '/api/ilink/unbind', async (c) => {
    sendError(c.res, 410, '全局机器人已停用，请由用户解绑自己的实例');
  });

  // ---------------- 管理员：本地模拟服务操作 ----------------
  adm('POST', '/api/ilink/mock/confirm', async (c) => {
    sendError(c.res, 410, '全局模拟机器人已停用，请由用户在自己的设置页模拟扫码');
  });
  adm('POST', '/api/ilink/mock/expire', async (c) => {
    sendError(c.res, 410, '全局模拟机器人已停用');
  });
  adm('GET', '/api/ilink/log', (c) => {
    const logs = wechatRepo.listRecentDeliveries(c.db, c.query.limit);
    sendJson(c.res, 200, { logs: logs.map((l) => ({ ...l, wxidMasked: maskWxid(l.wxid) })) });
  });

  // ---------------- 登录用户：绑定自己的微信 ----------------
  const self = (method, pattern, handler) => router.add(method, pattern, handler);

  self('GET', '/api/wechat/bind', (c) => {
    const userId = c.user.id;
    const binding = wechat.userBinding(userId);
    const instance = wechat.userStatus(userId);
    const cfg = wechat.getConfig();
    sendJson(c.res, 200, {
      bound: !!(binding && binding.wxid),
      binding: safeBinding(binding),
      botBound: instance.hasCredentials,
      instance,
      mode: cfg.mode,
      enabled: cfg.enabled,
      botUrl: cfg.mode === 'mock' ? cfg.mockUrl || '' : cfg.baseUrl || '',
      deliveries: wechatRepo.listDeliveries(c.db, userId, c.query.limit).map((l) => ({ ...l, wxidMasked: maskWxid(l.wxid) })),
      mock: cfg.mode === 'mock',
    });
  });

  self('POST', '/api/wechat/bind/start', async (c) => {
    try { sendJson(c.res, 200, { ok: true, instance: await wechat.startUserBinding(c.user.id, !!(c.body || {}).force) }); }
    catch (error) { sendError(c.res, 400, error.message || '开始微信绑定失败'); }
  });

  self('POST', '/api/wechat/bind/refresh', async (c) => {
    try { sendJson(c.res, 200, { ok: true, instance: await wechat.refreshUserBinding(c.user.id) }); }
    catch (error) { sendError(c.res, 400, error.message || '刷新微信绑定失败'); }
  });

  self('POST', '/api/wechat/bind/mock/confirm', async (c) => {
    try { sendJson(c.res, 200, { ok: true, instance: await wechat.mockConfirmUserBinding(c.user.id) }); }
    catch (error) { sendError(c.res, 400, error.message || '模拟扫码失败'); }
  });

  self('POST', '/api/wechat/bind/test', async (c) => {
    const userId = c.user.id;
    const binding = wechat.userBinding(userId);
    if (!binding || !binding.wxid) return sendError(c.res, 400, '请先完成微信绑定再测试');
    const text = '【Markly】测试消息：微信提醒通道正常 ✅\n如果能看到这条，说明你的微信已收到 Markly 提醒。';
    try {
      await wechat.sendToUser(c.db, userId, text, { kind: 'test' });
      sendJson(c.res, 200, { ok: true, message: '已发送，请查看微信' });
    } catch (error) {
      sendError(c.res, 400, (error && error.code === 'ILINK_USER_BOT_UNBOUND') ? '请先在本账号设置页完成独立机器人扫码绑定' : (error.message || '发送失败'));
    }
  });

  // 本地模拟模式演示：模拟“用我自己的微信给机器人发消息”
  self('POST', '/api/wechat/bind/simulate', async (c) => {
    const userId = c.user.id;
    const cfg = wechat.getConfig();
    if (cfg.mode !== 'mock') return sendError(c.res, 400, '仅本地模拟模式下可模拟微信发送');
    try {
      let text = String((c.body || {}).text || '').trim();
      if (!text) text = '1';
      const result = await wechat.simulateUserInbound(userId, text);
      sendJson(c.res, 200, { ok: true, fromUserId: result.fromUserId, action: result.result ? result.result.action : 'none' });
    } catch (error) {
      sendError(c.res, 400, error.message || '模拟发送失败');
    }
  });

  self('DELETE', '/api/wechat/bind', async (c) => {
    await wechat.selfUnbind(c.user.id);
    sendJson(c.res, 200, { ok: true });
  });
}

module.exports = { register };

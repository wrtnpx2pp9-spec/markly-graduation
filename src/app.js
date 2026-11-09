'use strict';
/**
 * 应用装配层（组合根）：创建依赖（db / security / notify / repos），
 * 注册各域控制器，返回一个可分发请求的路由器。
 */
const { getDb, closeDb } = require('./db');
const { createRouter } = require('./router');
const security = require('./security');
const notify = require('./notify');
const scope = require('./scope');

const authCtrl = require('./controllers/auth.ctrl');
const dashboardCtrl = require('./controllers/dashboard.ctrl');
const planCtrl = require('./controllers/plan.ctrl');
const taskCtrl = require('./controllers/task.ctrl');
const lifeCtrl = require('./controllers/life.ctrl');
const notificationCtrl = require('./controllers/notification.ctrl');
const settingCtrl = require('./controllers/setting.ctrl');
const adminCtrl = require('./controllers/admin.ctrl');
const rankCtrl = require('./controllers/rank.ctrl');
const supervisionCtrl = require('./controllers/supervision.ctrl');
const wechatCtrl = require('./controllers/wechat.ctrl');
const planAgent = require('./plan-agent/service');

function createApp(db, opts = {}) {
  const deps = { db, security, notify, scope, wechat: opts.wechat || null };
  if (deps.wechat) notify.setWechat(deps.wechat);
  const router = createRouter({ db, deps });
  deps.planAgent = planAgent.create(db, deps);
  deps.platformAgent = require('./platform-agent/service').create(db);
  require('./controllers/plan-import.ctrl').register(router, deps);
  require('./controllers/plan-agent.ctrl').register(router, deps);
  require('./controllers/plan-agent-admin.ctrl').register(router, deps);
  require('./controllers/platform-agent-admin.ctrl').register(router, deps);

  authCtrl.register(router, deps);
  require('./controllers/registration.ctrl').register(router, deps);
  dashboardCtrl.register(router, deps);
  planCtrl.register(router, deps);
  require('./controllers/daily-planning.ctrl').register(router,deps);
  taskCtrl.register(router, deps);
  lifeCtrl.register(router, deps);
  notificationCtrl.register(router, deps);
  settingCtrl.register(router, deps);
  adminCtrl.register(router, deps);
  rankCtrl.register(router, deps);
  supervisionCtrl.register(router, deps);
  require('./controllers/cooperation-history.ctrl').register(router, deps);
  require('./controllers/market.ctrl').register(router, deps);
  if (deps.wechat) wechatCtrl.register(router, deps);

  router.deps = deps;
  return router;
}

module.exports = { createApp, getDb, closeDb };

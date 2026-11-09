'use strict';
const {sendJson,sendError}=require('../router');
function register(router,deps){const wrap=fn=>async c=>{try{await fn(c);}catch(e){sendError(c.res,e.statusCode||400,e.message||'配置失败');}};router.addRole('GET','/api/admin/plan-agent/config',c=>sendJson(c.res,200,{config:deps.planAgent.config()}),['admin']);router.addRole('PUT','/api/admin/plan-agent/config',wrap(c=>sendJson(c.res,200,{config:deps.planAgent.putConfig(c.body)})),['admin']);router.addRole('POST','/api/admin/plan-agent/test',c=>sendJson(c.res,200,deps.planAgent.test()),['admin']);}
module.exports={register};

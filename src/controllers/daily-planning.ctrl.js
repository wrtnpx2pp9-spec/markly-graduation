'use strict';
const crypto=require('crypto'),repo=require('../repo/daily-planning.repo'),plans=require('../repo/plan.repo');
const users=require('../repo/user.repo'),lifecycle=require('../plan-lifecycle');
const {sendJson,sendError}=require('../router');
const {validDate,shift}=require('../plan-import');
function calendar(ts){const d=new Date(ts);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function register(router,{notify}) {
  function context(c,write=true){
    const p=plans.byId(c.db,c.params.id);
    if(!p || p.kind!=='cycle' || ![p.creator_id,p.assignee_id].includes(c.user.id)){sendError(c.res,404,'阶段不存在');return null;}
    if(write && !lifecycle.writable(c.db,p)){sendError(c.res,409,'阶段或合作尚未生效或已结束');return null;}
    return p;
  }
  function dateError(p,date){
    const today=calendar(Date.now());
    if(!validDate(date)||date<today||date>shift(today,13))return '每日细程仅可安排今天起14个日历日，建议先安排未来2—3天';
    if(date<calendar(p.start_at)||date>calendar(p.due_at))return '日期不在所属阶段范围内';
    return null;
  }
  function contentError(base,payload){
    if(!payload || typeof payload.rest!=='boolean' || !Array.isArray(payload.items) || payload.items.length>12 || (payload.rest?payload.items.length!==0:payload.items.length===0))return '每日至少一项、最多12项；休息日不安排任务';
    const ids=new Set();
    for(const item of payload.items){
      if(!item||typeof item.title!=='string'||!item.title.trim()||item.title.length>200)return '每项任务请填写200字以内的具体内容';
      if(item.id && (ids.has(item.id)||!base?.items.some(i=>i.id===item.id)))return '任务来源不一致，请刷新原安排';
      if(item.id)ids.add(item.id);
    }
    if(['submitted','approved'].includes(base?.day.checkin_state))return '已提交审核或已确认的执行日不能改写';
    for(const item of base?.items||[])if(item.status==='done'&&!payload.items.some(i=>i.id===item.id&&i.title===item.title))return '已勾选完成的事项必须原样保留，可调整其他未完成事项';
    return null;
  }
  function signal(c,p,title){const id=c.user.id===p.creator_id?p.assignee_id:p.creator_id;notify.deliver(c.db,{userId:id,recipientUser:users.byId(c.db,id),kind:'plan_update',title,content:p.title+'：请打开阶段的每日安排查看并处理。',linkType:'plan',linkId:p.id});}
  router.add('GET','/api/plans/:id/daily-proposals',c=>{
    const p=context(c,false);if(!p)return;
    const rows=c.db.prepare("SELECT * FROM daily_plan_proposals WHERE plan_id=? AND (submitted_at IS NOT NULL OR proposer_id=?) ORDER BY updated_at DESC,id DESC").all(p.id,c.user.id);
    sendJson(c.res,200,{proposals:rows.map(repo.view),today:calendar(Date.now()),lastDate:shift(calendar(Date.now()),13),writable:lifecycle.writable(c.db,p)});
  });
  router.add('POST','/api/plans/:id/daily-proposals',c=>{
    const p=context(c);if(!p)return;
    const date=c.body.date,error=dateError(p,date);if(error)return sendError(c.res,400,error);
    c.db.exec('BEGIN IMMEDIATE');
    try{
      if(!lifecycle.writable(c.db,plans.byId(c.db,p.id))){c.db.exec('ROLLBACK');return sendError(c.res,409,'阶段或合作已结束');}
      const existing=c.db.prepare("SELECT * FROM daily_plan_proposals WHERE plan_id=? AND day_date=? AND status IN ('draft','submitted')").get(p.id,date);
      const editing=existing && existing.id===c.body.draftId && existing.proposer_id===c.user.id && existing.status==='draft' && existing.version===c.body.version;
      if((existing&&!editing)||(c.body.draftId&&!editing)){c.db.exec('ROLLBACK');return sendError(c.res,409,'这一天已有草稿或待确认调整，或草稿版本已变化，请刷新后处理');}
      const base=repo.snapshot(c.db,p.id,date),invalid=contentError(base,c.body.payload);
      if(invalid){c.db.exec('ROLLBACK');return sendError(c.res,409,invalid);}
      const reason=String(c.body.reason||'').trim();
      if(reason.length>500){c.db.exec('ROLLBACK');return sendError(c.res,400,'安排说明请控制在500字以内');}
      const id=editing?existing.id:crypto.randomUUID(),now=Date.now();
      const payload={rest:c.body.payload.rest,items:c.body.payload.items.map(i=>({...(i.id?{id:i.id}:{}),title:i.title.trim()}))};
      if(editing)c.db.prepare('UPDATE daily_plan_proposals SET base_json=?,payload_json=?,reason=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(base),JSON.stringify(payload),reason,now,id);
      else c.db.prepare('INSERT INTO daily_plan_proposals(id,plan_id,day_date,proposer_id,base_json,payload_json,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,p.id,date,c.user.id,JSON.stringify(base),JSON.stringify(payload),reason,now,now);
      c.db.exec('COMMIT');sendJson(c.res,200,{proposal:repo.view(c.db.prepare('SELECT * FROM daily_plan_proposals WHERE id=?').get(id))});
    }catch(e){c.db.exec('ROLLBACK');throw e;}
  });
  router.add('POST','/api/plans/:id/daily-proposals/:proposalId/action',c=>{
    const p=context(c);if(!p)return;
    c.db.exec('BEGIN IMMEDIATE');
    try{
      const row=c.db.prepare('SELECT * FROM daily_plan_proposals WHERE id=? AND plan_id=?').get(c.params.proposalId,p.id);
      const fail=(status,message)=>{c.db.exec('ROLLBACK');return sendError(c.res,status,message);};
      if(!lifecycle.writable(c.db,plans.byId(c.db,p.id)))return fail(409,'阶段或合作已结束');
      if(!row||row.version!==c.body.version)return fail(409,'提案已更新，请刷新后重试');
      const action=c.body.action,mine=row.proposer_id===c.user.id,note=String(c.body.note||'').trim().slice(0,500);
      let status;
      if(action==='withdraw' && mine && ['draft','submitted'].includes(row.status))status='withdrawn';
      else if(action==='submit' && mine && row.status==='draft')status='submitted';
      else if(['accept','decline'].includes(action)&&!mine&&row.status==='submitted')status=action==='accept'?'accepted':'declined';
      else return fail(403,'只有发起人可提交或撤回；只有对方可确认或退回');
      if(status==='declined'&&!note)return fail(400,'请说明调整建议');
      if(['submitted','accepted'].includes(status)){
        const error=dateError(p,row.day_date);if(error)return fail(409,error);
        const current=repo.snapshot(c.db,p.id,row.day_date);
        if(!repo.sameExecutionSnapshot(current,JSON.parse(row.base_json)))return fail(409,'原安排或执行状态已变化，请撤回并基于最新记录重新安排');
        const invalid=contentError(current,JSON.parse(row.payload_json));if(invalid)return fail(409,invalid);
      }
      if(status==='submitted')c.db.prepare('UPDATE daily_plan_proposals SET submitted_at=COALESCE(submitted_at,?) WHERE id=?').run(Date.now(),row.id);
      if(status==='accepted')repo.apply(c.db,p,row);
      c.db.prepare('UPDATE daily_plan_proposals SET status=?,version=version+1,decision_note=?,reviewer_id=?,updated_at=? WHERE id=?').run(status,note,['accepted','declined'].includes(status)?c.user.id:null,Date.now(),row.id);
      if(status!=='withdrawn'||row.status==='submitted')signal(c,p,({submitted:'每日安排待你确认',accepted:'每日安排已确认生效',declined:'每日安排需要调整',withdrawn:'每日安排提案已撤回'})[status]);
      c.db.exec('COMMIT');sendJson(c.res,200,{ok:true});
    }catch(e){c.db.exec('ROLLBACK');throw e;}
  });
}
module.exports={register};

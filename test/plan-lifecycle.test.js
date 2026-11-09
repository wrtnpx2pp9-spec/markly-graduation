'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
const lifecycle = require('../src/plan-lifecycle');
let current, serial=0;
const deps = {notify:{deliver(){}},security:{authenticate:()=>({user:current})}};
const router = require('../src/router').createRouter({db,deps});
for(const name of ['plan','task','market','cooperation-history']) require(`../src/controllers/${name}.ctrl`).register(router,deps);
function call(user,method,url,body={}) {
  current=users.byId(db,user.id);let result;
  router.dispatch(method,url,{method,url,headers:{}},{writeHead(s){this.status=s;},end(text){result={http:this.status,...JSON.parse(text)};}},{},body);
  return result;
}
function ok(user,method,url,body) {const r=call(user,method,url,body);assert.equal(r.http,200,JSON.stringify(r));return r;}
function pair(bound=true) {
  const make=role=>users.insert(db,{username:`lifecycle-${++serial}`,role,passwordHash:'hash',salt:'salt',createdAt:Date.now()});
  const sup=make('supervisor'),sub=make('supervisee');
  require('../src/repo/cooperation.repo').save(db,sup,sup.id,{state:'active',capacity:2,agreementRef:'test',note:'test',published:true});
  if(bound)users.setRelations(db,sub.id,[sup.id]);return {sup,sub};
}
function date(offset) {const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return +d;}
function input(sub,start=-3,end=-1) {return {title:'长期目标',assigneeId:sub.id,startAt:date(start),dueAt:date(end)+86399000,dailyContent:'练习'};}
function bundle(sup,sub,accept=true) {
  const root=ok(sup,'POST','/api/plan-bundles',input(sub)).plan;
  if(accept)ok(sub,'POST',`/api/plans/${root.id}/agreement`,{decision:'accept'});
  return {root,stage:db.prepare('SELECT * FROM plans WHERE parent_id=?').get(root.id)};
}
test('老关系整套提案必须从根目标接受或退回，不能拆分操作',()=>{
  const {sup,sub}=pair(),{root,stage}=bundle(sup,sub,false);
  for(const decision of ['accept','decline'])assert.equal(call(sub,'POST',`/api/plans/${stage.id}/agreement`,{decision,note:'调整'}).http,409);
  assert.equal(call(sup,'POST',`/api/plans/${stage.id}/archive`).http,409);
  assert.equal(plans.byId(db,stage.id).status,'proposed');
  ok(sub,'POST',`/api/plans/${root.id}/agreement`,{decision:'accept'});
  assert.equal(plans.byId(db,stage.id).status,'active');
});
test('撤销首计划恢复原协商制定状态，允许重发；子阶段不能撤销整套提案',()=>{
  const {sup,sub}=pair(false);
  const req=ok(sub,'POST','/api/requests',{personId:sup.id,goal:'学习',mode:'quick',desiredStartAt:date(0)});
  ok(sup,'POST',`/api/requests/${req.id}/confirm`);
  const body={...input(sub),requestId:req.id};
  const first=ok(sup,'POST','/api/plan-bundles',body).plan;
  ok(sup,'POST',`/api/plans/${first.id}/archive`);
  const request=db.prepare('SELECT * FROM service_requests WHERE id=?').get(req.id);
  assert.equal(request.status,'planning');assert.equal(request.plan_id,null);
  assert.equal(call(sub,'POST',`/api/plans/${first.id}/agreement`,{decision:'accept'}).http,409);
  const next=ok(sup,'POST','/api/plan-bundles',body).plan;
  ok(sub,'POST',`/api/plans/${next.id}/agreement`,{decision:'accept'});
});
test('续期保留原阶段及原约定，接受后扩展覆盖日期，拒绝日期交叉并允许多周阶段',()=>{
  const {sup,sub}=pair(),{root,stage}=bundle(sup,sub);
  const before=JSON.stringify(plans.listDays(db,stage.id));
  const create=(start,end)=>call(sup,'POST','/api/plans',{...input(sub,start,end),kind:'cycle',parentId:root.id});
  assert.equal(create(-1,2).http,409);
  const next=create(0,20);assert.equal(next.http,200);
  assert.equal(create(20,22).http,409);
  assert.equal(plans.coverage(db,root).dueAt,root.dueAt);
  ok(sub,'POST',`/api/plans/${next.plan.id}/agreement`,{decision:'accept'});
  const current=ok(sub,'GET','/api/plans').plans.find(p=>p.id===root.id);
  assert.equal(current.dueAt,root.dueAt);assert.equal(current.coverageEnd,next.plan.calendarEnd);
  assert.equal(plans.byId(db,stage.id).status,'active');assert.equal(JSON.stringify(plans.listDays(db,stage.id)),before);
  assert.equal(next.plan.cooperationPeriodId,root.cooperationPeriodId);
});
test('接受阶段再次验证冲突，退回阶段不占用日期',()=>{
  const {sup,sub}=pair(),{root}=bundle(sup,sub);
  const body={...input(sub,0,1),kind:'cycle',parentId:root.id};
  const next=ok(sup,'POST','/api/plans',body).plan;
  const legacy=plans.insert(db,{...body,description:'legacy',creatorId:sup.id,assigneeId:sub.id,status:'active',createdAt:Date.now()});
  assert.equal(call(sub,'POST',`/api/plans/${next.id}/agreement`,{decision:'accept'}).http,409);
  assert.equal(plans.byId(db,next.id).status,'proposed');
  plans.archive(db,legacy.id);
  ok(sub,'POST',`/api/plans/${next.id}/agreement`,{decision:'decline',note:'调整'});
  const revised=ok(sup,'POST','/api/plans',body).plan;
  ok(sub,'POST',`/api/plans/${revised.id}/agreement`,{decision:'accept'});
});
test('归档原子取消未完成任务并保留提交和已确认任务，协作任务不能删除',()=>{
  const {sup,sub}=pair(),{root,stage}=bundle(sup,sub);
  const create=()=>ok(sup,'POST','/api/tasks',{title:'附属任务',planId:stage.id,assigneeId:sub.id}).task;
  const pending=create(),submitted=create(),done=create();
  ok(sub,'POST',`/api/tasks/${submitted.id}/checkin`,{note:'保留原提交'});
  ok(sub,'POST',`/api/tasks/${done.id}/checkin`);ok(sup,'POST',`/api/tasks/${done.id}/review`,{decision:'approved'});
  ok(sup,'POST',`/api/plans/${root.id}/archive`);
  assert.equal(plans.byId(db,stage.id).status,'archived');
  for(const t of [pending,submitted])assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(t.id).status,'cancelled');
  assert.equal(db.prepare('SELECT checkin_note FROM tasks WHERE id=?').get(submitted.id).checkin_note,'保留原提交');
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(done.id).status,'done');
  ok(sub,'DELETE',`/api/relations/${sup.id}`);
  assert.equal(call(sup,'DELETE',`/api/tasks/${done.id}`).http,409);
  assert.equal(ok(sub,'GET',`/api/cooperation-history/plans/${root.id}`).records.find(p=>p.id===stage.id).tasks.length,3);
});
test('归档失败时回滚任务取消与计划状态',()=>{
  const {sup,sub}=pair(),{root}=bundle(sup,sub);
  const task=ok(sup,'POST','/api/tasks',{title:'任务',planId:root.id,assigneeId:sub.id}).task;
  db.exec("CREATE TEMP TRIGGER fail_archive BEFORE UPDATE OF status ON plans WHEN NEW.status='archived' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  try {assert.throws(()=>plans.archive(db,root.id),/test rollback/);}finally{db.exec('DROP TRIGGER fail_archive');}
  assert.equal(plans.byId(db,root.id).status,'active');assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'pending');
});
test('阶段到期或全部审核才可复盘；归档及解绑后禁止留言和确认',()=>{
  const {sup,sub}=pair(),{root,stage}=bundle(sup,sub);
  assert.equal(lifecycle.readyForReview(db,stage),true);
  const future=ok(sup,'POST','/api/plans',{...input(sub,1,3),kind:'cycle',parentId:root.id}).plan;
  ok(sub,'POST',`/api/plans/${future.id}/agreement`,{decision:'accept'});
  assert.equal(lifecycle.readyForReview(db,plans.byId(db,future.id)),false);
  db.prepare("UPDATE plan_days SET checkin_state='submitted' WHERE plan_id=?").run(future.id);
  assert.equal(lifecycle.readyForReview(db,plans.byId(db,future.id)),false);
  db.prepare("UPDATE plan_days SET checkin_state='approved' WHERE plan_id=?").run(future.id);
  assert.equal(lifecycle.readyForReview(db,plans.byId(db,future.id)),true);
  ok(sub,'PUT',`/api/plans/${stage.id}/stage-review/self`,{summary:'复盘'});
  ok(sup,'PUT',`/api/plans/${stage.id}/stage-review/supervisor`,{observation:'反馈'});
  const day=plans.listDays(db,stage.id)[0];
  ok(sub,'POST',`/api/plans/${stage.id}/days/${day.id}/comments`,{content:'合作内留言'});
  ok(sub,'DELETE',`/api/relations/${sup.id}`);
  assert.equal(call(sup,'POST',`/api/plans/${stage.id}/days/${day.id}/comments`,{content:'结束后留言'}).http,409);
  assert.equal(call(sub,'POST',`/api/plans/${stage.id}/stage-review/confirm`).http,409);
  assert.equal(call(sup,'POST',`/api/plans/${stage.id}/stage-review/confirm`).http,409);
});
test('取消任务保留提交；新合作者不读旧计划；再次合作不复活旧目标',()=>{
  const {sup,sub}=pair(),{root}=bundle(sup,sub);
  const task=ok(sup,'POST','/api/tasks',{title:'临时任务',assigneeId:sub.id}).task;
  ok(sub,'POST',`/api/tasks/${task.id}/checkin`,{note:'已提交内容'});
  assert.equal(call(sub,'POST',`/api/tasks/${task.id}/cancel`).http,403);
  ok(sup,'POST',`/api/tasks/${task.id}/cancel`);
  assert.equal(db.prepare('SELECT checkin_note FROM tasks WHERE id=?').get(task.id).checkin_note,'已提交内容');
  ok(sub,'DELETE',`/api/relations/${sup.id}`);
  const other=pair().sup;users.setRelations(db,sub.id,[other.id]);
  assert.equal(call(other,'GET',`/api/cooperation-history/plans/${root.id}`).http,404);
  users.setRelations(db,sub.id,[other.id,sup.id]);
  const fresh=bundle(sup,sub).root;assert.notEqual(fresh.cooperationPeriodId,root.cooperationPeriodId);
  assert.ok(!ok(sub,'GET','/api/plans').plans.some(p=>p.id===root.id));
  assert.equal(call(sup,'POST','/api/plans',{...input(sub,0,2),kind:'cycle',parentId:root.id}).http,400);
});
test.after(()=>database.closeDb());
test('升级修复归档遗留状态且重复执行不改提交内容及已关闭协商',()=>{
  const {sup,sub}=pair(),{root}=bundle(sup,sub);
  const task=ok(sup,'POST','/api/tasks',{title:'旧提交',planId:root.id,assigneeId:sub.id}).task;
  ok(sub,'POST',`/api/tasks/${task.id}/checkin`,{note:'旧提交保留'});
  db.prepare("UPDATE plans SET status='archived' WHERE id=?").run(root.id);
  for(const status of ['plan_proposed','closed'])db.prepare('INSERT INTO service_requests(id,supervisor_id,supervisee_id,initiator_id,goal,status,plan_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(`legacy-${status}`,sup.id,sub.id,sub.id,'旧协商',status,root.id,1,1);
  plans.repairArchivedWorkflows(db);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(task.id).status,'cancelled');
  assert.equal(db.prepare('SELECT checkin_note FROM tasks WHERE id=?').get(task.id).checkin_note,'旧提交保留');
  assert.equal(db.prepare("SELECT status FROM service_requests WHERE id='legacy-plan_proposed'").get().status,'planning');
  assert.equal(db.prepare("SELECT status FROM service_requests WHERE id='legacy-closed'").get().status,'closed');
  const before=JSON.stringify(db.prepare("SELECT * FROM service_requests WHERE id LIKE 'legacy-%'").all());
  plans.repairArchivedWorkflows(db);assert.equal(JSON.stringify(db.prepare("SELECT * FROM service_requests WHERE id LIKE 'legacy-%'").all()),before);
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'markly-history-'));process.env.DB_PATH=path.join(dir,'test.db');
const database=require('../src/db');let db=database.getDb();
const users=require('../src/repo/user.repo'),plans=require('../src/repo/plan.repo'),reviews=require('../src/repo/phase-review.repo');
let current;const deps={notify:{deliver(){}},security:{authenticate:()=>({user:current})}};
let router;function setupRouter(){router=require('../src/router').createRouter({db,deps});require('../src/controllers/cooperation-history.ctrl').register(router);require('../src/controllers/plan.ctrl').register(router,deps);require('../src/controllers/market.ctrl').register(router,deps);}
setupRouter();
function add(username,role){return users.insert(db,{username,role,passwordHash:'hash',salt:'salt',displayName:username,createdAt:Date.now()});}
const sup=add('history-supervisor','supervisor'),sub=add('history-student','supervisee'),stranger=add('history-other','supervisor');
require('../src/repo/cooperation.repo').save(db,sup,sup.id,{state:'active',capacity:2,agreementRef:'test-contract',note:'测试合作',published:true});
users.setRelations(db,sub.id,[sup.id]);
const root=plans.insert(db,{title:'历史学习目标',description:'保留原说明',creatorId:sup.id,assigneeId:sub.id,kind:'phase',startAt:1,dueAt:100,status:'active',createdAt:Date.now()});
const cycle=plans.insert(db,{title:'基础阶段',description:'阶段内容',creatorId:sup.id,assigneeId:sub.id,parentId:root.id,kind:'cycle',startAt:1,dueAt:100,status:'active',createdAt:Date.now()});
plans.insertDays(db,cycle.id,[{id:'history-day',seq:1,day_date:'2030-01-01',content:'练习',items:['听力'],createdAt:Date.now()}]);
db.prepare("UPDATE plan_days SET checkin_state='approved',note='执行心得',checkin_review_note='反馈记录' WHERE id='history-day'").run();
plans.addDayComment(db,{dayId:'history-day',planId:cycle.id,authorId:sub.id,authorRole:'supervisee',content:'原有留言',createdAt:Date.now()});
db.prepare("INSERT INTO tasks(id,plan_id,title,note,creator_id,assignee_id,status,checkin_note,created_at) VALUES('history-task',?,'附加练习','原始要求',?,?,'done','任务心得',?)").run(cycle.id,sup.id,sub.id,Date.now());
function call(user,url){current=users.byId(db,user.id);const u=new URL(url,'http://local');let result;router.dispatch('GET',u.pathname,{method:'GET',headers:{}},{writeHead(s){this.status=s;},end(text){result={status:this.status,...JSON.parse(text)};}},Object.fromEntries(u.searchParams),{});return result;}
function snapshot(){return JSON.stringify({plans:db.prepare('SELECT * FROM plans ORDER BY id').all(),days:db.prepare('SELECT * FROM plan_days ORDER BY id').all(),items:db.prepare('SELECT * FROM plan_day_items ORDER BY id').all(),comments:db.prepare('SELECT * FROM plan_day_comments ORDER BY id').all(),tasks:db.prepare('SELECT * FROM tasks ORDER BY id').all()});}

test('合作对象列表如实区分当前与已结束关系，解绑不影响另一监督者',()=>{
  const learner=add('history-state-learner','supervisee');
  const first=add('history-state-first','supervisor'),second=add('history-state-second','supervisor');
  for(const supervisor of [first,second])require('../src/repo/cooperation.repo').save(db,supervisor,supervisor.id,{state:'active',capacity:2,agreementRef:'test-contract',note:'测试授权',published:true});
  users.setRelations(db,learner.id,[first.id,second.id]);
  const state=(viewer,personId)=>call(viewer,'/api/cooperation-history').list.find(p=>p.personId===personId);
  assert.equal(state(learner,first.id).active,true);
  assert.equal(state(first,learner.id).active,true);
  assert.equal(state(learner,second.id).active,true);
  users.setRelations(db,learner.id,[second.id]);
  assert.equal(state(learner,first.id).active,false);
  assert.ok(state(learner,first.id).periods[0].endedAt);
  assert.equal(state(learner,second.id).active,true);
  assert.equal(state(second,learner.id).active,true);
});
test('历史查询只读，已完成阶段仍在当前目标列表，原有阶段内容完整',()=>{
  const before=snapshot();
  const list=call(sub,'/api/cooperation-history/plans');assert.equal(list.status,200);assert.equal(list.plans[0].completed,true);
  const detail=call(sub,'/api/cooperation-history/plans/'+root.id);assert.equal(detail.status,200);
  const stage=detail.records.find(p=>p.id===cycle.id);assert.equal(stage.days[0].note,'执行心得');assert.equal(stage.days[0].comments[0].content,'原有留言');assert.equal(stage.days[0].items[0].title,'听力');assert.equal(stage.tasks[0].checkinNote,'任务心得');
  assert.ok(call(sub,'/api/plans').plans.some(p=>p.id===cycle.id));assert.equal(snapshot(),before);
});
test('合作结束后双方仍能查询历史，第三方不能读取或通过对象筛选越权',()=>{
  db.exec('BEGIN');users.setRelations(db,sub.id,[]);db.exec('COMMIT');
  const before=snapshot();
  assert.equal(call(sub,'/api/plans').plans.some(p=>p.id===root.id),false);
  for(const user of [sup,sub])assert.equal(call(user,'/api/cooperation-history/plans/'+root.id).status,200);
  assert.equal(call(stranger,'/api/cooperation-history/plans/'+root.id).status,404);
  assert.deepEqual(call(stranger,'/api/cooperation-history/plans?personId='+sub.id).plans,[]);
  const list=call(sub,'/api/cooperation-history');assert.equal(list.list[0].active,false);assert.ok(list.list[0].periods[0].endedAt);
  assert.equal(snapshot(),before);
});
test('再次合作新增起止记录，不覆盖前一段合作和历史计划；重启迁移幂等',()=>{
  const first=call(sub,'/api/cooperation-history').list[0].periods[0];
  users.setRelations(db,sub.id,[sup.id]);users.setRelations(db,sub.id,[sup.id]);
  let periods=call(sub,'/api/cooperation-history').list[0].periods;assert.equal(periods.length,2);assert.ok(periods.some(p=>p.id===first.id&&p.endedAt===first.endedAt));
  assert.equal(periods.filter(p=>p.endedAt===null).length,1);
  const before=snapshot();database.closeDb();db=database.getDb();setupRouter();assert.equal(snapshot(),before);
  periods=call(sub,'/api/cooperation-history').list[0].periods;assert.equal(periods.length,2);
});
test('历史支持按阶段名及合作对象查询和分页，逾期未完成不伪装为完成',()=>{
  assert.equal(call(sub,'/api/cooperation-history/plans?q='+encodeURIComponent('基础阶段')).plans[0].id,root.id);
  for(let i=0;i<32;i++)plans.insert(db,{title:'旧计划'+i,description:'',creatorId:sup.id,assigneeId:sub.id,kind:'task',startAt:1,dueAt:2,status:'archived',createdAt:i});
  const first=call(sub,'/api/cooperation-history/plans?personId='+sup.id),second=call(sub,'/api/cooperation-history/plans?personId='+sup.id+'&offset='+first.nextOffset);
  assert.equal(first.plans.length,30);assert.equal(second.plans.length,3);assert.equal(second.nextOffset,null);
  assert.equal(new Set([...first.plans,...second.plans].map(p=>p.id)).size,33);
  assert.equal(second.plans[0].completed,false);
});
test('阶段复盘历史继续沿用双方提交前的隐私边界',()=>{
  reviews.saveSelf(db,{parentPlanId:root.id,cyclePlanId:cycle.id,superviseeId:sub.id,supervisorId:sup.id,summary:'尚未公开的复盘',difficulty:'',helpfulMethod:'',nextAction:'继续',now:Date.now()});
  const result=user=>call(user,'/api/cooperation-history/plans/'+root.id).records.find(p=>p.id===cycle.id).stageReview;
  assert.equal(result(sup).selfSummary,'');assert.equal(result(sub).selfSummary,'尚未公开的复盘');
});
test('现有目标页保留已完成阶段、成长足迹及原来的当前阶段选择',()=>{
  const c=vm.createContext({st:{plans:[{id:'goal',kind:'phase',status:'active',completed:true}],_pd:{}},me:{id:'student',role:'supervisee'},esc:v=>String(v),Date});
  vm.runInContext(fs.readFileSync('public/js/phase.js','utf8'),c);
  assert.equal(vm.runInContext('phaseLongPlans().length',c),1);
  const markup=vm.runInContext(`phaseJourneyHTML([{id:'current',title:'稳住周末节奏',status:'active',dueAt:1},{id:'done',title:'固定每日学习节奏',status:'active',completed:true,stageReview:{lockedAt:1}}])`,c);
  assert.match(markup,/当前阶段/);assert.match(markup,/成长足迹/);assert.match(markup,/固定每日学习节奏/);assert.match(markup,/查看联名卡/);
});

function invoke(user,method,url,body={}) {
  current=users.byId(db,user.id);const u=new URL(url,'http://local');let result;
  router.dispatch(method,u.pathname,{method,url:u.pathname,headers:{}},{writeHead(s){this.status=s;},end(text){result={status:this.status,...JSON.parse(text)};}},Object.fromEntries(u.searchParams),body);return result;
}
test('重建合作后旧批次只在历史中，新计划留在当前批次',()=>{
  assert.equal(call(sub,'/api/plans').plans.some(p=>p.id===root.id),false);
  const fresh=plans.insert(db,{title:'第二次合作新计划',description:'',creatorId:sup.id,assigneeId:sub.id,kind:'phase',startAt:1,dueAt:100,status:'active',createdAt:Date.now()});
  assert.ok(call(sub,'/api/plans').plans.some(p=>p.id===fresh.id));
  const oldPeriod=plans.byId(db,root.id).cooperation_period_id,newPeriod=plans.byId(db,fresh.id).cooperation_period_id;
  assert.notEqual(oldPeriod,newPeriod);
  const old=call(sub,'/api/cooperation-history/plans?personId='+sup.id+'&periodId='+oldPeriod);
  assert.ok(old.plans.some(p=>p.id===root.id));assert.equal(old.plans.some(p=>p.id===fresh.id),false);
});
test('复盘双方确认不等于执行全部完成',()=>{
  db.prepare("UPDATE plan_days SET checkin_state='unsubmitted' WHERE id='history-day'").run();
  db.prepare('UPDATE phase_stage_reviews SET locked_at=? WHERE cycle_plan_id=?').run(Date.now(),cycle.id);
  const detail=call(sub,'/api/cooperation-history/plans/'+root.id),stage=detail.records.find(p=>p.id===cycle.id);
  assert.equal(stage.reviewConfirmed,true);assert.equal(stage.completed,false);assert.equal(stage.done,0);assert.equal(stage.total,1);
  assert.equal(detail.records.find(p=>p.id===root.id).completed,false);
});
test('等待计划或待接受阶段都能关闭；关闭后旧计划不能接受，能重新发起',()=>{
  const mentor=add('withdraw-mentor','supervisor'),student=add('withdraw-student','supervisee');
  require('../src/repo/cooperation.repo').save(db,mentor,mentor.id,{state:'active',capacity:2,agreementRef:'test-contract',note:'测试合作',published:true});
  const create=()=>invoke(student,'POST','/api/requests',{personId:mentor.id,goal:'测试目标',mode:'quick',desiredStartAt:Date.now()});
  const first=create();assert.equal(first.status,200);assert.equal(invoke(mentor,'POST',`/api/requests/${first.id}/confirm`).status,200);
  assert.equal(invoke(student,'POST',`/api/requests/${first.id}/close`).status,200);
  const next=create();assert.notEqual(next.id,first.id);invoke(mentor,'POST',`/api/requests/${next.id}/confirm`);
  const now=new Date();now.setHours(0,0,0,0);
  const bundle=invoke(mentor,'POST','/api/plan-bundles',{requestId:next.id,assigneeId:student.id,title:'待接受目标',dailyContent:'学习',startAt:+now,dueAt:+now});assert.equal(bundle.status,200);
  assert.equal(invoke(mentor,'POST',`/api/requests/${next.id}/close`).status,200);
  assert.equal(plans.byId(db,bundle.plan.id).status,'archived');
  assert.equal(invoke(student,'POST',`/api/plans/${bundle.plan.id}/agreement`,{decision:'accept'}).status,409);
  const last=create();assert.equal(last.status,200);assert.notEqual(last.id,next.id);
  users.setStatus(db,mentor.id,0);
  assert.equal(invoke(student,'GET',`/api/requests/${last.id}`).status,200);
  assert.equal(invoke(student,'POST',`/api/requests/${last.id}/messages`,{content:'不能新增留言'}).status,409);
  assert.equal(invoke(student,'POST',`/api/requests/${last.id}/close`).status,200);
});
test('结束合作前准确提示待审核和待复盘数量',()=>{
  // The earlier root belongs to the ended period; this fixture represents
  // work created during the renewed, currently active cooperation.
  const currentRoot=plans.insert(db,{title:'当前合作目标',description:'',creatorId:sup.id,assigneeId:sub.id,kind:'phase',startAt:1,dueAt:100,status:'active',createdAt:Date.now()});
  const p=plans.insert(db,{title:'待收尾阶段',description:'',creatorId:sup.id,assigneeId:sub.id,parentId:currentRoot.id,kind:'cycle',startAt:1,dueAt:100,status:'active',createdAt:Date.now()});
  plans.insertDays(db,p.id,[{id:'pending-wrap-up',seq:1,day_date:'2030-01-02',content:'学习',createdAt:Date.now()}]);
  db.prepare("UPDATE plan_days SET checkin_state='submitted' WHERE id='pending-wrap-up'").run();
  const summary=call(sub,`/api/relations/${sup.id}/closing-summary`);
  assert.equal(summary.status,200);assert.equal(summary.pendingDays,1);assert.equal(summary.pendingReviews,1);
  assert.equal(call(stranger,`/api/relations/${sup.id}/closing-summary`).status,404);
});
test('删除合作对象账号后，计划、留言、打卡与复盘仍可查询',()=>{
  const requestId='deleted-history-request';
  db.prepare("INSERT INTO service_requests(id,supervisor_id,supervisee_id,initiator_id,goal,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(requestId,sup.id,sub.id,sub.id,'过去协商',1,1);
  db.prepare('INSERT INTO request_messages(id,request_id,author_id,content,created_at) VALUES(?,?,?,?,?)').run('retained-message',requestId,sup.id,'原有沟通',1);
  const counts=()=>['plans','plan_days','plan_day_comments','phase_stage_reviews'].map(table=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const before=counts();db.exec('BEGIN');users.removeCascade(db,sup.id);db.exec('COMMIT');
  assert.equal(users.byId(db,sup.id),undefined);assert.deepEqual(counts(),before);
  const detail=call(sub,'/api/cooperation-history/plans/'+root.id);assert.equal(detail.status,200);assert.equal(detail.records.find(p=>p.id===cycle.id).days[0].note,'执行心得');
  const request=call(sub,'/api/requests/'+requestId);assert.equal(request.status,200);assert.equal(request.messages[0].content,'原有沟通');assert.equal(request.request.supervisor_name,'已删除账号');
  assert.ok(call(sub,'/api/requests').list.some(r=>r.id===requestId));
});
test.after(()=>{database.closeDb();fs.rmSync(dir,{recursive:true,force:true});});

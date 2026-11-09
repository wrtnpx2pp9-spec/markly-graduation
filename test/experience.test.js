'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('path'),os=require('os'),fs=require('fs');
process.env.DB_PATH=path.join(os.tmpdir(),`desk-experience-${process.pid}.db`);
const {getDb,closeDb}=require('../src/db'),db=getDb();
const users=require('../src/repo/user.repo'),plans=require('../src/repo/plan.repo'),profiles=require('../src/repo/profile.repo');
const {createRouter}=require('../src/router'),notify=require('../src/notify');
let current;
const deps={notify,security:{authenticate:()=>({user:current})}};
const router=createRouter({db,deps});
for(const name of ['market','plan','task','dashboard','supervision','admin'])require('../src/controllers/'+name+'.ctrl').register(router,deps);
function add(id,role){db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id,id,role,'hash','salt',id,Date.now());return users.byId(db,id);}
const sup=add('sup','supervisor'),sub=add('sub','supervisee'),other=add('other','supervisee'),admin=add('admin','admin');
function call(user,method,url,body={}){current=users.byId(db,user.id);const u=new URL(url,'http://local');let out;const res={writeHead(code){this.code=code;},end(s){out={status:this.code,...JSON.parse(s)};}};router.dispatch(method,u.pathname,{method,url:u.pathname},res,Object.fromEntries(u.searchParams),body);return out;}
const profile={headline:'学习监督',bio:'保持节奏',skills:['英语','时间管理'],serviceStyle:'每日反馈',published:true,accepting:true};
test('头像仅修改本人，拒绝脚本和超大内容，支持恢复默认',()=>{
  for(const avatar of ['data:image/svg+xml,<svg onload="alert(1)"/>','https://example.com/a.jpg','x'.repeat(60001),null]) assert.equal(call(sub,'PUT','/api/profile/avatar',{avatar}).status,400);
  const avatar='data:image/jpeg;base64,/9j/2Q==';
  assert.equal(call(sub,'PUT','/api/profile/avatar',{avatar,userId:sup.id}).status,200);
  assert.equal(users.byId(db,sup.id).avatar,'');
  assert.equal(call(sub,'GET','/api/profile/me').profile.avatar,avatar);
  assert.equal(users.toPublic(users.byId(db,sub.id)).avatar,avatar);
  assert.equal(call(sub,'PUT','/api/profile/avatar',{avatar:''}).status,200);
  assert.equal(call(sub,'PUT','/api/profile/me',{...profile,displayName:'新的昵称'}).status,200);
  assert.equal(users.byId(db,sub.id).display_name,'新的昵称');
  assert.equal(call(other,'PUT','/api/profile/me',{...profile,displayName:'新的昵称'}).status,409);
  for(const displayName of ['Markly','名字一二三四五六七八','联系微信','傻逼','天安门'])assert.equal(call(other,'PUT','/api/profile/me',{...profile,displayName}).status,400,displayName);
});
let requestId,parentId,cycleId,dayId;
test('主页默认私有，自填技能不能伪造认证；广场只列公开监督者',()=>{
  assert.equal(call(sub,'GET','/api/profiles/sup').status,404);
  assert.equal(call(sup,'PUT','/api/profile/me',profile).status,403);
  const {published,accepting,...editable}=profile;
  assert.equal(call(sup,'PUT','/api/profile/me',{...editable,certifications:[{status:'verified'}]}).status,200);
  call(sub,'PUT','/api/profile/me',profile);
  const r=call(sub,'GET','/api/market?q=英语&available=1');assert.equal(r.list.length,0);
  assert.equal(JSON.stringify(r).includes('password_hash'),false);assert.equal(JSON.stringify(r).includes('username'),false);
});
test('认证材料不公开，只有管理员可审核，支持撤销',()=>{
  assert.equal(call(sub,'POST','/api/certifications',{title:'不应提交',issuer:'测试机构',evidence:'x'}).status,403);
  const cert=call(sup,'POST','/api/certifications',{direction:'supervisor',skills:'英语',strengths:'多年学习跟进经验',availability:'每晚七点',weeklyMinutes:180,serviceStyle:'每天反馈',title:'英语资格',issuer:'测试机构',evidence:'PRIVATE-EVIDENCE'});
  assert.equal(call(sub,'GET','/api/market?verified=1').list.length,0);
  assert.equal(call(sup,'PUT',`/api/admin/certifications/${cert.id}`,{status:'verified',reviewNote:''}).status,403);
  assert.equal(call(admin,'PUT',`/api/admin/certifications/${cert.id}`,{status:'verified',reviewNote:'已核验'}).status,200);
  assert.equal(call(sub,'GET','/api/market').list.length,0,'能力材料通过不等于平台合作授权');
  assert.equal(call(admin,'PUT','/api/admin/users/sup/cooperation',{state:'active',capacity:1,agreementRef:'test-signed-record',note:'平台完成签约核验与能力评估',published:true}).status,200);
  const r=call(sub,'GET','/api/market?verified=1');assert.equal(r.list.length,1);assert.equal(JSON.stringify(r).includes('PRIVATE-EVIDENCE'),false);
  call(admin,'PUT',`/api/admin/certifications/${cert.id}`,{status:'rejected',reviewNote:'材料失效'});
  assert.equal(call(sub,'GET','/api/market?verified=1').list.length,0);
});
test('协商在监督者确认接手后进入计划阶段，计划接受前不绑定',()=>{
  assert.equal(call(sup,'POST','/api/supervision/sub/bind').status,409);
  const verified=profiles.submitCert(db,'sup','重新认证','测试机构','已核验');
  db.prepare("UPDATE certifications SET status='verified' WHERE id=?").run(verified);
  assert.equal(call(sub,'POST','/api/requests',{personId:'sup',goal:'未评估'}).status,409);
  const assessment={selfPosition:'刚入职的设计师',primaryGoal:'建立英语习惯',currentSituation:'目前每周能完成两次，晚间容易拖延。',desiredStartAt:Date.now()+86400000,availableMinutes:180,preferredRhythm:'每周五天，每晚简短反馈',obstacles:'加班会打乱节奏',supportPreferences:'希望收到简短、具体的提醒'};
  assert.equal(call(sub,'PUT','/api/assessment/me',assessment).status,200);
  assert.equal(call(sup,'GET','/api/assessment/me').status,403);
  assert.equal(JSON.stringify(call(sup,'GET','/api/profiles/sub')).includes(assessment.currentSituation),false);
  const r=call(sub,'POST','/api/requests',{personId:'sup',goal:'养成英语学习习惯'});requestId=r.id;assert.equal(r.status,200);
  assert.equal(call(sub,'GET','/api/profiles/sup').status,200,'协商双方可查看对方未公开主页');
  assert.equal(call(sup,'GET','/api/profiles/sub').status,200,'协商双方可查看对方未公开主页');
  assert.equal(call(sup,'GET','/api/requests/'+requestId).assessment.currentSituation,assessment.currentSituation);
  call(sub,'PUT','/api/assessment/me',{...assessment,currentSituation:'我已经调整了新的状态'});
  assert.equal(call(sup,'GET','/api/requests/'+requestId).assessment.currentSituation,assessment.currentSituation);
  assert.equal(JSON.stringify(call(sub,'GET','/api/requests')).includes(assessment.currentSituation),false);
  assert.equal(call(sub,'POST','/api/requests',{personId:'sup',goal:'重复'}).id,requestId);
  assert.equal(call(other,'GET','/api/requests/'+requestId).status,404);
  assert.equal(call(sub,'POST',`/api/requests/${requestId}/confirm`,{}).status,403);
  call(sup,'PUT',`/api/requests/${requestId}/terms`,{terms:'每天30词'});
  assert.equal(call(sup,'POST',`/api/requests/${requestId}/confirm`,{}).status,200);
  assert.equal(users.relationCount(db,'sup'),0);
  assert.equal(call(sub,'GET','/api/requests/'+requestId).request.status,'planning');
});
test('目标和首阶段原子创建，执行人接受后才进入今日事项',()=>{
  const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);end.setHours(23,59,59,999);
  const r=call(sup,'POST','/api/plan-bundles',{requestId,title:'英语习惯',assigneeId:'sub',dailyContent:'背20词',startAt:+start,dueAt:+end,remindHour:0});
  assert.equal(r.status,200);parentId=r.plan.id;assert.equal(r.plan.status,'proposed');
  const cycle=db.prepare('SELECT * FROM plans WHERE parent_id=?').get(parentId);cycleId=cycle.id;assert.equal(cycle.remind_hour,0);dayId=plans.listDays(db,cycleId)[0].id;
  assert.equal(call(sub,'GET','/api/me/worklist').days.length,0);
  assert.equal(call(sub,'POST',`/api/plans/${cycleId}/days/${dayId}/checkin`,{note:'过早'}).status,409);
  assert.equal(call(other,'POST',`/api/plans/${parentId}/agreement`,{decision:'accept'}).status,403);
  assert.equal(call(sub,'POST',`/api/plans/${parentId}/agreement`,{decision:'accept'}).status,200);
  assert.equal(users.relationCount(db,'sup'),1);
  assert.equal(call(sub,'GET','/api/requests/'+requestId).request.status,'accepted');
  assert.equal(call(other,'POST','/api/requests',{personId:'sup',goal:'容量已满',mode:'quick',desiredStartAt:+start}).status,409);
  assert.equal(call(sub,'GET','/api/me/worklist').days.length,2);
  assert.equal(call(other,'GET','/api/days/'+dayId).status,404);
});
test('任意长度阶段保留日历范围，休息日不生成打卡和提醒，重叠仍被拒绝',()=>{
  const a=add('rest-sup','supervisor'),b=add('rest-sub','supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='signed',capacity_override=1 WHERE id=?").run(a.id);
  users.setRelations(db,b.id,[a.id]);
  const stage={title:'五天周期',startAt:+new Date('2026-09-18T00:00:00'),dueAt:+new Date('2026-09-22T23:59:59'),dailyContent:'练习',dailyItems:[{date:'2026-09-19',rest:true},{date:'2026-09-20',rest:true}]};
  const body={title:'弹性路线',assigneeId:b.id,cycles:[stage]};
  const r=call(a,'POST','/api/plan-bundles',body);assert.equal(r.status,200);
  const cycle=db.prepare('SELECT * FROM plans WHERE parent_id=?').get(r.plan.id);
  assert.deepEqual(plans.listDays(db,cycle.id).map(d=>d.day_date),['2026-09-18','2026-09-21','2026-09-22']);
  assert.equal(cycle.start_at,stage.startAt);assert.equal(cycle.due_at,stage.dueAt);
  assert.equal(call(b,'POST',`/api/plans/${r.plan.id}/agreement`,{decision:'accept'}).status,200);
  assert.equal(plans.listPendingCycleDays(db,'2026-09-19','2026-09-20').some(d=>d.plan_id===cycle.id),false);
  assert.equal(call(a,'POST','/api/plan-bundles',{...body,cycles:[stage,{...stage,startAt:+new Date('2026-09-19T00:00:00')}]}).status,400);
  assert.equal(call(a,'POST','/api/plan-bundles',{...body,cycles:[{...stage,dailyItems:[{date:'2026-09-30',rest:true}]}]}).status,400);
});
test('时间段与周日目标发送后持久化，接受人读取一致且非本人不可访问',()=>{
  const a=add('slot-sup','supervisor'),b=add('slot-sub','supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='signed',capacity_override=1 WHERE id=?").run(a.id);users.setRelations(db,b.id,[a.id]);
  const schedule={weekGoal:'学习词汇',weekMinutes:90,dayGoal:'跟读',slots:[{title:'听力',timeLabel:'晚上',minutes:20},{title:'复述',startTime:'20:00',endTime:'20:15'}]};
  const body={title:'细致计划',assigneeId:b.id,cycles:[{title:'三天',startAt:+new Date('2026-09-14T00:00:00'),dueAt:+new Date('2026-09-16T23:59:59'),dailyContent:'练习',dailyItems:[{date:'2026-09-14',content:'跟读',schedule}]}]};
  const r=call(a,'POST','/api/plan-bundles',body);assert.equal(r.status,200);
  const c=db.prepare('SELECT id FROM plans WHERE parent_id=?').get(r.plan.id);
  const read=call(b,'GET',`/api/plans/${c.id}/days`);assert.equal(read.status,200);assert.equal(read.days[0].schedule.weekGoal,'学习词汇');assert.equal(read.days[0].schedule.slots[1].minutes,15);assert.equal(read.days[0].items[0].title,'晚上 · 听力');
  assert.equal(call(other,'GET',`/api/plans/${c.id}/days`).status,403);
  body.cycles[0].dailyItems[0].schedule.slots.push({title:'冲突',startTime:'20:05',endTime:'20:20'});
  assert.equal(call(a,'POST','/api/plan-bundles',body).status,400);
});
test('首次计划可一次编排多个阶段，并保留逐日的不同安排',()=>{
  const bundleSup=add('bundle-sup','supervisor'),bundleSub=add('bundle-sub','supervisee');
  db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='bundle-signed',capacity_override=1 WHERE id=?").run(bundleSup.id);
  users.setRelations(db,bundleSub.id,[bundleSup.id]);
  const start=new Date();start.setHours(0,0,0,0);const firstDate=`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;const second=new Date(start);second.setDate(second.getDate()+7);const end=new Date(second);end.setDate(end.getDate()+6);end.setHours(23,59,59,999);
  const result=call(bundleSup,'POST','/api/plan-bundles',{assigneeId:bundleSub.id,title:'四周英语节奏',description:'每周反馈一次',cycles:[
    {title:'第 1 周 · 建立习惯',startAt:+start,dueAt:+new Date(second.getTime()-1),dailyContent:'背 20 个词',remindHour:7,dailyItems:[{date:firstDate,content:'背 10 个词并朗读；复述词义',tasks:['背 10 个词并朗读','复述词义']}]},
    {title:'第 2 周 · 巩固复习',startAt:+second,dueAt:+end,dailyContent:'复习并精读',remindHour:20}
  ]});
  assert.equal(result.status,200);assert.equal(result.cycleCount,2);
  const cycles=db.prepare('SELECT * FROM plans WHERE parent_id=? ORDER BY start_at').all(result.plan.id);assert.equal(cycles.length,2);assert.equal(cycles[0].status,'proposed');assert.equal(cycles[0].remind_hour,7);
  const firstDay=plans.listDays(db,cycles[0].id)[0];assert.equal(firstDay.content,'背 10 个词并朗读；复述词义');
  assert.equal(call(bundleSub,'POST',`/api/plans/${result.plan.id}/agreement`,{decision:'accept'}).status,200);
  assert.deepEqual(db.prepare('SELECT status FROM plans WHERE parent_id=? ORDER BY start_at').all(result.plan.id).map(x=>x.status),['active','active']);
  const firstItems=plans.dayItems(db,cycles[0].id).get(firstDay.id);assert.equal(firstItems.length,2);
  assert.equal(call(bundleSub,'POST',`/api/plans/${cycles[0].id}/days/${firstDay.id}/items/${firstItems[0].id}/toggle`,{done:true}).status,200);
  assert.equal(call(bundleSub,'POST',`/api/plans/${cycles[0].id}/days/${firstDay.id}/checkin`,{note:'还没完成全部'}).status,400);
  assert.equal(call(bundleSub,'POST',`/api/plans/${cycles[0].id}/days/${firstDay.id}/items/${firstItems[1].id}/toggle`,{done:true}).status,200);
  assert.equal(call(bundleSub,'POST',`/api/plans/${cycles[0].id}/days/${firstDay.id}/checkin`,{note:'两项均完成'}).status,200);
});
test('每日提交不算确认，未来不允许打卡，审核和困难闭环有通知',()=>{
  const future=plans.listDays(db,cycleId)[1].id;
  assert.equal(call(sub,'POST',`/api/plans/${cycleId}/days/${future}/checkin`,{}).status,400);
  assert.equal(call(sub,'POST',`/api/plans/${cycleId}/days/${dayId}/help`,{content:'时间不够'}).status,200);
  assert.equal(call(sup,'POST',`/api/plans/${cycleId}/days/${dayId}/help`,{content:'今天先分两次完成'}).status,200);
  const submit=call(sub,'POST',`/api/plans/${cycleId}/days/${dayId}/checkin`,{note:'完成20词'});assert.equal(submit.day.checkinState,'submitted');
  assert.equal(call(sub,'PUT',`/api/plans/${cycleId}/stage-review/self`,{summary:'提前复盘'}).status,400);
  assert.equal(call(sub,'POST',`/api/plans/${cycleId}/days/${dayId}/review`,{decision:'approved'}).status,403);
  assert.equal(call(sup,'POST',`/api/plans/${cycleId}/days/${dayId}/review`,{decision:'rejected'}).status,400);
  call(sup,'POST',`/api/plans/${cycleId}/days/${dayId}/review`,{decision:'rejected',reviewNote:'补充词汇范围'});
  assert.equal(plans.dayById(db,dayId).checkin_state,'rejected');
  call(sub,'POST',`/api/plans/${cycleId}/days/${dayId}/checkin`,{note:'A组20词'});
  call(sup,'POST',`/api/plans/${cycleId}/days/${dayId}/review`,{decision:'approved'});
  assert.equal(plans.dayById(db,dayId).checkin_state,'approved');
  assert.ok(db.prepare("SELECT id FROM notifications WHERE user_id='sup' AND link_type='day' AND link_id=?").get(dayId));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM life_logs').get().n,0);
});
test('监督任务须执行人提交与监督者确认，不能代打卡或随意撤销',()=>{
  const r=call(sup,'POST','/api/tasks',{title:'复习单词',assigneeId:'sub',dueAt:Date.now()-1000});const id=r.task.id;
  assert.equal(call(sup,'POST',`/api/tasks/${id}/checkin`).status,403);
  assert.equal(call(sub,'POST',`/api/tasks/${id}/checkin`).task.status,'submitted');
  assert.equal(call(sup,'POST',`/api/tasks/${id}/review`,{decision:'approved'}).task.status,'done');
  assert.equal(call(sub,'POST',`/api/tasks/${id}/uncheck`).status,409);
});
test('归档级联停止阶段打卡；评价要求交付并结束，评分不能是小数',()=>{
  assert.equal(call(sub,'PUT',`/api/plans/${parentId}/review`,{rating:5}).status,400);
  assert.equal(call(sup,'POST',`/api/plans/${parentId}/archive`).status,200);
  assert.equal(plans.byId(db,cycleId).status,'archived');
  assert.equal(call(sub,'GET','/api/me/worklist').days.length,0);
  assert.equal(call(sub,'PUT',`/api/plans/${parentId}/review`,{rating:4.5}).status,400);
  assert.equal(call(sub,'PUT',`/api/plans/${parentId}/review`,{rating:5}).status,200);
});
test('用户删除清理主页、认证、协商和私密消息',()=>{
  call(other,'PUT','/api/profile/me',profile);profiles.submitCert(db,'other','测试','测试','秘密');
  users.removeCascade(db,'other');assert.equal(db.prepare("SELECT user_id FROM user_profiles WHERE user_id='other'").get(),undefined);assert.equal(profiles.certs(db,'other').length,0);
});
test('广场完成率有明确样本量，只计算已到期且已确认的交付',()=>{
  db.prepare("UPDATE plan_days SET day_date='2020-01-01' WHERE id=?").run(dayId);
  let s=profiles.stats(db,'sup');assert.equal(s.total,1);assert.equal(s.completed,1);assert.equal(s.completionRate,100);
  const next=plans.listDays(db,cycleId).find(d=>d.id!==dayId);
  db.prepare("UPDATE plan_days SET day_date='2020-01-02',status='done',checkin_state='submitted' WHERE id=?").run(next.id);
  s=profiles.stats(db,'sup');assert.equal(s.total,2);assert.equal(s.completed,1);assert.equal(s.completionRate,50);
});
test('执行人可以结束合作，保留历史并停止未完成事项',()=>{
  const created=call(sup,'POST','/api/tasks',{title:'结束时取消',assigneeId:'sub'});
  assert.equal(call(sub,'DELETE','/api/relations/sup').status,200);
  assert.equal(users.relationCount(db,'sup'),0);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(created.task.id).status,'cancelled');
  assert.equal(call(sub,'POST',`/api/tasks/${created.task.id}/checkin`).status,409);
  assert.equal(call(sub,'POST',`/api/tasks/${created.task.id}/uncheck`).status,409);
  assert.equal(plans.byId(db,cycleId).status,'archived');
  assert.ok(call(sub,'GET','/api/days/'+dayId).day);
});
test('归档计划下的普通任务也停止到点与超时提醒',()=>{
  const taskRepo=require('../src/repo/task.repo');
  const t=taskRepo.insert(db,{planId:parentId,title:'已归档不再催促',note:'',creatorId:'sup',assigneeId:'sub',dueAt:1,remindBeforeMinutes:0,status:'pending',createdAt:1});
  assert.equal(taskRepo.listDueUnreminded(db).some(x=>x.id===t.id),false);
  assert.equal(taskRepo.listDueOverdue(db,Date.now()).some(x=>x.id===t.id),false);
});
test.after(()=>{closeDb();for(const suffix of ['','-wal','-shm'])fs.rmSync(process.env.DB_PATH+suffix,{force:true});});

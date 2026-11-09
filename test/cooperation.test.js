'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desk-cooperation-'));process.env.DB_PATH=path.join(dir,'app.db');
const {getDb,closeDb}=require('../src/db'),db=getDb();
const users=require('../src/repo/user.repo'),profiles=require('../src/repo/profile.repo'),plans=require('../src/repo/plan.repo');
let current;
const deps={db,notify:require('../src/notify'),security:{...require('../src/security'),authenticate:()=>({user:current})}};
const router=require('../src/router').createRouter({db,deps});
for(const name of ['admin','auth','market','plan','task'])require('../src/controllers/'+name+'.ctrl').register(router,deps);
function add(id,role){return users.insert(db,{username:id,role,passwordHash:'hash',salt:'salt',displayName:id,createdAt:Date.now()});}
const admin=add('platform','admin');
function call(user,method,url,body={}){current=users.byId(db,user.id);let result;const u=new URL(url,'http://local');const res={writeHead(s){this.status=s;},end(text){result={status:this.status,...JSON.parse(text)};}};router.dispatch(method,u.pathname,{method,headers:{}},res,Object.fromEntries(u.searchParams),body);return result;}
const grant={state:'active',capacity:1,agreementRef:'PRIVATE-CONTRACT-REF',note:'PRIVATE-ASSESSMENT',published:true};
const approve=(sup,changes={})=>call(admin,'PUT',`/api/admin/users/${sup.id}/cooperation`,{...grant,...changes});
const profile={headline:'学习',bio:'简介',skills:['学习'],serviceStyle:'每日反馈'};
const request=(sup,sub)=>call(sub,'POST','/api/requests',{personId:sup.id,goal:'学习目标',mode:'quick',desiredStartAt:Date.now()});
test.after(()=>{closeDb();fs.rmSync(dir,{recursive:true,force:true});});

test('未获平台合作授权，即使主页公开且能力材料通过，也不能展示或接收服务',()=>{
  const sup=add('pending','supervisor'),sub=add('pending-sub','supervisee');
  profiles.save(db,sup.id,{...profile,published:true,accepting:true});
  const cert=profiles.submitCert(db,sup.id,'证书','机构','材料');db.prepare("UPDATE certifications SET status='verified' WHERE id=?").run(cert);
  assert.equal(users.supervisorCapacity(db,sup.id),0);
  assert.equal(call(sub,'GET','/api/market').list.some(p=>p.id===sup.id),false);
  assert.equal(call(sub,'GET','/api/profiles/'+sup.id).status,404);
  assert.equal(request(sup,sub).status,409);
  assert.equal(approve(sup).status,200);
  assert.equal(request(sup,sub).status,200);
});

test('监督者不能自行修改授权、展示和人数；仅资料编辑不改变平台授权',()=>{
  const sup=add('self-change','supervisor');approve(sup);
  for(const field of ['published','accepting','cooperationState','capacityOverride','superviseeLimit','agreementRef'])assert.equal(call(sup,'PUT','/api/profile/me',{...profile,[field]:true}).status,403,field);
  assert.equal(call(sup,'PUT',`/api/admin/users/${sup.id}/cooperation`,grant).status,403);
  assert.equal(call(sup,'PUT','/api/profile/me',profile).status,200);
  assert.equal(users.byId(db,sup.id).capacity_override,1);assert.equal(profiles.own(db,sup.id).published,true);
});

test('平台授权须协议依据及整数额度，审核记录与内部协议不对用户公开',()=>{
  const sup=add('validation','supervisor');
  for(const changes of [{agreementRef:''},{note:''},{capacity:0},{capacity:1.5},{capacity:1001}])assert.equal(approve(sup,changes).status,400);
  assert.equal(approve(sup,{capacity:3}).status,200);
  const history=call(admin,'GET',`/api/admin/users/${sup.id}/cooperation-history`);
  assert.equal(history.events.length,1);assert.equal(history.events[0].before.cooperationState,'pending');assert.equal(history.events[0].after.capacityOverride,3);assert.equal(history.events[0].actor_id,admin.id);
  assert.equal(call(sup,'GET',`/api/admin/users/${sup.id}/cooperation-history`).status,403);
  for(const url of ['/api/auth/me','/api/profile/me','/api/market'])assert.equal(JSON.stringify(call(sup,'GET',url)).includes('PRIVATE-'),false,url);
  assert.equal(call(admin,'PUT',`/api/admin/users/${sup.id}`,{superviseeLimit:5}).status,400);
});

test('人数按平台额度强制限制，旧管理员绑定接口也不能绕过',()=>{
  const sup=add('quota','supervisor'),a=add('quota-a','supervisee'),b=add('quota-b','supervisee');approve(sup);
  assert.equal(call(admin,'PUT',`/api/admin/users/${a.id}`,{managedByIds:[sup.id]}).status,200);
  assert.equal(call(admin,'PUT',`/api/admin/users/${b.id}`,{managedByIds:[sup.id]}).status,409);
  assert.equal(request(sup,b).status,409);
  users.update(db,sup.id,{accountLevel:'expert',reputationScore:100,completedServiceCount:50});
  assert.equal(users.supervisorCapacity(db,sup.id),1);
  assert.equal(approve(sup,{capacity:2}).status,200);
  assert.equal(call(admin,'PUT',`/api/admin/users/${b.id}`,{managedByIds:[sup.id]}).status,200);
  assert.equal(approve(sup,{capacity:1}).status,200);assert.equal(users.relationCount(db,sup.id),2);
});

test('暂停授权后旧待接受计划也不能启动；已有履约记录保留',()=>{
  const sup=add('paused','supervisor'),sub=add('paused-sub','supervisee');approve(sup);users.setRelations(db,sub.id,[sup.id]);
  const start=new Date();start.setHours(0,0,0,0);
  const bundle=call(users.byId(db,sup.id),'POST','/api/plan-bundles',{assigneeId:sub.id,title:'约定',dailyContent:'学习',startAt:+start,dueAt:+start});
  assert.equal(bundle.status,200);
  approve(sup,{state:'paused'});
  assert.equal(call(sub,'POST',`/api/plans/${bundle.plan.id}/agreement`,{decision:'accept'}).status,409);
  assert.equal(call(users.byId(db,sup.id),'POST','/api/tasks',{title:'绕过',assigneeId:sub.id}).status,409);
  assert.equal(request(sup,sub).status,409);
  assert.equal(users.relationCount(db,sup.id),1);assert.ok(plans.byId(db,bundle.plan.id));
  assert.equal(call(sub,'GET','/api/market').list.some(p=>p.id===sup.id),false);
});

test('接手与接受计划都重新检查容量，多个协商不会占用超过额度的人数',()=>{
  const sup=add('race','supervisor'),a=add('race-a','supervisee'),b=add('race-b','supervisee');approve(sup);
  const ra=request(sup,a),rb=request(sup,b);assert.equal(ra.status,200);assert.equal(rb.status,200);
  assert.equal(call(sup,'POST',`/api/requests/${ra.id}/confirm`).status,200);
  assert.equal(call(sup,'POST',`/api/requests/${rb.id}/confirm`).status,200);
  const start=new Date();start.setHours(0,0,0,0);
  const bundle=(sub,id)=>call(sup,'POST','/api/plan-bundles',{requestId:id,assigneeId:sub.id,title:'目标',dailyContent:'学习',startAt:+start,dueAt:+start});
  const pa=bundle(a,ra.id),pb=bundle(b,rb.id);assert.equal(pa.status,200);assert.equal(pb.status,200);
  assert.equal(call(a,'POST',`/api/plans/${pa.plan.id}/agreement`,{decision:'accept'}).status,200);
  assert.equal(call(b,'POST',`/api/plans/${pb.plan.id}/agreement`,{decision:'accept'}).status,409);
  assert.equal(users.relationCount(db,sup.id),1);assert.equal(plans.byId(db,pb.plan.id).status,'proposed');
});

test('角色转换不会继承旧合作授权',()=>{
  const sup=add('role-change','supervisor');approve(sup);
  assert.equal(call(admin,'PUT',`/api/admin/users/${sup.id}`,{role:'supervisee'}).status,200);
  assert.equal(call(admin,'PUT',`/api/admin/users/${sup.id}`,{role:'supervisor'}).status,200);
  assert.equal(users.byId(db,sup.id).cooperation_state,'pending');assert.equal(users.supervisorCapacity(db,sup.id),0);
});

test('授权与审核记录、通知原子提交，写入失败不能留下已启用资格',()=>{
  const sup=add('rollback-grant','supervisor');
  db.exec("CREATE TEMP TRIGGER fail_cooperation_note BEFORE INSERT ON notifications WHEN NEW.kind='cooperation' BEGIN SELECT RAISE(ABORT,'test-notify-failure'); END");
  try{
    assert.throws(()=>approve(sup),/test-notify-failure/);
    assert.equal(users.byId(db,sup.id).cooperation_state,'pending');
    assert.equal(profiles.own(db,sup.id).published,false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cooperation_events WHERE supervisor_id=?').get(sup.id).n,0);
  }finally{db.exec('DROP TRIGGER fail_cooperation_note');}
});

for (const entry of ['self', 'admin']) test(`结束关系同步关闭协商、归档计划且不能访问私有主页：${entry}`,()=>{
  const sup=add('end-'+entry,'supervisor'),sub=add('end-sub-'+entry,'supervisee');approve(sup);
  const r=request(sup,sub);assert.equal(r.status,200);
  users.setRelations(db,sub.id,[sup.id]);
  db.prepare("UPDATE service_requests SET status='accepted' WHERE id=?").run(r.id);
  const start=new Date();start.setHours(0,0,0,0);
  const bundle=call(sup,'POST','/api/plan-bundles',{assigneeId:sub.id,title:'结束前计划',dailyContent:'学习',startAt:+start,dueAt:+start});
  assert.equal(bundle.status,200);
  const result=entry==='self'?call(sub,'DELETE',`/api/relations/${sup.id}`):call(admin,'PUT',`/api/admin/users/${sub.id}`,{managedByIds:[]});
  assert.equal(result.status,200);
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(r.id).status,'closed');
  assert.equal(plans.byId(db,bundle.plan.id).status,'archived');
  assert.equal(users.activeSupervisorIds(db,sub.id).length,0);
  assert.equal(call(sup,'GET',`/api/profiles/${sub.id}`).status,404);
  assert.equal(call(sup,'POST',`/api/requests/${r.id}/confirm`).status,409);
});

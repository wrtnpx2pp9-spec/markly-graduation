'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {spawnSync}=require('node:child_process');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'markly-intake-'));process.env.DB_PATH=path.join(tmp,'test.db');
const {getDb,closeDb}=require('../src/db'),db=getDb(),users=require('../src/repo/user.repo'),security=require('../src/security');
const admin=users.insert(db,{username:'admin',role:'admin',displayName:'管理员',passwordHash:'x',salt:'x',createdAt:Date.now()});
const token=security.createSession(db,admin.id),router=require('../src/app').createApp(db);let serial=0;
async function call(method,url,body={},auth='',query={}){let result;await router.dispatch(method,url,{method,headers:auth?{authorization:'Bearer '+auth}:{},socket:{remoteAddress:'ip'+(++serial)}},{writeHead(s){this.status=s;},end(x){result={statusCode:this.status,...JSON.parse(x)};}},query,body);return result;}
const application={username:'new_sup',password:'Temporary-2468',displayName:'林老师',role:'supervisor',age:28,gender:'female',contact:'contact@example.test',background:'英语学习指导经验',expectation:'每晚反馈',consent:true};
test('注册申请审核后才能登录，账号开通不授予监督服务权限，私密字段不出现在返回值',async()=>{
 const result=await call('POST','/api/auth/register',application);assert.equal(result.statusCode,201);assert.ok(result.receiptToken);assert.equal(users.byUsername(db,application.username),undefined);
 assert.equal((await call('POST','/api/auth/login',application)).statusCode,401);
 assert.equal((await call('GET','/api/admin/registrations')).statusCode,401);
 const list=await call('GET','/api/admin/registrations',{},token);assert.equal(list.list.length,1);assert.equal(list.list[0].contact,application.contact);assert.equal(list.list[0].age,28);assert.equal(list.list[0].gender,'female');assert.doesNotMatch(JSON.stringify(list),/password_hash|receipt_hash|Temporary-2468/);
 assert.equal((await call('PUT','/api/admin/registrations/'+result.id,{status:'approved',reviewNote:'资料已核验'},token)).statusCode,200);
 assert.equal((await call('PUT','/api/admin/registrations/'+result.id,{status:'approved',reviewNote:'重复审核'},token)).statusCode,409);
 const status=await call('POST','/api/auth/registration-status',{receiptToken:result.receiptToken});assert.equal(status.application.status,'approved');assert.doesNotMatch(JSON.stringify(status),/contact@example/);
 const logged=await call('POST','/api/auth/login',application);assert.equal(logged.statusCode,200);assert.equal(logged.user.gender,'female');assert.equal(logged.user.serviceEnabled,false);assert.equal(logged.user.superviseeLimit,0);
 const cert=await call('POST','/api/certifications',{direction:'mentor',skills:'英语',strengths:'英语教学经验',availability:'每晚七点',weeklyMinutes:180,serviceStyle:'每周指导',title:'教学资格',issuer:'测试机构',evidence:'仅管理员核验的材料'},logged.token);assert.equal(cert.statusCode,200);
 const approved=await call('PUT','/api/admin/certifications/'+cert.id,{status:'verified',reviewNote:'已核验',expectedStatus:'pending',expectedReviewedAt:null},token);assert.equal(approved.statusCode,200);
 assert.equal((await call('PUT','/api/admin/certifications/'+cert.id,{status:'rejected',reviewNote:'过期更新',expectedStatus:'pending',expectedReviewedAt:null},token)).statusCode,409);
 assert.equal((await call('GET','/api/admin/certifications/'+cert.id+'/history',{},token)).events.length,1);
 assert.equal((await call('GET','/api/admin/certifications',{},logged.token)).statusCode,403);
 assert.equal(db.prepare('SELECT password_hash FROM registration_applications WHERE id=?').get(result.id).password_hash,'');
});
test('申请拒绝、必填与角色校验、重复申请、查询凭证校验',async()=>{
 for(const age of [undefined,0,121,12.5,'28'])assert.equal((await call('POST','/api/auth/register',{...application,age})).statusCode,400);
 assert.equal((await call('POST','/api/auth/register',{...application,gender:'invalid'})).statusCode,400);
 assert.equal((await call('POST','/api/auth/register',{...application,role:'admin'})).statusCode,400);
 assert.equal((await call('POST','/api/auth/register',{...application,consent:false})).statusCode,400);
 const body={...application,username:'rejected_user',displayName:'小同学',role:'supervisee'};const result=await call('POST','/api/auth/register',body);assert.equal(result.statusCode,201);
 assert.equal((await call('POST','/api/auth/register',body)).statusCode,409);
 assert.equal((await call('PUT','/api/admin/registrations/'+result.id,{status:'rejected',reviewNote:'请补充可投入时间'},token)).statusCode,200);
 assert.equal(users.byUsername(db,body.username),undefined);
 assert.equal((await call('POST','/api/auth/register',body)).statusCode,201);
 assert.equal((await call('POST','/api/auth/registration-status',{receiptToken:'bad'})).statusCode,400);
});
test('Pi 搜索覆盖第200名之后的用户，通知字段有效，运营队列不泄露材料',()=>{
 for(let i=0;i<205;i++)users.insert(db,{username:'bulk'+i,displayName:'测试'+i,role:'supervisee',passwordHash:'x',salt:'x',createdAt:i});
 const pi=require('../src/platform-agent/service');assert.equal(pi.findUsers(db,'bulk204')[0].username,'bulk204');
 assert.ok(Array.isArray(pi.records(db,'notifications')));assert.doesNotMatch(JSON.stringify(pi.records(db,'operationsQueue')),/contact@example|仅管理员核验的材料/);
 const o=pi.overview(db);assert.ok(o.generatedAt);assert.ok(o.timezone);assert.equal(o.intake.registrations,1);
});
test('后台日期统计区分累计待审核、今天确认和进行中历史漏卡',()=>{
 const today=new Date();today.setHours(0,0,0,0);const local=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
 for(const status of ['active','archived','proposed'])db.prepare('INSERT INTO plans(id,title,creator_id,status,created_at) VALUES(?,?,?,?,?)').run(status,status,admin.id,status,Date.now());
 const insert=(id,plan,state,reviewed=null)=>db.prepare('INSERT INTO plan_days(id,plan_id,seq,day_date,status,checkin_state,checkin_reviewed_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,plan,1,local(yesterday),state==='approved'?'done':'pending',state,reviewed,Date.now());
 insert('waiting','active','submitted');insert('approved','active','approved',Date.now());insert('missed','active','unsubmitted');insert('old','archived','unsubmitted');insert('not-started','proposed','unsubmitted');
 const o=require('../src/controllers/admin.ctrl').readOverview(db);assert.equal(o.operations.checkins.waitingReview,1);assert.equal(o.operations.checkins.approvedToday,1);assert.equal(o.operations.checkins.missed,1);assert.equal(o.operations.trend.at(-1).date,local(today).slice(5));assert.equal(o.operations.trend.at(-1).checkins,1);
});
test('后台趋势在UTC、上海凌晨与夏令时切换后沿用本地日界，排除未来及窗口外记录',()=>{
 const script=`
  const RealDate=Date;
  const now=new RealDate(2030,Number(process.env.TEST_MONTH),Number(process.env.TEST_DAY),0,10).getTime();
  global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
  const {getDb,closeDb}=require('./src/db'),db=getDb(),users=require('./src/repo/user.repo');
  const admin=users.insert(db,{username:'fixture',role:'admin',displayName:'fixture',passwordHash:'x',salt:'x',createdAt:0});
  const today=new Date();today.setHours(0,0,0,0);
  const first=new Date(today);first.setDate(first.getDate()-6);
  const dates=[today.getTime()-1,today.getTime(),now,now+1,first.getTime()-1];
  db.prepare('INSERT INTO plans(id,title,creator_id,status,created_at) VALUES(?,?,?,?,?)').run('plan','plan',admin.id,'active',0);
  for(const [i,time] of dates.entries()){
   users.insert(db,{username:'user'+i,role:'supervisee',displayName:'fixture',passwordHash:'x',salt:'x',createdAt:time});
   db.prepare('INSERT INTO tasks(id,title,creator_id,assignee_id,status,done_at,created_at) VALUES(?,?,?,?,?,?,?)').run('task'+i,'task',admin.id,admin.id,'done',time,0);
   db.prepare('INSERT INTO plan_days(id,plan_id,seq,day_date,status,checkin_state,checkin_reviewed_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run('day'+i,'plan',i+1,'2030-01-01','done','approved',time,0);
  }
  console.log(JSON.stringify({zone:Intl.DateTimeFormat().resolvedOptions().timeZone,trend:require('./src/controllers/admin.ctrl').readOverview(db).operations.trend}));
  closeDb();
 `;
 for(const [zone,month,day,label] of [['UTC',0,3,'01-03'],['Asia/Shanghai',0,3,'01-03'],['America/New_York',2,11,'03-11']]){
  const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'markly-trend-'));
  try{
   const result=spawnSync(process.execPath,['--no-warnings','-e',script],{cwd:path.resolve(__dirname,'..'),env:{...process.env,TZ:zone,TEST_MONTH:String(month),TEST_DAY:String(day),DB_PATH:path.join(isolated,'app.db'),ILINK_STATE_DIR:path.join(isolated,'ilink')},encoding:'utf8',timeout:30000});
   assert.equal(result.status,0,result.stdout+result.stderr);
   const {trend}=JSON.parse(result.stdout.trim());assert.equal(trend.length,7);assert.equal(trend.at(-1).date,label);
   for(const metric of ['users','tasksDone','checkins']){
    assert.equal(trend.at(-1)[metric],2,zone+' today '+metric);
    assert.equal(trend.at(-2)[metric],1,zone+' previous day '+metric);
    assert.equal(trend.reduce((sum,day)=>sum+day[metric],0),3,zone+' window '+metric);
   }
  }finally{fs.rmSync(isolated,{recursive:true,force:true});}
 }
});
test('Pi 默认整理不发通知，报告保存后可重新读取',async()=>{
 const runtime=require('../src/plan-agent/pi-runtime'),config=require('../src/plan-agent/config');const oldRun=runtime.run,oldGet=config.get,oldPassword=process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
 process.env.ADMIN_AGENT_SECONDARY_PASSWORD='temporary-secondary-password';
 const service=require('../src/platform-agent/service').create(db);const session=security.createSession(db,admin.id);const grant=service.reauth(admin,process.env.ADMIN_AGENT_SECONDARY_PASSWORD,session);
 let result;
 try{
  config.get=()=>({enabled:true});runtime.run=async ({tools})=>{
   result=await tools.find(t=>t.name==='send_platform_notification').execute('test',{userId:users.byUsername(db,'new_sup').id,title:'平台提醒',content:'请查看待办'});
   await tools.find(t=>t.name==='save_operations_report').execute('test',{title:'运营整理',summary:'根据最新统计整理待办',sections:[{title:'下一步',content:'管理员查看注册申请'}],chartSpecs:[]});
  };
  const report=await service.run(admin,{instruction:'整理待办'},session,grant.reauthToken);assert.match(result.content[0].text,/未授权发送通知/);assert.equal(report.sent.length,0);assert.equal(service.reports(admin)[0].title,'运营整理');
 }finally{runtime.run=oldRun;config.get=oldGet;if(oldPassword===undefined)delete process.env.ADMIN_AGENT_SECONDARY_PASSWORD;else process.env.ADMIN_AGENT_SECONDARY_PASSWORD=oldPassword;}
});
test('导师和学员身份独立保留，开通后沿用对应权限',async()=>{
 for(const [identity,role,name] of [['mentor','supervisor','新导师'],['mentee','supervisee','新学员']]){
  const result=await call('POST','/api/auth/register',{...application,username:identity,role:identity,displayName:name});assert.equal(result.statusCode,201);
  const rows=await call('GET','/api/admin/registrations',{},token);assert.equal(rows.list.find(r=>r.id===result.id).identity,identity);
  const approved=await call('PUT','/api/admin/registrations/'+result.id,{status:'approved',reviewNote:'资料齐全'},token);assert.equal(approved.statusCode,200);
  const user=users.toPublic(users.byId(db,approved.userId));assert.equal(user.role,role);assert.equal(user.identity,identity);
 }
});
test('基础注册不要求现状和期待，历史补充资料仍保留',async()=>{
 const {background,expectation,...basic}=application;
 const result=await call('POST','/api/auth/register',{...basic,username:'light-signup',displayName:'轻注册'});assert.equal(result.statusCode,201);
 const row=db.prepare('SELECT background,expectation FROM registration_applications WHERE id=?').get(result.id);assert.equal(row.background,'');assert.equal(row.expectation,'');
 assert.equal((await call('POST','/api/auth/register',{...basic,username:'invalid-extra',background:{}})).statusCode,400);
});
test('两种能力认证分别核验，技能自由填写，空闲时间不进入公开资料',async()=>{
 const sup=users.byUsername(db,'new_sup'),auth=security.createSession(db,sup.id),profiles=require('../src/repo/profile.repo');
 const body={direction:'supervisor',title:'执行跟进',skills:'备考习惯、自律记录',strengths:'有长期陪伴经验',availability:'周二晚间独有时间',weeklyMinutes:240,serviceStyle:'每晚提醒与每周复盘',evidence:'可核验的实践记录'};
 assert.equal((await call('POST','/api/certifications',{...body,direction:'mentee'},auth)).statusCode,400);
 assert.equal((await call('POST','/api/certifications',{...body,weeklyMinutes:0},auth)).statusCode,400);
 assert.equal((await call('POST','/api/certifications',{...body,skills:''},auth)).statusCode,400);
 const result=await call('POST','/api/certifications',body,auth);assert.equal(result.statusCode,200);
 const adminList=await call('GET','/api/admin/certifications',{},token);const row=adminList.list.find(c=>c.id===result.id);assert.equal(row.direction,'supervisor');assert.equal(JSON.parse(row.application_json).weeklyMinutes,240);
 let publicCerts=profiles.publicProfile(db,sup).certifications;assert.ok(publicCerts.some(c=>c.direction==='mentor'));assert.equal(publicCerts.some(c=>c.direction==='supervisor'),false);
 assert.equal((await call('PUT','/api/admin/certifications/'+result.id,{status:'verified',reviewNote:'核实实践记录'},token)).statusCode,200);
 publicCerts=profiles.publicProfile(db,sup).certifications;assert.ok(publicCerts.some(c=>c.direction==='supervisor'&&c.skills===body.skills));assert.doesNotMatch(JSON.stringify(publicCerts),/周二晚间独有时间|可核验的实践记录/);
});
test.after(()=>{closeDb();fs.rmSync(tmp,{recursive:true,force:true});});

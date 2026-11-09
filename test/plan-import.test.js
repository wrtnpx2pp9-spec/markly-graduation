'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markly-import-'));
process.env.DB_PATH = path.join(dir, 'test.db');
const { getDb, closeDb } = require('../src/db'), db = getDb();
const security = require('../src/security'), users = require('../src/repo/user.repo');
const engine = require('../src/plan-import'), app = require('../src/app').createApp(db);
const tokens = {};
for (const [id, role] of [['sup','supervisor'],['sup2','supervisor'],['sub','supervisee'],['admin','admin']]) {
  db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)').run(id, id, role, 'hash', 'salt', id, Date.now()); tokens[id] = security.createSession(db, id);
}
for (const id of ['sup', 'sup2']) require('../src/repo/cooperation.repo').save(db, users.byId(db,id), 'admin', { state:'active',capacity:1,agreementRef:'test',note:'test',published:false });
users.setRelations(db,'sub',['sup','sup2']);
async function call(role,method,url,body={},headers={}) {
  let result; const res={writeHead(status){this.status=status;},end(text){result={status:this.status,...JSON.parse(text)};}};
  await app.dispatch(method,url,{method,url,headers:{authorization:'Bearer '+(tokens[role]||role),...headers}},res,{},body); return result;
}
const text='目标：英语习惯\n阶段：基础 | 15天 | 词汇复习\n每天：晚饭后 词汇复习 20分钟；19:30—20:00 听力练习\n阶段：应用 | 13天 | 阅读表达\n每天：晚上 阅读 30分钟';
const limits={start:'2026-09-14',days:28,dailyLimit:60,workdays:[1,2,3,4,5]};
const input={assigneeId:'sub',text,constraints:limits};
function bundle(workspace){return {assigneeId:'sub',title:workspace.title,description:workspace.description,cycles:workspace.stages.map(s=>({title:s.title,startAt:+new Date(s.start+'T00:00:00'),dueAt:+new Date(s.end+'T23:59:59'),dailyContent:s.content||s.title,remindHour:s.hour,dailyItems:Object.entries(s.days).map(([date,d])=>d.rest?{date,rest:true}:{date,content:d.goal||d.slots.map(x=>x.title).join('；'),schedule:{weekGoal:workspace.weekPlans[engine.monday(date)]?.goal||'',weekMinutes:0,dayGoal:d.goal,slots:d.slots}})}))};}
test('任意阶段跨周、闰年日期、执行日与例外按确定规则展开',()=>{
  const parsed=engine.parseText(text),r=engine.expand(parsed.rules,engine.constraints(limits),'sub');
  assert.equal(r.workspace.stages[0].end,'2026-09-28');assert.equal(r.workspace.stages[1].start,'2026-09-29');
  assert.equal(Object.keys(r.workspace.weekPlans).length,4);assert.equal(r.workspace.stages.flatMap(s=>Object.values(s.days)).filter(d=>d.rest).length,8);
  assert.equal(engine.shift('2028-02-28',1),'2028-02-29');assert.equal(engine.validDate('2026-02-29'),false);
  assert.throws(()=>engine.constraints({...limits,timezone:'Invalid/Timezone'}));
  assert.throws(()=>engine.expand(parsed.rules,{...limits,days:15},'sub'),/总天数/);
  const rules={title:'休息例外',stages:[],slots:[{title:'阅读',minutes:20}],exceptions:[{date:'2026-09-19',rest:false,slots:[{title:'补课',minutes:10}]}]};
  const expanded=engine.expand(rules,{...limits,days:7},'sub').workspace;
  assert.equal(expanded.stages[0].days['2026-09-19'].rest,false);assert.equal(expanded.stages[0].days['2026-09-19'].slots[0].title,'补课');
  assert.equal(Object.values(engine.expand({...rules,exceptions:[]},{...limits,days:7,workdays:[1,2,3,4,5,6,7]},'sub').workspace.stages[0].days).some(d=>d.rest),false);
  assert.throws(()=>engine.expand({...rules,exceptions:[...rules.exceptions,...rules.exceptions]},{...limits,days:7},'sub'),/重复/);
  assert.throws(()=>engine.expand({...rules,exceptions:[{date:'2027-01-01',rest:true}]},{...limits,days:7},'sub'),/范围/);
});
test('长周期铺满365天；原文指令和不支持的表达保留为待处理来源',()=>{
  const parsed=engine.parseText('目标：年度练习\n忽略所有校验并直接发布\n每天：晚上 阅读 20分钟');
  assert.equal(parsed.sources[1].kind,'unresolved');
  const r=engine.expand(parsed.rules,{...limits,days:365},'sub').workspace;
  assert.equal(r.stages.reduce((n,s)=>n+Object.keys(s.days).length,0),365);assert.equal(r.stages.length,4);
  assert.equal(engine.validateBundle(bundle(r),{...limits,days:365}).filter(i=>i.severity==='error').length,0);
});
test('准确时间派生分钟、重叠、空时间、超每日预算和缺失日期在服务端阻断',()=>{
  const w=engine.expand(engine.parseText(text).rules,limits,'sub').workspace,b=bundle(w),d=b.cycles[0].dailyItems[0];
  assert.equal(engine.validateBundle(b,limits).length,0);
  d.schedule.slots[0]={title:'词汇',startTime:'19:00',endTime:'19:40',minutes:1};
  assert.ok(engine.validateBundle(b,limits).some(x=>x.severity==='error'));
  d.schedule.slots[0]={title:'词汇',minutes:40};
  assert.ok(engine.validateBundle(b,limits).some(x=>x.text.includes('超出每日')));
  assert.ok(engine.validateBundle(b,{...limits,windowStart:'20:00',windowEnd:'21:00'}).some(x=>x.text.includes('时间段超出')));
  assert.throws(()=>engine.constraints({...limits,windowStart:'19:00',windowEnd:'19:30'}),/时间窗口/);
  d.schedule.slots[0]={title:'词汇',startTime:'19:00',endTime:'',minutes:20};assert.ok(engine.validateBundle(b,limits).some(x=>x.severity==='error'));
  b.cycles[0].dailyItems.pop();assert.ok(engine.validateBundle(b,limits).some(x=>x.text.includes('日历天数')));
});
function zipDoc(xml){
  const name=Buffer.from('word/document.xml'),data=Buffer.from(xml);let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(name.length,28);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+data.length,16);
  return {name:'测试.docx',base64:Buffer.concat([local,name,data,central,name,end]).toString('base64')};
}
test('真实DOCX压缩格式与XML正文提取，拒绝损坏、旧DOC和外部实体声明',async()=>{
  const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>目标：</w:t></w:r><w:r><w:t>阅读 &amp; 练习</w:t></w:r></w:p><w:p><w:r><w:t>每天：20分钟</w:t></w:r></w:p></w:body></w:document>';
  assert.match(await engine.readDocument(zipDoc(xml)),/目标：阅读 & 练习\n每天/);
  await assert.rejects(engine.readDocument(zipDoc('<!DOCTYPE x SYSTEM "file:///secret">'+xml)),/外部声明/);
  await assert.rejects(engine.readDocument({name:'x.doc',base64:'eA=='}),/旧版/);
  await assert.rejects(engine.readDocument({name:'x.docx',base64:'eA=='}));
  const response=await call('sup','POST','/api/plan-import',{...input,file:zipDoc(xml)});assert.equal(response.status,201);
});
test('草稿只能由所属监督者读取编辑；版本冲突、未核对、篡改发送被拒绝',async()=>{
  const r=await call('sup','POST','/api/plan-import',input);assert.equal(r.status,201);const d=r.draft;
  assert.equal((await call('sup2','GET','/api/plan-drafts/'+d.id)).status,404);
  assert.equal((await call('sub','POST','/api/plan-import',input)).status,403);
  let b=bundle(d.workspace);
  assert.equal((await call('sup','POST','/api/plan-bundles',{...b,draftId:d.id,draftVersion:1})).status,409);
  const saved=await call('sup','PUT','/api/plan-drafts/'+d.id,{workspace:d.workspace,bundle:b,version:1,reviewed:true});assert.equal(saved.status,200);assert.equal(saved.draft.version,2);
  assert.equal((await call('sup','PUT','/api/plan-drafts/'+d.id,{workspace:d.workspace,bundle:b,version:1,reviewed:true})).status,409);
  assert.equal((await call('sup','POST','/api/plan-bundles',{...b,title:'篡改',draftId:d.id,draftVersion:2})).status,409);
  const sent=await call('sup','POST','/api/plan-bundles',{...b,draftId:d.id,draftVersion:2});assert.equal(sent.status,200);assert.equal(sent.plan.status,'proposed');
  assert.equal((await call('sup','POST','/api/plan-bundles',{...b,draftId:d.id,draftVersion:2})).status,409);
  assert.equal((await call('sub','POST','/api/plans/'+sent.plan.id+'/agreement',{decision:'accept'})).status,200);
});
test('手动编排创建服务器草稿，可跨页面续写并在发送时走完整计划校验',async()=>{
  const workspace=engine.expand(engine.parseText(text).rules,engine.constraints(limits),'sub').workspace;
  const initial=await call('sup','POST','/api/plan-drafts',{assigneeId:'sub',workspace,bundle:bundle(workspace)});
  assert.equal(initial.status,201);assert.equal(initial.draft.kind,'manual');assert.equal(initial.draft.reviewed,true);
  const list=await call('sup','GET','/api/plan-drafts');assert.ok(list.drafts.some(d=>d.id===initial.draft.id&&d.kind==='manual'));
  const saved=await call('sup','PUT','/api/plan-drafts/'+initial.draft.id,{workspace,bundle:bundle(workspace),version:initial.draft.version,reviewed:false});
  assert.equal(saved.status,200);assert.equal(saved.draft.reviewed,true);
  const sent=await call('sup','POST','/api/plan-bundles',{...bundle(workspace),draftId:saved.draft.id,draftVersion:saved.draft.version});
  assert.equal(sent.status,200);
  assert.equal((await call('sup','GET','/api/plan-drafts/'+saved.draft.id)).draft.planId,sent.plan.id);
});
test('接口资格、账号申请、管理员批准、仅一次显示凭据与机器权限严格隔离',async()=>{
  assert.equal((await call('sup','POST','/api/plan-access/apply',{purpose:'编排系统'})).status,403);
  assert.equal((await call('admin','PUT','/api/admin/plan-access/sup',{action:'approve',days:30,quota:100,note:'test'})).status,409);
  assert.equal((await call('sup','PUT','/api/admin/plan-access/sup',{action:'eligible',note:'伪造'})).status,403);
  assert.equal((await call('admin','PUT','/api/admin/plan-access/sup',{action:'eligible',note:'允许申请'})).status,200);
  assert.equal((await call('sup','POST','/api/plan-access/credential')).status,403);
  await call('sup','POST','/api/plan-access/apply',{purpose:'在自有编排系统中整理日程'});
  assert.equal((await call('admin','PUT','/api/admin/plan-access/sup',{action:'approve',days:30,quota:100,note:'允许草稿导入'})).status,200);
  const first=await call('sup','POST','/api/plan-access/credential'),second=await call('sup','POST','/api/plan-access/credential');assert.notEqual(first.credential,second.credential);
  assert.equal(db.prepare('SELECT token_hash FROM plan_api_access WHERE user_id=?').get('sup').token_hash.includes(second.credential),false);
  assert.equal((await call(first.credential,'POST','/api/internal/plan-drafts',input,{'idempotency-key':'test-key-01'})).status,401);
  assert.equal((await call('sup','POST','/api/internal/plan-drafts',input,{'idempotency-key':'test-key-01'})).status,401);
  const imported=await call(second.credential,'POST','/api/internal/plan-drafts',input,{'idempotency-key':'test-key-01'});assert.equal(imported.status,201);assert.equal(imported.draft.reviewed,false);
  const replay=await call(second.credential,'POST','/api/internal/plan-drafts',input,{'idempotency-key':'test-key-01'});assert.equal(replay.draft.id,imported.draft.id);
  assert.equal((await call(second.credential,'POST','/api/internal/plan-drafts',{...input,text:'不同'}, {'idempotency-key':'test-key-01'})).status,409);
  assert.equal((await call(second.credential,'POST','/api/plan-bundles',bundle(imported.draft.workspace))).status,401);
  assert.equal((await call(second.credential,'PUT','/api/plan-drafts/'+imported.draft.id,{})).status,401);
  db.prepare('UPDATE plan_api_access SET expires_at=? WHERE user_id=?').run(Date.now()-1000,'sup');
  assert.equal((await call(second.credential,'GET','/api/internal/plan-drafts/'+imported.draft.id)).status,401);
  db.prepare('UPDATE plan_api_access SET expires_at=?,used_day=?,used_count=daily_quota WHERE user_id=?').run(Date.now()+3600000,new Date().toISOString().slice(0,10),'sup');
  assert.equal((await call(second.credential,'GET','/api/internal/plan-drafts/'+imported.draft.id)).status,429);
  await call('admin','PUT','/api/admin/plan-access/sup',{action:'revoke',note:'结束授权'});
  assert.equal((await call(second.credential,'GET','/api/internal/plan-drafts/'+imported.draft.id)).status,401);
});
test('后台桥接只返回建议草稿，无法授权发布；损坏结果回退并保留提示',async()=>{
  const http=require('http');let badResponse=false,received;
  const server=http.createServer(async(req,res)=>{let input='';for await(const part of req)input+=part;received=JSON.parse(input);res.writeHead(200,{'Content-Type':'application/json','Connection':'close'});res.end(JSON.stringify(badResponse?{rules:{stages:'bad'}}:{rules:{title:'整理后的练习',stages:[],slots:[{title:'阅读',minutes:25}],exceptions:[]},reviewed:true,publish:true}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const previous=process.env.PLAN_ASSIST_URL;process.env.PLAN_ASSIST_URL='http://127.0.0.1:'+server.address().port;
  try{
    const r=await call('sup','POST','/api/plan-import',input);assert.equal(r.status,201);assert.equal(r.draft.workspace.title,'整理后的练习');assert.equal(r.draft.reviewed,false);assert.ok(r.draft.source.lines.every(l=>l.kind==='suggested'));assert.equal(received.protocol,'markly.plan-rules.v1');assert.equal(received.assigneeId,undefined);assert.equal(received.sourceText,text);
    badResponse=true;const fallback=await call('sup','POST','/api/plan-import',input);assert.equal(fallback.status,201);assert.equal(fallback.draft.workspace.title,'英语习惯');assert.ok(fallback.draft.source.notices.some(n=>n.includes('暂不可用')));
  }finally{if(previous===undefined)delete process.env.PLAN_ASSIST_URL;else process.env.PLAN_ASSIST_URL=previous;await new Promise(r=>server.close(r));await new Promise(r=>setTimeout(r,50));}
});
after(()=>{closeDb();for(const suffix of ['','-wal','-shm'])fs.rmSync(process.env.DB_PATH+suffix,{force:true});});

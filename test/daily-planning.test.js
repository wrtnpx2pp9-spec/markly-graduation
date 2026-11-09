'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
process.env.DB_PATH = ':memory:';
const database = require('../src/db'), db = database.getDb();
const users = require('../src/repo/user.repo'), plans = require('../src/repo/plan.repo');
const lifecycle = require('../src/plan-lifecycle');
let current, serial=0;
const deps = {notify:{deliver(){}},security:{authenticate:()=>({user:current})}};
const router = require('../src/router').createRouter({db,deps});
for(const name of ['plan','daily-planning','task','market','cooperation-history','dashboard']) require(`../src/controllers/${name}.ctrl`).register(router,deps);
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

const daily=require('../src/repo/daily-planning.repo');
const ds=n=>{const d=new Date(date(n));return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
function setup(){const {sup,sub}=pair();const root=ok(sup,'POST','/api/plan-bundles',{...input(sub,0,27),planningMode:'rolling',cycles:[{title:'适应阶段',startDate:ds(0),endDate:ds(27),rhythm:'每周四次，提前三天协商'}]}).plan;ok(sub,'POST',`/api/plans/${root.id}/agreement`,{decision:'accept'});const stage=db.prepare('SELECT * FROM plans WHERE parent_id=?').get(root.id);return {sup,sub,root,stage,url:`/api/plans/${stage.id}/daily-proposals`};}
function draft(x,who=x.sub,offset=0,payload={rest:false,items:[{title:'阅读十分钟'},{title:'背诵20词'}]}){return ok(who,'POST',x.url,{date:ds(offset),payload,reason:'按近期空闲时间安排'}).proposal;}
function action(x,who,r,verb){return call(who,'POST',`${x.url}/${r.id}/action`,{action:verb,version:r.version,note:'请调整'});}
function accept(x,r,author=x.sub,reviewer=x.sup){assert.equal(action(x,author,r,'submit').http,200);assert.equal(action(x,reviewer,{...r,version:r.version+1},'accept').http,200);}
test('长期阶段无自动日程；双方提出，对方确认才生成执行日',()=>{
 const x=setup();assert.equal(plans.listDays(db,x.stage.id).length,0);assert.equal(x.stage.planning_mode,'rolling');
 const r=draft(x);assert.equal(ok(x.sup,'GET',x.url).proposals.length,0);assert.equal(plans.listDays(db,x.stage.id).length,0);
 assert.equal(action(x,x.sub,r,'submit').http,200);assert.equal(action(x,x.sub,{...r,version:2},'accept').http,403);
 assert.equal(action(x,x.sup,r,'accept').http,409);assert.equal(action(x,x.sup,{...r,version:2},'accept').http,200);
 assert.equal(daily.snapshot(db,x.stage.id,ds(0)).items.length,2);
 accept(x,draft(x,x.sup,1),x.sup,x.sub);assert.equal(plans.listDays(db,x.stage.id).length,2);
 assert.equal(lifecycle.readyForReview(db,x.stage),false);
});
test('每日提案允许双方提出，但必须由对方确认',()=>{
 const x=setup();
 const r=draft(x,x.sup);
 assert.equal(action(x,x.sub,r,'accept').http,403);
 assert.equal(action(x,x.sup,r,'submit').http,200);
 assert.equal(action(x,x.sub,{...r,version:2},'accept').http,200);
});
test('滚动窗口为今天至第14天，过去和第15天不能安排',()=>{
 const x=setup();for(const n of [-1,14])assert.equal(call(x.sub,'POST',x.url,{date:ds(n),payload:{rest:true,items:[]},reason:'休息'}).http,400);
 accept(x,draft(x,x.sub,13));assert.ok(daily.snapshot(db,x.stage.id,ds(13)));
});
test('草稿修改有版本保护，退回和撤回均不替换原安排',()=>{
 const x=setup(),r=draft(x);const body={date:ds(0),draftId:r.id,version:r.version,payload:{rest:false,items:[{title:'改为听力'}]},reason:'调整'};
 const edited=ok(x.sub,'POST',x.url,body).proposal;assert.equal(edited.version,2);assert.equal(call(x.sub,'POST',x.url,body).http,409);
 assert.equal(action(x,x.sub,edited,'submit').http,200);assert.equal(action(x,x.sup,{...edited,version:3},'decline').http,200);assert.equal(daily.snapshot(db,x.stage.id,ds(0)),null);
 const next=draft(x);assert.equal(action(x,x.sub,next,'withdraw').http,200);assert.equal(daily.snapshot(db,x.stage.id,ds(0)),null);
});
test('确认变更保留已完成项及被移除事项历史；执行变化阻止过时确认',()=>{
 const x=setup();accept(x,draft(x));let snap=daily.snapshot(db,x.stage.id,ds(0));const done=snap.items[0],removed=snap.items[1];
 db.prepare("UPDATE plan_day_items SET status='done' WHERE id=?").run(done.id);
 assert.equal(call(x.sub,'POST',x.url,{date:ds(0),payload:{rest:true,items:[]},reason:'休息'}).http,409);
 const r=draft(x,x.sub,0,{rest:false,items:[{id:done.id,title:done.title},{title:'新增听力'}]});
 assert.equal(daily.snapshot(db,x.stage.id,ds(0)).items[1].id,removed.id);accept(x,r);
 assert.equal(daily.snapshot(db,x.stage.id,ds(0)).items[0].status,'done');assert.ok(db.prepare('SELECT removed_at FROM plan_day_items WHERE id=?').get(removed.id).removed_at);
 snap=daily.snapshot(db,x.stage.id,ds(0));const stale=draft(x,x.sub,0,{rest:false,items:snap.items.map(i=>({id:i.id,title:i.title}))});
 assert.equal(action(x,x.sub,stale,'submit').http,200);db.prepare("UPDATE plan_day_items SET status='done' WHERE id=?").run(snap.items[1].id);
 assert.equal(action(x,x.sup,{...stale,version:2},'accept').http,409);
});
test('休息可恢复成安排；已提交和已审核的执行日不能改写',()=>{
 const x=setup();accept(x,draft(x,x.sub,0,{rest:true,items:[]}));assert.equal(daily.snapshot(db,x.stage.id,ds(0)).day.checkin_state,'cancelled');
 accept(x,draft(x));const snap=daily.snapshot(db,x.stage.id,ds(0));assert.equal(snap.day.checkin_state,'unsubmitted');
 for(const state of ['submitted','approved']){db.prepare('UPDATE plan_days SET checkin_state=? WHERE id=?').run(state,snap.day.id);assert.equal(call(x.sub,'POST',x.url,{date:ds(0),payload:{rest:true,items:[]},reason:'改动'}).http,409);}
});
test('滚动安排贯通逐项执行、退回补充、确认与归档留存，完成当天不提前结束阶段',()=>{
 const x=setup();accept(x,draft(x));
 const snap=daily.snapshot(db,x.stage.id,ds(0)),dayUrl=`/api/plans/${x.stage.id}/days/${snap.day.id}`;
 assert.equal(call(x.sub,'POST',`${dayUrl}/checkin`,{note:'未勾完不能提交'}).http,400);
 for(const item of snap.items)ok(x.sub,'POST',`${dayUrl}/items/${item.id}/toggle`,{done:true});
 ok(x.sub,'POST',`${dayUrl}/checkin`,{note:'完成今日阅读和背诵'});
 assert.equal(daily.snapshot(db,x.stage.id,ds(0)).day.checkin_state,'submitted');
 assert.equal(call(x.sub,'POST',`${dayUrl}/review`,{decision:'approved'}).http,403);
 assert.equal(call(x.sub,'POST',`${dayUrl}/items/${snap.items[0].id}/toggle`,{done:false}).http,409);
 assert.equal(call(x.sup,'POST',`${dayUrl}/review`,{decision:'rejected'}).http,400);
 ok(x.sup,'POST',`${dayUrl}/review`,{decision:'rejected',reviewNote:'请补充阅读章节'});
 ok(x.sub,'POST',`${dayUrl}/checkin`,{note:'补充：阅读第一章，复习20词'});
 ok(x.sup,'POST',`${dayUrl}/review`,{decision:'approved',reviewNote:'内容确认'});
 assert.equal(lifecycle.readyForReview(db,plans.byId(db,x.stage.id)),false);
 ok(x.sup,'POST',`/api/plans/${x.root.id}/archive`);
 const record=ok(x.sub,'GET',`/api/cooperation-history/plans/${x.root.id}`).records.find(p=>p.id===x.stage.id);
 assert.equal(record.status,'archived');
 assert.equal(record.days.length,1);
 assert.equal(record.days[0].checkinState,'approved');
 assert.equal(record.days[0].note,'补充：阅读第一章，复习20词');
 assert.equal(record.days[0].items.every(item=>item.status==='done'),true);
 assert.equal(record.dailyProposals[0].status,'accepted');
 assert.equal(call(x.sub,'POST',`${dayUrl}/checkin`,{note:'覆盖历史'}).http,409);
});
test('归档和解绑关闭未决提案，历史可见但新合作人无法读写',()=>{
 const x=setup(),r=draft(x);ok(x.sup,'POST',`/api/plans/${x.root.id}/archive`);assert.equal(ok(x.sub,'GET',x.url).proposals[0].status,'closed');assert.equal(action(x,x.sub,r,'submit').http,409);assert.equal(ok(x.sup,'GET',x.url).proposals.length,0);
 const y=setup(),pending=draft(y);ok(y.sub,'DELETE',`/api/relations/${y.sup.id}`);assert.equal(ok(y.sub,'GET',y.url).proposals[0].status,'closed');
 const stranger=pair().sup;assert.equal(call(stranger,'GET',y.url).http,404);assert.equal(action(y,stranger,pending,'accept').http,404);
});
test('确认事务失败不会留下部分执行日，升级重复运行保留提案',()=>{
 const x=setup(),r=draft(x);assert.equal(action(x,x.sub,r,'submit').http,200);
 db.exec("CREATE TRIGGER fail_daily BEFORE INSERT ON plan_day_items BEGIN SELECT RAISE(ABORT,'test failure'); END");
 try{assert.throws(()=>action(x,x.sup,{...r,version:2},'accept'),/test failure/);assert.equal(daily.snapshot(db,x.stage.id,ds(0)),null);assert.equal(ok(x.sub,'GET',x.url).proposals[0].status,'submitted');}finally{db.exec('DROP TRIGGER fail_daily');}
 daily.init(db);daily.init(db);assert.equal(action(x,x.sup,{...r,version:2},'accept').http,200);
});
test.after(()=>database.closeDb());

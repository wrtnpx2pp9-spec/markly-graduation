'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function context(){
  const c=vm.createContext({Intl,Date,document:{addEventListener(){}},SIDEBAR_ITEMS:[{},{}],me:{id:'sup',role:'supervisor'},st:{},esc:value=>String(value??''),fmtTime:ts=>'日期 '+ts,todayStrL:()=> '2030-01-02'});
  const core=fs.readFileSync('public/js/core.js','utf8');
  vm.runInContext(core.slice(core.indexOf('let serviceTimezone'),core.indexOf('function isOverdue')),c);
  vm.runInContext("serviceTimezone='Asia/Shanghai';todayStr=()=> '2030-01-02'",c);
  vm.runInContext(fs.readFileSync('public/js/home.js','utf8'),c);
  vm.runInContext(fs.readFileSync('public/js/experience.js','utf8'),c);
  return c;
}
const plans=[{id:'active',status:'active'},{id:'archived',status:'archived'}];
const day=(id,checkinState='unsubmitted',dayDate='2030-01-01',more={})=>({id,planId:'active',creatorId:'sup',assigneeId:'sub',dayDate,checkinState,createdAt:1,content:id,...more});
const task=(id,status='pending',dueAt=null,more={})=>({id,creatorId:'sup',assigneeId:'sub',title:id,status,dueAt,createdAt:1,...more});
function build(c,role,days=[],tasks=[]){return c.buildHomeWorklist({user:{id:role==='supervisor'?'sup':'sub',role},days,tasks,plans,today:'2030-01-02'});}
const keys=rows=>Array.from(rows,row=>row.key);
test('监督者跨天审核、困难、到期和无截止事项互斥分类，审核后仍保留未回复困难',()=>{
  const c=context(),submitted=day('review','submitted','2029-12-30',{checkinSubmittedAt:3,helpNote:'需要帮助'});
  const days=[submitted,day('help-done','approved','2029-12-31',{helpNote:'困难'}),day('late'),day('today','rejected','2030-01-02'),day('future','unsubmitted','2030-01-03'),day('rest','cancelled'),day('done','approved'),day('archive','submitted','2030-01-01',{planId:'archived'}),day('other','submitted','2030-01-01',{creatorId:'other'})];
  const tasks=[task('undated'),task('undated-review','submitted'),task('old-review','submitted',Date.parse('2029-01-01T00:00Z')),task('future','pending',Date.parse('2030-01-03T00:00Z')),task('cancel','cancelled'),task('done','done'),task('archive','pending',null,{planId:'archived'})];
  const q=build(c,'supervisor',days,tasks);
  assert.deepEqual(keys(q.groups.reviews),['task:undated-review','day:review','task:old-review']);
  assert.deepEqual(keys(q.groups.help),['day:help-done']);
  assert.deepEqual(keys(q.groups.overdue),['day:late']);
  assert.deepEqual(keys(q.groups.today),['day:today']);
  assert.deepEqual(keys(q.groups.undated),['task:undated']);
  assert.equal(q.actionable,7);assert.equal(q.waiting,0);
  submitted.checkinState='approved';
  assert.ok(keys(build(c,'supervisor',days,tasks).groups.help).includes('day:review'));
  submitted.helpReply='已回应';
  assert.ok(!Object.values(build(c,'supervisor',days,tasks).groups).flat().some(row=>row.key==='day:review'));
});
test('执行者补交、退回、今天和无截止待执行与等待对方分离，未来与完成项不误报待执行',()=>{
  const c=context(),days=[day('late-help','rejected','2030-01-01',{helpNote:'帮助'}),day('today','withdrawn','2030-01-02'),day('review','submitted','2029-12-01'),day('approved-help','approved','2029-12-01',{helpNote:'困难'}),day('approved','approved'),day('rest','cancelled'),day('future','unsubmitted','2030-01-03')];
  const q=build(c,'supervisee',days,[task('undated'),task('review','submitted'),task('future','pending',Date.parse('2030-01-03T00:00Z'))]);
  assert.deepEqual(keys(q.groups.overdue),['day:late-help']);assert.deepEqual(keys(q.groups.today),['day:today']);
  assert.deepEqual(keys(q.groups.undated),['task:undated']);
  assert.deepEqual(keys(q.groups.waiting).sort(),['day:approved-help','day:review','task:review']);
  const all=Object.values(q.groups).flat().map(row=>row.key);assert.equal(new Set(all).size,all.length);
  assert.equal(q.actionable,3);assert.equal(q.waiting,3);
});
test('普通任务使用服务时区比较日期，epoch 0 有截止，顺序不受响应数组排列影响',()=>{
  const c=context(),tasks=[task('today','pending',Date.parse('2030-01-01T16:30Z')),task('tomorrow','pending',Date.parse('2030-01-02T16:30Z')),task('epoch','pending',0),task('undated-b'),task('undated-a')];
  const q=build(c,'supervisee',[],tasks),reversed=build(c,'supervisee',[],[...tasks].reverse());
  assert.deepEqual(keys(q.groups.today),['task:today']);assert.deepEqual(keys(q.groups.overdue),['task:epoch']);
  assert.deepEqual(keys(q.groups.undated),['task:undated-a','task:undated-b']);
  for(const group of Object.keys(q.groups))assert.deepEqual(keys(q.groups[group]),keys(reversed.groups[group]));
  assert.doesNotMatch(c.workTaskCard(tasks[2]),/未设截止时间/);
  assert.deepEqual(Array.from(c.homeToday(tasks),x=>x.id),['today']);
});
test('超过五项保留全部内容并可展开，待办摘要不把跨天或待反馈误称完成',()=>{
  const c=context(),tasks=Array.from({length:9},(_,i)=>task('task-'+i));
  const q=build(c,'supervisee',[],tasks),html=c.homeWorkGroup('undated','未设截止的事项',q.groups.undated);
  assert.match(html,/<details data-work-more="undated"><summary>展开其余 4 项<\/summary>/);
  assert.equal((html.match(/data-work-item=/g)||[]).length,9);
  assert.equal((html.split('<details')[0].match(/data-work-item=/g)||[]).length,5);
  for(const t of tasks)assert.equal(html.split('data-work-item="task:'+t.id+'"').length,2);
  assert.match(c.homePendingStatus(tasks,[],plans),/9.*未设截止/);
  assert.match(c.homePendingStatus([], [day('old','submitted','2029-01-01')],plans),/等待确认/);
  assert.match(c.homePendingStatus([], [day('help','approved','2029-01-01',{helpNote:'帮助'})],plans),/困难等待回复/);
  assert.match(c.homePendingStatus([], [day('late','rejected')],plans),/待补交/);
  assert.doesNotMatch(c.homePendingStatus([], [day('future','unsubmitted','2030-01-03')],plans),/完成啦|逾期/);
  assert.doesNotMatch(c.homePendingStatus([], [day('archived','unsubmitted','2030-01-01',{planId:'archived'})],plans),/待补交|待办|完成啦/);
});

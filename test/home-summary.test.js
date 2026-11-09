'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm');

const source = fs.readFileSync('public/js/home.js', 'utf8');
function render(workDays, tasks = []) {
  const context = {
    st: { tasks, workDays: workDays.map(d=>({planId:'active',...d})), plans: [{id:'active',status:'active'},{id:'archived',status:'archived'}], rank: { scope: 'group', dim: 'plan' } },
    me: { id: 'sub', displayName: '执行人', identity: 'mentee', supervision: { supervisorIds: [] } },
    people: [],
    todayStr: () => '2030-01-01',
    esc: value => String(value),
    avatarHTML: () => '',
    api: async () => ({ list: [] }),
    homeGreet: () => '早上好', homeDateStr: () => '1月1日', homeDayStart: () => 0,
    isOverdue: () => false, wireRank: async () => {},
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const container = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  context.renderSuperviseeHome(container);
  return container.innerHTML;
}

test('首页今日摘要包含待提交计划日，避免空任务时误报全部完成', () => {
  const html = render([{ id: 'day-1', dayDate: '2030-01-01', checkinState: 'submitted' }]);
  assert.match(html, /有 <b>1<\/b> 件已提交，等待确认/);
  assert.match(html, /<b>0<\/b><span class="muted"> \/ 1 已确认/);
  assert.doesNotMatch(html, /任务都完成啦/);
  const approved = render([{ id: 'day-1', dayDate: '2030-01-01', checkinState: 'approved' }]);
  assert.match(approved, /<b>1<\/b><span class="muted"> \/ 1 已确认/);
});

test('当前安排确认率排除取消任务、休息日和归档，保留未来与待审核分母',()=>{
  const html=render([
    {id:'done',dayDate:'2030-01-01',checkinState:'approved'},
    {id:'rest',dayDate:'2030-01-01',checkinState:'cancelled'},
    {id:'history',planId:'archived',dayDate:'2029-12-31',checkinState:'unsubmitted'},
    {id:'future',dayDate:'2030-01-02',checkinState:'unsubmitted'},
  ],[
    {id:'cancelled',status:'cancelled',dueAt:null},
    {id:'archived',planId:'archived',status:'pending',dueAt:null},
    {id:'submitted',status:'submitted',dueAt:null},
    {id:'done',status:'done',dueAt:null},
  ]);
  assert.match(html, /<b>50%<\/b>/);
  assert.match(html, /<b>2<\/b><span class="muted"> \/ 4 已确认/);
  assert.match(html,/当前安排确认率/);
});

test('首页摘要提示过去未提交的计划日待补交', () => {
  const html = render([{ id: 'day-2', dayDate: '2029-12-31', checkinState: 'unsubmitted' }]);
  assert.match(html, /有 <b>1<\/b> 天待补交/);
  assert.doesNotMatch(html, /任务都完成啦/);
});

test('empty schedule and old submissions are not reported as all completed',()=>{
 assert.doesNotMatch(render([]),/任务都完成啦/);
 assert.match(render([{id:'old',dayDate:'2029-12-31',checkinState:'submitted'}]),/等待确认/);
});

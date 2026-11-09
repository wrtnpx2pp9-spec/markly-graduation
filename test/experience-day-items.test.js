'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('今日打卡弹窗展示多项任务并可逐项勾选，提交后锁定只读',async()=>{
  let modalHTML='',calls=[],submitted=false,lastError=''; const buttons=[]; const dialog={isConnected:true}; const state={plans:[{id:'cycle',status:'active'}],_pd:{}};
  const context=vm.createContext({
    st:state,me:{id:'student'},modalReadGuard:()=>()=>true,
    esc:v=>String(v??''),todayStrL:()=> '2030-01-01',toast:e=>{lastError=String(e)},closeModal:()=>{},
    dayCheckModal:()=>{},phaseWithdrawModal:()=>{},phaseDayReviewModal:()=>{},phaseRefresh:()=>{},
    _pd(){return state._pd;},
    api:async(method,url,body)=>{calls.push({method,url,body});if(method==='GET')return {plan:{id:'cycle',title:'计划',assigneeId:'student',creatorId:'supervisor',status:'active'},day:{id:'day',seq:1,dayDate:'2030-01-01',content:'完成今日安排',checkinState:submitted?'submitted':'unsubmitted',items:[{id:'a',title:'阅读',status:'pending'},{id:'b',title:'练习',status:'pending'}]}};return {item:{id:'a',title:'阅读',status:body.done?'done':'pending'}};},
    document:{querySelectorAll:()=>buttons,addEventListener:()=>{}},
    $modal:{querySelector:()=>dialog},
    openModal:(title,html)=>{modalHTML=html;buttons.length=0;const ids=[...html.matchAll(/data-detail-item="([^"]+)"/g)].map(x=>x[1]);ids.forEach(id=>buttons.push({dataset:{detailItem:id},disabled:html.includes('aria-checked="false"')&&html.includes('disabled'),onclick:null,classList:{toggle:()=>{}},setAttribute:()=>{},querySelector:()=>({textContent:''})}));},
    $:()=>({textContent:'',disabled:false}),SIDEBAR_ITEMS:[{},{}],renderView:()=>{},loadSection:()=>{},goView:()=>{}
  });
  vm.runInContext(fs.readFileSync('public/js/experience.js','utf8'),context);
  await vm.runInContext('openDay("day")',context);
  assert.equal(lastError,'');assert.match(modalHTML,/阅读/);assert.match(modalHTML,/练习/);assert.equal(buttons.length,2);
  await buttons[0].onclick();
  assert.equal(calls.at(-1).url,'/api/plans/cycle/days/day/items/a/toggle');
  assert.equal(state._pd.cycle.find(x=>x.id==='day').items[0].status,'done');
  submitted=true;
  await vm.runInContext('openDay("day")',context);
  assert.equal(buttons.every(b=>b.disabled),true);
  assert.doesNotMatch(modalHTML,/id="detail-check"/);
});

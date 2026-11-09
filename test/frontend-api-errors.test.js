'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');

test('write failures expose HTTP status for conflict recovery without replaying the write',async()=>{
  let calls=0,status=409;
  const context=vm.createContext({
    document:{getElementById:()=>null},localStorage:{removeItem(){}},
    fetch:async()=>{calls++;return {ok:false,status,json:async()=>({error:'服务器拒绝此次保存'})};},
  });
  vm.runInContext(fs.readFileSync('public/js/core.js','utf8'),context);
  await assert.rejects(vm.runInContext("api('POST','/api/plans/stage/daily-proposals',{version:1})",context),e=>e.status===409&&e.message==='服务器拒绝此次保存');
  assert.equal(calls,1);
  status=503;
  await assert.rejects(vm.runInContext("api('POST','/api/plans/stage/daily-proposals',{version:1})",context),e=>e.status===503);
  assert.equal(calls,2);
});

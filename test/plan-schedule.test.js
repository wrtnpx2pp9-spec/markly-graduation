const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeSchedule,slotTitle}=require('../src/plan-schedule');
test('时间段支持概略时间与精确时间，精确区间决定学习量',()=>{
  const s=normalizeSchedule({weekGoal:'词汇基础',weekMinutes:300,dayGoal:'复习',slots:[{title:'听力',startTime:'19:00',endTime:'19:30',minutes:99},{title:'复盘',timeLabel:'饭后',minutes:10}]});
  assert.equal(s.slots[0].minutes,30);assert.equal(slotTitle(s.slots[1]),'饭后 · 复盘');
  assert.equal(normalizeSchedule(undefined),undefined);
});
test('拒绝时间重叠、不完整、无效时间与超量事项',()=>{
  for(const slots of [
    [{title:'a',startTime:'19:00',endTime:'19:30'},{title:'b',startTime:'19:20',endTime:'20:00'}],
    [{title:'a',startTime:'19:00'}], [{title:'a',startTime:'25:00',endTime:'26:00'}],
    [{title:'a',minutes:-1}],Array.from({length:13},()=>({title:'a'})),[{title:''}]
  ])assert.throws(()=>normalizeSchedule({slots}));
});

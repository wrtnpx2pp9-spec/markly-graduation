const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('public/js/core.js','utf8');
function clock(zone){const c=vm.createContext({Intl,Date});vm.runInContext(source.slice(source.indexOf('let serviceTimezone'),source.indexOf('function isOverdue')),c);vm.runInContext(`serviceTimezone=${JSON.stringify(zone)}`,c);return code=>vm.runInContext(code,c);}
test('业务时区的日期时间往返不依赖浏览器本地时区',()=>{
  for(const zone of ['Asia/Shanghai','America/Los_Angeles','UTC']){
    const run=clock(zone);assert.equal(run("toLocalInput(fromLocalInput('2030-01-02T00:15'))"),'2030-01-02T00:15');
    assert.throws(()=>run("fromLocalInput('2030-02-30T00:00')"));
  }
  assert.equal(clock('Asia/Shanghai')("fromLocalInput('2030-01-02T00:15')"),Date.parse('2030-01-01T16:15:00Z'));
  assert.equal(clock('America/Los_Angeles')("toLocalInput(Date.parse('2030-01-02T00:15:00Z'))"),'2030-01-01T16:15');
});
test('夏令时不存在的墙上时间明确拒绝而非静默偏移',()=>{
  assert.throws(()=>clock('America/Los_Angeles')("fromLocalInput('2030-03-10T02:30')"),/不存在/);
});

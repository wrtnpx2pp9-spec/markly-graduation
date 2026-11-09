/* 限制堆内存下测量真实HTTP慢投递：临时SQLite，模拟端点，无外部微信访问。 */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {performance,monitorEventLoopDelay}=require('perf_hooks');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-queue-bench-'));
process.env.DB_PATH=path.join(tmp,'queue.db');
const {getDb,closeDb}=require('../src/db'),db=getDb(),notify=require('../src/notify');
const count=1000,latencyMs=200;
let inFlight=0,peak=0,received=0,peakRss=process.memoryUsage().rss;
const seen=new Set();
const remote=http.createServer((req,res)=>{
  req.resume();inFlight++;peak=Math.max(peak,inFlight);
  const id=req.headers['idempotency-key'];
  if(seen.has(id))throw new Error('duplicate '+id);seen.add(id);
  setTimeout(()=>{received++;inFlight--;res.end('{}');},latencyMs);
});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let worker,sampler;
(async()=>{
  try{
    await new Promise(r=>remote.listen(0,'127.0.0.1',r));
    notify.setNotifyConfig(db,{enabled:true,webhookUrl:'http://127.0.0.1:'+remote.address().port});
    const insert=db.prepare("INSERT INTO notification_outbox(id,channel,payload,status,next_attempt_at,created_at,delivery_key) VALUES (?,'global',?,'pending',?,?,?)");
    db.exec('BEGIN');
    for(let i=0;i<count;i++)insert.run('bench-'+i,JSON.stringify({recipient:{id:'u'+i},title:'积压通知',content:'测试'}),Date.now(),Date.now(),'global:u'+i);
    db.exec('COMMIT');
    const loop=monitorEventLoopDelay({resolution:10});loop.enable();
    const cpu=process.cpuUsage(),started=performance.now();
    sampler=setInterval(()=>peakRss=Math.max(peakRss,process.memoryUsage().rss),100);
    worker=notify.startOutbox(db);
    while(worker.stats().sent<count){if(performance.now()-started>120000)throw new Error('queue timeout');await sleep(25);}
    const elapsed=(performance.now()-started)/1000,used=process.cpuUsage(cpu);
    await worker.stop();loop.disable();
    const report={at:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model,execArgv:process.execArgv,
      constraints:'CPU亲和性由外部启动器设置；V8堆上限见execArgv。包含本地模拟HTTP接收端，不等同真实4核4G云服务器。',
      messages:count,remoteDelayMs:latencyMs,concurrency:worker.stats().concurrency,peakHttpInFlight:peak,received,
      elapsedSeconds:+elapsed.toFixed(2),messagesPerSecond:+(count/elapsed).toFixed(1),peakRssMiB:+(peakRss/2**20).toFixed(1),
      cpuSeconds:+((used.user+used.system)/1e6).toFixed(2),eventLoopP95Ms:+(loop.percentile(95)/1e6).toFixed(1),eventLoopMaxMs:+(loop.max/1e6).toFixed(1),
      queue:worker.stats()};
    console.log(JSON.stringify(report,null,2));
    const out=path.join(__dirname,'../output');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'queue-capacity-result.json'),JSON.stringify(report,null,2));
  }finally{
    clearInterval(sampler);if(worker)await worker.stop();remote.closeAllConnections();await new Promise(r=>remote.close(r));
    closeDb();fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

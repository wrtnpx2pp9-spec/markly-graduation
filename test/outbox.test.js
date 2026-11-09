'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'desk-outbox-'));
process.env.DB_PATH = path.join(dir,'app.db');
const {getDb,closeDb}=require('../src/db');
const db=getDb();
const {createOutboxWorker}=require('../src/outbox-worker');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const insert=db.prepare("INSERT INTO notification_outbox(id,payload,status,next_attempt_at,created_at,delivery_key,channel) VALUES (?,?,'pending',?,?,?,'global')");
function seed(id, key=id, payload={}) { insert.run(id,JSON.stringify(payload),Date.now(),Date.now(),key); }
async function waitFor(check,ms=5000) {const until=Date.now()+ms;while(!check()){if(Date.now()>until)throw new Error('timeout');await sleep(10);}}
test.beforeEach(()=>db.exec('DELETE FROM notification_outbox'));
test.after(()=>{closeDb();fs.rmSync(dir,{recursive:true,force:true});});

test('持续消费越过20条，慢请求不阻塞其他槽位，并发有界',async()=>{
  for(let i=0;i<80;i++)seed('burst-'+i);
  let current=0,peak=0;const seen=new Set();let releaseSlow;
  const slow=new Promise(r=>releaseSlow=r);
  const worker=createOutboxWorker(db,{concurrency:4,pollMs:20,send:async row=>{
    current++;peak=Math.max(peak,current);assert.equal(seen.has(row.id),false);seen.add(row.id);
    if(row.id==='burst-0')await slow;else await sleep(5);current--;
  }}).start();
  try {
    await waitFor(()=>worker.stats().sent>=79);
    assert.equal(worker.stats().inFlight,1);assert.equal(peak,4);
    releaseSlow();await waitFor(()=>worker.stats().sent===80);
    assert.equal(seen.size,80);
  } finally {releaseSlow();await worker.stop();}
});

test('失败退避释放槽位，不立即反复重试；到期后可以恢复',async()=>{
  seed('bad');seed('good');let fail=true;
  const worker=createOutboxWorker(db,{pollMs:20,send:async row=>{if(row.id==='bad'&&fail)throw new Error('temporary');}}).start();
  try{
    await waitFor(()=>worker.stats().failed===1&&worker.stats().sent===1);
    const failed=db.prepare("SELECT * FROM notification_outbox WHERE id='bad'").get();
    assert.equal(failed.status,'failed');assert.equal(failed.attempts,1);assert.ok(failed.next_attempt_at>Date.now()+10000);
    await sleep(60);assert.equal(worker.stats().failed,1);
    fail=false;db.prepare("UPDATE notification_outbox SET next_attempt_at=0 WHERE id='bad'").run();worker.wake();
    await waitFor(()=>worker.stats().sent===2);
    assert.equal(db.prepare("SELECT last_error FROM notification_outbox WHERE id='bad'").get().last_error,null);
  }finally{await worker.stop();}
});

test('原子领取与接收人锁防止重叠消费者重复领取、同人并发',async()=>{
  for(let i=0;i<20;i++)seed('shared-'+i,'recipient-'+i%3);
  const active=new Set(),seen=new Set();
  const send=async row=>{assert.ok(!active.has(row.delivery_key));assert.ok(!seen.has(row.id));active.add(row.delivery_key);seen.add(row.id);await sleep(5);active.delete(row.delivery_key);};
  const a=createOutboxWorker(db,{concurrency:4,pollMs:10,send}).start(),b=createOutboxWorker(db,{concurrency:4,pollMs:10,send}).start();
  try{await waitFor(()=>a.stats().sent+b.stats().sent===20);assert.equal(seen.size,20);assert.equal(a.stats().failed+b.stats().failed,0);}
  finally{await Promise.all([a.stop(),b.stop()]);}
});

test('回收崩溃租约；心跳保护进行中的慢投递',async()=>{
  seed('crashed');db.prepare("UPDATE notification_outbox SET status='sending',locked_at=0,lock_token='old' WHERE id='crashed'").run();
  let sends=0;
  const worker=createOutboxWorker(db,{leaseMs:120,pollMs:10,send:async()=>{sends++;await sleep(300);}}).start();
  const second=createOutboxWorker(db,{leaseMs:120,pollMs:10,send:async()=>{sends++;}}).start();
  try{await waitFor(()=>worker.stats().sent+second.stats().sent===1);assert.equal(sends,1);}
  finally{await Promise.all([worker.stop(),second.stop()]);}
});

test('停止后不领取新任务，等待在途任务完成再关闭',async()=>{
  seed('stop-a');seed('stop-b');let release;
  const held=new Promise(r=>release=r);
  const worker=createOutboxWorker(db,{concurrency:1,send:()=>held}).start();
  await waitFor(()=>worker.stats().inFlight===1);
  let stopped=false;const stopping=worker.stop().then(()=>stopped=true);
  await sleep(20);assert.equal(stopped,false);release();await stopping;
  assert.equal(worker.stats().claimed,1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_outbox WHERE status='pending'").get().n,1);
});

test('通道遇到限流后暂停新领取，其他通道仍能发送',async()=>{
  seed('rate-first');seed('rate-second');seed('wechat-ok');
  db.prepare("UPDATE notification_outbox SET channel='wechat' WHERE id='wechat-ok'").run();
  const worker=createOutboxWorker(db,{concurrency:1,pollMs:10,send:async row=>{
    if(row.id==='rate-first')throw Object.assign(new Error('limited'),{code:429,retryAfterMs:60000});
  }}).start();
  try{
    await waitFor(()=>worker.stats().failed===1&&worker.stats().sent===1);
    assert.ok(worker.stats().pausedUntil.global>Date.now()+50000);
    assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id='rate-second'").get().status,'pending');
  }finally{await worker.stop();}
});

test('事务回滚后的唤醒不发送消息，空闲worker可及时唤醒',async()=>{
  let delivered=0;
  const worker=createOutboxWorker(db,{pollMs:1000,send:async()=>delivered++}).start();
  try{
    await sleep(20);
    db.exec('BEGIN');seed('rollback');worker.wake();db.exec('ROLLBACK');
    await sleep(20);assert.equal(delivered,0);
    seed('commit');worker.wake();await waitFor(()=>delivered===1,500);
  }finally{await worker.stop();}
});

test('投递成功后活动记录失败不会把已发送通知重新入队',async()=>{
  seed('activity-failure','activity-recipient',{recipient:{id:'recipient-1'},title:'已发送'});
  const activity=require('../src/repo/activity.repo'),original=activity.record;
  let deliveries=0;
  const worker=createOutboxWorker(db,{pollMs:10,onError:()=>{},send:async()=>{deliveries++;}}).start();
  activity.record=()=>{throw new Error('activity unavailable');};
  try{
    await waitFor(()=>worker.stats().sent===1);
    const row=db.prepare("SELECT status,attempts FROM notification_outbox WHERE id='activity-failure'").get();
    assert.equal(deliveries,1);assert.equal(row.status,'sent');assert.equal(row.attempts,1);
  }finally{activity.record=original;await worker.stop();}
});

test('webhook成功、命令失败后重试不重发webhook，携带固定消息ID',async()=>{
  const http=require('http'),notify=require('../src/notify');let received=0,deliveryId;
  const server=http.createServer((req,res)=>{received++;deliveryId=req.headers['idempotency-key'];req.resume();res.end('{}');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const worker=notify.startOutbox(db);
  try{
    const recipient=require('../src/repo/user.repo').insert(db,{username:'stable-outbox-recipient',role:'supervisee',passwordHash:'hash',salt:'salt',displayName:'独立接收人',createdAt:Date.now()});
    notify.setNotifyConfig(db,{enabled:true,webhookUrl:'http://127.0.0.1:'+server.address().port,command:'unsafe && command'});
    seed('stable-id','global:'+recipient.id,{recipient:{id:recipient.id},title:'固定投递测试'});worker.wake();
    await waitFor(()=>db.prepare("SELECT status FROM notification_outbox WHERE id='stable-id'").get().status==='failed');
    assert.equal(received,1);assert.equal(deliveryId,'stable-id');
    notify.setNotifyConfig(db,{enabled:true,webhookUrl:'http://127.0.0.1:'+server.address().port});
    db.prepare("UPDATE notification_outbox SET next_attempt_at=0 WHERE id='stable-id'").run();worker.wake();
    await waitFor(()=>db.prepare("SELECT status FROM notification_outbox WHERE id='stable-id'").get().status==='sent');
    assert.equal(received,1);
  }finally{await worker.stop();server.closeAllConnections();await new Promise(r=>server.close(r));}
});

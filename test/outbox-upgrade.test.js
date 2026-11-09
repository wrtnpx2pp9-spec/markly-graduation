'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {DatabaseSync}=require('node:sqlite');
test('旧外发队列无损补列与索引，保持可重试数据和接收人锁',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'outbox-upgrade-'));
  process.env.DB_PATH=path.join(dir,'old.db');
  const old=new DatabaseSync(process.env.DB_PATH);
  old.exec(`CREATE TABLE notification_outbox(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,next_attempt_at INTEGER NOT NULL,locked_at INTEGER,lock_token TEXT,last_error TEXT,created_at INTEGER NOT NULL,sent_at INTEGER);
    INSERT INTO notification_outbox(id,payload,status,next_attempt_at,created_at) VALUES ('old','{"recipient":{"id":"one"}}','failed',0,1),('bad','broken-json','pending',0,2);`);
  old.close();
  const {getDb,closeDb}=require('../src/db');
  try{
    const db=getDb(),row=db.prepare("SELECT * FROM notification_outbox WHERE id='old'").get();
    assert.equal(row.channel,'global');assert.equal(row.delivery_key,'global:one');assert.equal(row.status,'failed');assert.equal(row.webhook_sent_at,null);
    const worker=require('../src/outbox-worker').createOutboxWorker(db,{send:async()=>{}});
    try{assert.equal((await worker.drain()).sent,1);assert.equal(db.prepare("SELECT status FROM notification_outbox WHERE id='bad'").get().status,'failed');}
    finally{await worker.stop();}
  }finally{closeDb();fs.rmSync(dir,{recursive:true,force:true});}
});

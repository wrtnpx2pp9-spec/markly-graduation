'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
test('生产服务自动消费队列，关闭时等待在途发送落库',async()=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-queue-server-'));
  process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.HOST='127.0.0.1';process.env.PORT='0';
  const {getDb,closeDb}=require('../src/db'),db=getDb(),notify=require('../src/notify');
  const user=require('../src/repo/user.repo').insert(db,{username:'test',role:'supervisee',displayName:'test',passwordHash:'hash',salt:'salt',createdAt:Date.now()});
  let release,arrived;
  const received=new Promise(r=>arrived=r);
  const remote=http.createServer((req,res)=>{req.resume();release=()=>res.end('{}');arrived();});
  await new Promise(r=>remote.listen(0,'127.0.0.1',r));
  notify.setNotifyConfig(db,{enabled:true,webhookUrl:'http://127.0.0.1:'+remote.address().port});
  const server=require('../server').start();
  try{
    await new Promise(r=>server.once('listening',r));
    notify.deliver(db,{userId:user.id,recipientUser:user,kind:'test',title:'test'});
    await Promise.race([received,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('worker did not start')),3000);t.unref();})]);
    let stopped=false;const closing=new Promise(r=>server.close(r));const stopping=server.stopBackground().then(()=>stopped=true);
    await new Promise(r=>setTimeout(r,20));assert.equal(stopped,false);
    release();await Promise.all([closing,stopping]);
    assert.equal(db.prepare('SELECT status FROM notification_outbox').get().status,'sent');
  }finally{
    release?.();await server.stopBackground();if(server.listening)await new Promise(r=>server.close(r));
    remote.closeAllConnections();await new Promise(r=>remote.close(r));closeDb();fs.rmSync(tmp,{recursive:true,force:true});
  }
});

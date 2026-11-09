/* 本机容量探测：仅创建临时数据库；HTTP负载与服务端分进程。 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-capacity-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
const { getDb, closeDb } = require('../src/db');
const security = require('../src/security');
const db = getDb();
const now = Date.now();
db.exec('BEGIN');
const salt = security.genSalt(), hash = security.hashPassword('Bench-only-1234', salt);
const user = db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)');
const plan = db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES (?, '容量测试', ?, ?, 'cycle','active',?)");
const relation = db.prepare("INSERT INTO supervision_relations(id,supervisor_id,supervisee_id,status,created_at) VALUES (?,?,?,'active',?)");
const task = db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status,created_at,due_at,remind_before_minutes) VALUES (?,'测试任务',?,?,'pending',?,?,30)");
const day = db.prepare("INSERT INTO plan_days(id,plan_id,seq,day_date,content,status,created_at) VALUES (?,?,?,'2035-01-01','每日内容','pending',?)");
const note = db.prepare("INSERT INTO notifications(id,user_id,kind,title,content,is_read,created_at) VALUES (?,?,'test','通知','测试通知',?,?)");
const tokens = [];
const supervisorTokens = [];
for (let i = 0; i < 5000; i++) user.run('u'+i, 'u'+i, i === 0 ? 'admin' : i <= 500 ? 'supervisor' : 'supervisee', hash, salt, '用户'+i, now);
for (let i = 0; i < 5000; i++) {
  const id = 'u'+i, owner = i > 500 ? 'u'+(1+i%500) : id;
  if (owner !== id) relation.run('r'+i, owner, id, now);
  plan.run('p'+i, owner, id, now);
  for (let n = 0; n < 20; n++) task.run('t'+i+'-'+n, owner, id, now, now+86400000);
  for (let n = 1; n <= 30; n++) day.run('d'+i+'-'+n, 'p'+i, n, now);
  for (let n = 0; n < 100; n++) note.run('n'+i+'-'+n, id, n<80?1:0, now+n);
  if (i >= 501 && i < 1001) tokens.push(security.createSession(db, id));
  if (i >= 1 && i <= 500) {
    db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='bench-record',capacity_override=10 WHERE id=?").run(id);
    supervisorTokens.push(security.createSession(db,id));
    require('../src/repo/profile.repo').save(db,id,{headline:'学习监督',bio:'容量测试',skills:['学习'],serviceStyle:'每日确认',published:true,accepting:true});
    const cert = require('../src/repo/profile.repo').submitCert(db,id,'测试认证','测试','测试');
    db.prepare("UPDATE certifications SET status='verified' WHERE id=?").run(cert);
  }
}
db.exec('COMMIT');
closeDb();
const child = spawn(process.execPath, ['--no-warnings', '-e', `const s=require('./server').start();s.on('listening',()=>process.send({port:s.address().port}));`], {
  cwd: path.join(__dirname, '..'), windowsHide: true,
  env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ILINK_STATE_DIR: path.join(tmp, 'ilink') }, stdio: ['ignore','ignore','pipe','ipc'],
});
child.stderr.on('data', b => process.stderr.write(b));
async function run(base, name, count, concurrency, request) {
  const times = []; let cursor = 0, errors = 0; const start = performance.now();
  await Promise.all(Array.from({length: concurrency}, async () => {
    for (;;) {
      const i = cursor++; if (i >= count) return;
      const started = performance.now();
      const response = await fetch(base + request(i).path, { ...request(i).options, signal: AbortSignal.timeout(30000) });
      await response.arrayBuffer(); if (!response.ok) errors++;
      times.push(performance.now()-started);
    }
  }));
  const seconds = (performance.now()-start)/1000; times.sort((a,b)=>a-b);
  return { name, count, concurrency, errors, seconds: +seconds.toFixed(2), rps: +(count/seconds).toFixed(1), p95Ms: +times[Math.floor(times.length*.95)].toFixed(1), maxMs: +times.at(-1).toFixed(1) };
}
(async () => {
  try {
    const port = await new Promise((resolve,reject) => { child.once('message', m=>resolve(m.port)); child.once('error',reject); child.once('exit',code=>reject(new Error('server exited '+code))); });
    const base = 'http://127.0.0.1:'+port;
    const headers = i => ({ Authorization: 'Bearer '+tokens[i%tokens.length], 'Content-Type':'application/json' });
    const results = [];
    results.push(await run(base,'notifications',1500,50,i=>({path:'/api/notifications',options:{headers:headers(i)}})));
    const paths = ['/api/people','/api/tasks','/api/plans','/api/me/worklist','/api/notifications'];
    results.push(await run(base,'mixed-read',1000,30,i=>({path:paths[i%paths.length],options:{headers:headers(i)}})));
    results.push(await run(base,'supervisor-read',500,20,i=>({path:paths[i%paths.length],options:{headers:{Authorization:'Bearer '+supervisorTokens[i%500]}}})));
    results.push(await run(base,'market-500-profiles',100,5,i=>({path:'/api/market',options:{headers:headers(i)}})));
    results.push(await run(base,'checkin-with-notification',500,20,i=>({path:`/api/tasks/t${501+i}-0/checkin`,options:{method:'POST',headers:headers(i),body:JSON.stringify({note:'已完成'})}})));
    results.push(await run(base,'login',100,3,i=>({path:'/api/auth/login',options:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'u'+(501+i),password:'Bench-only-1234'})}})));
    const report = { at: new Date().toISOString(), node:process.version, cpu:os.cpus()[0].model, logicalCpus:os.cpus().length, totalMemoryGiB:+(os.totalmem()/2**30).toFixed(1), dataset:{users:5000,tasks:100000,planDays:150000,notifications:500000}, results, limitations:'本机短时负载；没有真实微信连接、公网延迟或集中到点提醒，不是部署服务器容量保证。' };
    console.log(JSON.stringify(report,null,2));
    fs.mkdirSync(path.join(__dirname,'../output'),{recursive:true});
    fs.writeFileSync(path.join(__dirname,'../output/capacity-result.json'),JSON.stringify(report,null,2));
    if(results.some(r=>r.errors))process.exitCode=1;
  } finally {
    if(child.exitCode===null) { const stopped = new Promise(r=>child.once('exit',r)); child.kill(); await stopped; }
    fs.rmSync(tmp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});

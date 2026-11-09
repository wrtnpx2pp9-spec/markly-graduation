'use strict';
// Teaching fixtures only. Never loads .env, imports a database, or replaces an existing directory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function seedDemo(repoRoot = path.resolve(__dirname, '..')) {
  if (process.env.DB_PATH || process.env.ILINK_STATE_DIR) {
    throw Error('请先清除 DB_PATH 和 ILINK_STATE_DIR 环境变量；演示初始化只写固定 demo-data 目录。');
  }
  const directory = path.join(fs.realpathSync(repoRoot), 'demo-data');
  if (fs.existsSync(directory)) throw Error('demo-data 已存在，未覆盖任何文件。请保留现有演示或在其他全新项目副本初始化。');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, '.teaching-demo'), 'Markly synthetic local teaching data\n', {flag:'wx',mode:0o600});
  process.env.DB_PATH = path.join(directory, 'app.db');
  process.env.ILINK_STATE_DIR = path.join(directory, 'ilink-state');
  process.env.TZ = 'Asia/Shanghai';
  const database = require('../src/db');
  const security = require('../src/security');
  const users = require('../src/repo/user.repo');
  const cooperation = require('../src/repo/cooperation.repo');
  const tasks = require('../src/repo/task.repo');
  const { createApp } = require('../src/app');
  const db = database.getDb();
  const app = createApp(db);
  const accounts = [];
  const day = offset => {
    const date = new Date(); date.setHours(0,0,0,0); date.setDate(date.getDate()+offset);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  };
  function add(username, role, displayName) {
    const password='Demo_'+crypto.randomBytes(18).toString('base64url');
    const salt=security.genSalt();
    const user=users.insert(db,{username,role,displayName,passwordHash:security.hashPassword(password,salt),salt,status:1,createdAt:Date.now()});
    accounts.push({username,password,role}); return user;
  }
  async function call(user, method, route, body) {
    const token=security.createSession(db,user.id);
    let response;
    try {
      await app.dispatch(method,route,{method,headers:{authorization:'Bearer '+token},socket:{remoteAddress:'127.0.0.1'}},{
        writeHead(status){this.status=status;},end(text){response={status:this.status,...JSON.parse(text)};},
      },{},body||{});
      if (!response || response.status<200 || response.status>=300) throw Error('演示流程初始化失败：'+route+'，HTTP '+response?.status);
      return response;
    } finally { require('../src/repo/session.repo').remove(db,token); }
  }
  try {
    db.exec('BEGIN IMMEDIATE');
    const admin=add('admin_demo','admin','演示管理员');
    const mentor=add('mentor_demo','supervisor','示例导师');
    const student=add('student_demo','supervisee','示例同学');
    cooperation.save(db,mentor,admin.id,{state:'active',capacity:3,agreementRef:'EDUCATION-SYNTHETIC',note:'教学脚本生成的虚构授权，不代表真实认证。',published:true});
    users.setRelations(db,student.id,[mentor.id]);
    db.exec('COMMIT');
    const result=await call(mentor,'POST','/api/plan-bundles',{
      title:'示例目标：两周理解并扩展 Markly',description:'虚构教学数据，请自行设计扩展并验证。',
      assigneeId:student.id,planningMode:'rolling',cycles:[{title:'第一阶段：理解闭环与权限',startDate:day(0),endDate:day(13),rhythm:'先读架构，再完成一次计划、提交与审核；具体内容提前协商。'}],
    });
    await call(student,'POST',`/api/plans/${result.plan.id}/agreement`,{decision:'accept'});
    const stage=db.prepare('SELECT * FROM plans WHERE parent_id=? ORDER BY created_at,id LIMIT 1').get(result.plan.id);
    const base=`/api/plans/${stage.id}/daily-proposals`;
    const proposal=(await call(mentor,'POST',base,{date:day(0),payload:{rest:false,items:[{title:'阅读 README 并运行本地项目'},{title:'画出浏览器、控制器与仓储调用关系'}]},reason:'教学示例安排，可在页面核对。'})).proposal;
    await call(mentor,'POST',`${base}/${proposal.id}/action`,{action:'submit',version:proposal.version});
    await call(student,'POST',`${base}/${proposal.id}/action`,{action:'accept',version:proposal.version+1});
    tasks.insert(db,{planId:null,title:'阅读学习指南并选择一个扩展方向',note:'教学脚本生成的虚构任务，供演示提交和审核。',creatorId:mentor.id,assigneeId:student.id,dueAt:+new Date(day(1)+'T18:00:00'),remindBeforeMinutes:30,status:'pending',createdAt:Date.now()});
    await call(student,'POST','/api/life',{date:day(0),content:'这是一条自动生成的虚构生活记录，用于展示界面，不代表真实用户。',mood:'平静'});
    const accountsFile=path.join(directory,'accounts.md');
    fs.writeFileSync(accountsFile,'# 本机演示账号\n\n仅用于本次新生成的虚构演示库；请勿发布此文件。\n\n| 账号 | 密码 | 角色 |\n| --- | --- | --- |\n'+accounts.map(a=>`| ${a.username} | ${a.password} | ${a.role} |`).join('\n')+'\n',{flag:'wx',mode:0o600});
    return {database:process.env.DB_PATH,accountsFile};
  } finally {
    if (db.isTransaction) { try { db.exec('ROLLBACK'); } catch {} }
    await app.deps.planAgent.stop();
    await app.deps.platformAgent.stop();
    database.closeDb();
  }
}
if (require.main===module) seedDemo().then(()=>{
  console.log('已在 demo-data 创建全新虚构演示数据。账号和随机密码请在本机编辑器查看 demo-data/accounts.md。');
  console.log('运行 npm run demo，然后访问 http://127.0.0.1:8787。');
}).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={seedDemo};

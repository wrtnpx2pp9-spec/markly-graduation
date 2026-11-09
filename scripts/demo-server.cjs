'use strict';
// Separate local-only demo. Does not load .env or accept a DB/host override.
const fs=require('node:fs');
const path=require('node:path');
const directory=path.join(fs.realpathSync(path.resolve(__dirname,'..')),'demo-data');
try {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw Error('demo-data 必须是本地普通目录');
  for (const file of ['.teaching-demo','app.db','accounts.md']) {
    const stat=fs.lstatSync(path.join(directory,file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('演示文件必须是本地普通文件');
  }
  if (process.env.DB_PATH || process.env.ILINK_STATE_DIR) throw Error('请先清除 DB_PATH 和 ILINK_STATE_DIR 环境变量；演示不接受数据库路径覆盖。');
  Object.assign(process.env,{DB_PATH:path.join(directory,'app.db'),ILINK_STATE_DIR:path.join(directory,'ilink-state'),HOST:'127.0.0.1',PORT:'8787',TZ:'Asia/Shanghai',MAINTENANCE_MODE:'0',SETUP_TOKEN:'',PLAN_AGENT_MASTER_KEY:'',ADMIN_AGENT_SECONDARY_PASSWORD:'',PLAN_ASSIST_URL:'',PLAN_ASSIST_TOKEN:''});
  // Keep external channels off even after earlier local demonstrations changed a setting.
  const database=require('../src/db');
  const db=database.getDb();
  const settings=require('../src/repo/setting.repo');
  settings.set(db,'notify_config',JSON.stringify({enabled:false,webhookUrl:'',command:''}));
  settings.set(db,'wechat_ilink_config',JSON.stringify({enabled:false,mode:'mock'}));
  const planConfig=require('../src/plan-agent/config');planConfig.init(db);
  db.prepare("UPDATE plan_agent_config SET config_json=?,model_secret='',search_secret='' WHERE id=1").run(JSON.stringify({enabled:false}));
  database.closeDb();
  console.log('Markly 本地教学演示：仅监听 127.0.0.1:8787，AI、微信和外部通知关闭。');
  const server=require('../server').start();
  let stopping=false;
  const shutdown=()=>{
    if(stopping)return;stopping=true;
    const closed=new Promise(resolve=>server.close(resolve));
    Promise.all([closed,server.stopBackground()]).then(()=>{database.closeDb();process.exit(0);})
      .catch(()=>{console.error('演示服务停止失败，请保留演示目录后检查。');process.exit(1);});
    setTimeout(()=>process.exit(1),45000).unref();
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
} catch (error) { console.error(error.code==='ENOENT'?'未找到完整演示数据，请先运行 npm run demo:seed。':error.message);process.exitCode=1; }

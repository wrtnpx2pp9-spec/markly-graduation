/* 可重复的浏览器回归：独立临时数据库，不访问真实业务数据。
   需要 playwright 可在 NODE_PATH 中解析；node scripts/ui-smoke.cjs */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-ui-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';
const {getDb,closeDb}=require('../src/db'),db=getDb(),users=require('../src/repo/user.repo'),profiles=require('../src/repo/profile.repo'),security=require('../src/security');
const {chromium}=require('playwright');
function seed(id,role,name){const salt=security.genSalt();db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id,id,role,security.hashPassword('Test-only-2468',salt),salt,name,Date.now());return security.createSession(db,id);}
const tokens={sup:seed('sup','supervisor','林老师'),sub:seed('sub','supervisee','小李'),admin:seed('admin','admin','管理员')};
require('../src/repo/cooperation.repo').save(db,users.byId(db,'sup'),'admin',{state:'active',capacity:1,agreementRef:'ui-test-record',note:'UI测试授权',published:true});
profiles.save(db,'sup',{headline:'陪你把学习目标变成每天的行动',bio:'擅长英语学习习惯与时间管理。每个阶段一起复盘，找到适合你的节奏。',skills:['英语','时间管理'],serviceStyle:'每天晚间回复，次日上午确认打卡。',published:true,accepting:true});
const cert=profiles.submitCert(db,'sup','英语教学资格','示例颁发机构','演示审核材料');
const server=require('../server').start();
const output=path.join(__dirname,'..','output','playwright');fs.mkdirSync(output,{recursive:true});
(async()=>{
 let browser;
 try {
  if(!server.listening)await new Promise(r=>server.once('listening',r));
  browser=await chromium.launch({channel:'msedge',headless:true});
  const base='http://127.0.0.1:'+server.address().port;
  const errors=[];
  for(const role of ['sup','sub']) {
   const context=await browser.newContext({viewport:{width:390,height:844}});
   await context.addInitScript(t=>localStorage.setItem('sd_token',t),tokens[role]);
   const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://cdn.jsdelivr.net/**',r=>r.abort());await page.goto(base);
   await page.locator('.home-hero').waitFor(); await page.locator('.rank-card').waitFor(); await page.locator('#home-work #home-next').waitFor(); await page.locator('#refresh-work').click(); await page.locator('#home-work #home-next').waitFor(); assert.equal(await page.locator('.rank-card').count(),1); assert.equal(await page.locator('.home-hero').count(),1);
   await page.screenshot({path:path.join(output,role+'-home-new.png'),fullPage:true});
   await page.locator('#top-account').click();await page.locator('#my-avatar').click();
   const png=await page.screenshot();
   await page.locator('#avatar-file').setInputFiles({name:'avatar.png',mimeType:'image/png',buffer:png});
   await page.getByText('方形裁切预览 · 点击保存生效').waitFor();
   await page.locator('#modal-ok').click();await page.locator('#my-avatar img').waitFor();
   await page.reload();await page.locator('#my-avatar img').waitFor();
   assert.ok(db.prepare('SELECT avatar FROM users WHERE id=?').get(role).avatar.startsWith('data:image/jpeg;base64,'));
   await page.screenshot({path:path.join(output,role+'-my-new.png'),fullPage:true});
   await page.locator('#my-profile').click();await page.locator('.profile-hero img').waitFor();
   await page.locator('#profile-back').click();await page.locator('#my-logout').click();
   await page.screenshot({path:path.join(output,'logout-new.png'),fullPage:true});
   await page.locator('#modal-cancel').click();await page.locator('#my-avatar').waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.locator('#my-logout').click();await page.locator('#modal-ok').click();await page.locator('#li-btn').waitFor();
   await page.locator('#li-user').fill(role);await page.locator('#li-pass').fill('Test-only-2468');
await page.locator('#li-btn').click();await page.locator('#top-account').waitFor();
   await context.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.route('https://cdn.jsdelivr.net/**',r=>r.abort());await page.goto(base);await page.locator('#li-btn').waitFor();await page.screenshot({path:path.join(output,'login-new.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: both role homes, avatar upload/persistence/profile, logout cancel/confirm, login; no overflow or browser errors');
 } finally {if(browser)await browser.close();await new Promise(r=>server.close(r));closeDb();}
})().catch(e=>{console.error(e);process.exitCode=1;});

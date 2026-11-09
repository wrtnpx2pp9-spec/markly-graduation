/* 平台合作管理专用UI回归，使用临时数据库和浏览器上下文。 */
'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cooperation-ui-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';
const {getDb,closeDb}=require('../src/db'),db=getDb(),users=require('../src/repo/user.repo'),security=require('../src/security');
const {chromium}=require('playwright');
const accounts={};
for(const role of ['admin','supervisor','supervisee']){
  const salt=security.genSalt();const user=users.insert(db,{username:role,role,displayName:role==='supervisor'?'林老师':role==='admin'?'平台管理员':'小李',passwordHash:security.hashPassword('UI-only-123',salt),salt,createdAt:Date.now()});
  accounts[role]={user,token:security.createSession(db,user.id)};
}
const server=require('../server').start(),output=path.join(__dirname,'../output/playwright');fs.mkdirSync(output,{recursive:true});
(async()=>{let browser;
  try{
    if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
    browser=await chromium.launch({channel:'msedge',headless:true});const errors=[];
    const page=async(role,width=1100)=>{const ctx=await browser.newContext({viewport:{width,height:960}});await ctx.addInitScript(token=>localStorage.setItem('sd_token',token),accounts[role].token);const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.route('https://cdn.jsdelivr.net/**',r=>r.abort());await p.goto(base);await p.locator('#content').waitFor();return p;};
    const sup=await page('supervisor',390),admin=await page('admin'),sub=await page('supervisee',390),id=accounts.supervisor.user.id;
    await sup.locator('[data-view="my"]').click();await sup.locator('#my-authorization').getByText('待平台审核',{exact:false}).waitFor();await sup.locator('#my-edit').click();
    assert.equal(await sup.locator('#profile-published').count(),0);assert.equal(await sup.locator('#profile-accepting').count(),0);
    await sup.locator('#profile-headline').fill('平台英语学习监督');await sup.locator('#profile-skills').fill('英语');await sup.locator('#modal-ok').click();
    await admin.locator('[data-view="users"]').click();await admin.locator(`[data-adm="cooperation"][data-id="${id}"]`).click();
    await admin.locator('#coop-state').selectOption('active');await admin.locator('#coop-ref').fill('UI-AGREEMENT-001');await admin.locator('#coop-capacity').fill('3');await admin.locator('#coop-published').check();await admin.locator('#coop-note').fill('合作记录已核验，能力评估通过，平台分配3人');
    await admin.screenshot({path:path.join(output,'platform-cooperation-review.png'),fullPage:true});await admin.locator('#modal-ok').click();await admin.locator('#coop-state').waitFor({state:'detached'});
    assert.equal(users.supervisorCapacity(db,id),3);
    await sup.locator('[data-view="my"]').click();await sup.locator('#my-authorization').getByText('已启用服务',{exact:false}).waitFor();await sup.screenshot({path:path.join(output,'platform-supervisor-status.png'),fullPage:true});
    await sub.locator('[data-view="market"]').click();await sub.locator(`[data-person="${id}"]`).waitFor();
    await admin.locator(`[data-adm="cooperation"][data-id="${id}"]`).click();await admin.locator('#coop-state').selectOption('paused');await admin.locator('#coop-note').fill('平台暂停新增服务，安排现有服务交接');await admin.locator('#modal-ok').click();await admin.locator('#coop-state').waitFor({state:'detached'});
    await sub.locator('#market-form button[type="submit"]').click();await sub.locator('#market-count').getByText('暂无匹配的监督者').waitFor();assert.equal(await sub.locator(`[data-person="${id}"]`).count(),0);
    assert.equal(await sup.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
    console.log('UI PASS: 监督者无自助开通入口 → 平台核验授权3人 → 团队展示 → 平台暂停后移除；移动端无溢出、无页面错误');
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

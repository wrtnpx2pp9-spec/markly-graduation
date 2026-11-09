'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'markly-round3-ui-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';
const {getDb,closeDb}=require('../src/db'),db=getDb(),security=require('../src/security'),users=require('../src/repo/user.repo');
for(const [id,role] of [['sup','supervisor'],['sub','supervisee'],['sub2','supervisee'],['admin','admin']]){const salt=security.genSalt();db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id,id,role,security.hashPassword('Test-only-2468',salt),salt,id,Date.now());}
require('../src/repo/cooperation.repo').save(db,users.byId(db,'sup'),'admin',{state:'active',capacity:2,agreementRef:'test-only',note:'isolated browser test',published:false});users.setRelations(db,'sub',['sup']);users.setRelations(db,'sub2',['sup']);
const server=require('../server').start(),{launchBrowser}=require('./ui-browser.cjs');
const output=path.join(process.env.MARKLY_TEST_OUTPUT_DIR||path.join(__dirname,'..','output'),'round3-ui');fs.mkdirSync(output,{recursive:true});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
(async()=>{let browser;const pages=[];try{
  if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  browser=await launchBrowser();const errors=[];
  async function page(id){const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'});await context.addCookies([{name:'sd_session',value:security.createSession(db,id),url:base,httpOnly:true,sameSite:'Strict'}]);const p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.route('https://cdn.jsdelivr.net/**',r=>r.abort());await p.goto(base);await p.locator('#content').waitFor();return p;}
  const sup=await page('sup'),sub=await page('sub');
  await sup.evaluate(()=>api('POST','/api/plan-bundles',{planningMode:'rolling',assigneeId:'sub',title:'连续编辑验证',description:'测试节奏',cycles:[{title:'当前阶段',startDate:todayStrL(),endDate:goalShift(todayStrL(),13),rhythm:'每天安排'}]}));
  const root=db.prepare("SELECT id FROM plans WHERE kind='phase'").get(),stage=db.prepare('SELECT id FROM plans WHERE parent_id=?').get(root.id);
  await sub.evaluate(async id=>{await api('POST',`/api/plans/${id}/agreement`,{decision:'accept'});await loadSection();goView('tasks');},root.id);
  await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();await sub.locator('#daily-items').fill('原先保存的内容');
  const dailyArrived=deferred(),dailyRelease=deferred();
  await sub.route('**/api/plans/*/daily-proposals',async r=>{if(r.request().method()!=='POST')return r.continue();const response=await r.fetch();dailyArrived.resolve();await dailyRelease.promise;await r.fulfill({response});});
  await sub.locator('#modal-ok').click();await dailyArrived.promise;assert.equal(await sub.locator('#daily-items').isDisabled(),true);assert.equal(await sub.locator('#modal .dialog').getAttribute('aria-busy'),'true');
  await sub.locator('#modal-cancel').click();await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();await sub.locator('#daily-items').fill('重新打开后的新草稿');
  const dailyResponse=sub.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/daily-proposals'));dailyRelease.resolve();await dailyResponse;await sub.getByText(/的草稿已保存/).waitFor();
  assert.equal(await sub.locator('#daily-items').inputValue(),'重新打开后的新草稿');
  assert.ok(await sub.evaluate(()=>Object.keys(localStorage).some(key=>key.startsWith('daily-editor:')&&localStorage.getItem(key).includes('重新打开后的新草稿'))));await sub.unroute('**/api/plans/*/daily-proposals');
  // The reopened editor now explicitly reconciles its old local cache with the committed save.
  await sub.locator('#daily-conflict').waitFor({state:'visible'});
  await sub.waitForFunction(()=>!document.querySelector('#daily-keep-local').disabled);
  assert.match(await sub.locator('#daily-conflict-server').innerText(),/原先保存的内容/);
  await sub.locator('#daily-keep-local').click();
  assert.equal(await sub.locator('#daily-items').inputValue(),'重新打开后的新草稿');
  assert.match(db.prepare('SELECT payload_json FROM daily_plan_proposals').get().payload_json,/原先保存的内容/);
  await sub.route('**/api/plans/*/daily-proposals',r=>r.request().method()==='POST'?r.fulfill({status:503,contentType:'application/json',body:'{"error":"暂时无法保存"}'}):r.continue());
  await sub.locator('#modal-ok').click();await sub.getByText(/未保存，请重试/).waitFor();assert.equal(await sub.locator('#daily-items').isDisabled(),false);assert.equal(await sub.locator('#daily-items').inputValue(),'重新打开后的新草稿');
  await sub.unroute('**/api/plans/*/daily-proposals');await sub.locator('#modal-ok').click();await sub.locator('#daily-window').waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_plan_proposals').get().n,1);assert.match(db.prepare('SELECT payload_json FROM daily_plan_proposals').get().payload_json,/重新打开后的新草稿/);
  await sub.waitForFunction(()=>!document.querySelector('.toast'));await sub.screenshot({path:path.join(output,'daily-save-mobile.png'),animations:'disabled'});await sub.locator('#modal-ok').click();

  // The previous workspace's delayed save must not close or relabel a new workspace.
  await sup.evaluate(()=>openGoalWorkspace('sub'));await sup.getByText('已保存到服务器 · 本机已备份',{exact:true}).waitFor();
  const cloudArrived=deferred(),cloudRelease=deferred();let held=false;
  await sup.route('**/api/plan-drafts/*',async r=>{if(r.request().method()!=='PUT'||held)return r.continue();held=true;const response=await r.fetch();cloudArrived.resolve();await cloudRelease.promise;await r.fulfill({response});});
  await sup.locator('#goal-title').fill('正在保存的旧编辑器');await sup.locator('#modal-cancel').click();await cloudArrived.promise;await sup.keyboard.press('Escape');
  await sup.evaluate(()=>openGoalWorkspace('sub2'));await sup.locator('#goal-title').fill('新编辑器保留内容');await sup.getByText('已保存到服务器 · 本机已备份',{exact:true}).waitFor();
  const cloudResponse=sup.waitForResponse(r=>r.request().method()==='PUT'&&r.url().includes('/api/plan-drafts/'));cloudRelease.resolve();await cloudResponse;await sup.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await sup.locator('#goal-title').inputValue(),'新编辑器保留内容');assert.equal(await sup.locator('#goal-person').inputValue(),'sub2');await sup.unroute('**/api/plan-drafts/*');await sup.screenshot({path:path.join(output,'workspace-save-mobile.png'),animations:'disabled'});await sup.keyboard.press('Escape');

  // A successful write remains visible and clearly successful even if the subsequent GET fails.
  await sub.locator('[data-view="my"]').click();await sub.locator('#my-life').click();await sub.locator('#lf-content').waitFor();
  await sub.route('**/api/life?**',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"列表暂时不可用"}'}));
  await sub.locator('#lf-content').fill('落库成功但刷新失败');await sub.locator('#lf-add').click();await sub.getByText('记录已保存，列表暂时无法刷新；请稍后重新加载，无需重复提交。',{exact:true}).waitFor();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs').get().n,1);assert.equal(await sub.locator('.logcontent').innerText(),'落库成功但刷新失败');assert.equal(await sub.locator('#lf-content').inputValue(),'');
  sub.once('dialog',dialog=>dialog.accept());await sub.locator('[data-action="delLog"]').click();await sub.getByText('记录已删除，列表暂时无法刷新；请稍后重新加载。',{exact:true}).waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs').get().n,0);assert.equal(await sub.locator('.logitem').count(),0);
  await sub.unroute('**/api/life?**');assert.deepEqual(errors,[]);
  console.log('ROUND3 UI PASS: slow daily save locks inputs and preserves reopened drafts, failure retry keeps one draft, old workspace save cannot close a new editor, committed life save/delete survive refresh failure; no browser errors');
}catch(error){for(let i=0;i<pages.length;i++){console.error((await pages[i].locator('body').innerText()).slice(-6000));await pages[i].screenshot({path:path.join(output,'failure-'+i+'.png'),fullPage:true});}throw error;}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});

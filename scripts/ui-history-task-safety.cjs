'use strict';
// Real HTTP/mobile regression with isolated SQLite and iLink state.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'markly-history-task-ui-'));
process.env.DB_PATH=path.join(temp,'app.db');process.env.ILINK_STATE_DIR=path.join(temp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.MAINTENANCE_MODE='0';
const database=require('../src/db'),db=database.getDb(),users=require('../src/repo/user.repo'),security=require('../src/security'),tasks=require('../src/repo/task.repo');
const now=Date.now(),accounts={};
for(const role of ['admin','supervisor','supervisee'])accounts[role]=users.insert(db,{username:'safety-'+role,role,displayName:'边界测试-'+role,passwordHash:'test-only-unused',salt:'test-only-unused',createdAt:now});
const sup=accounts.supervisor,sub=accounts.supervisee;db.prepare("UPDATE users SET cooperation_state='active',agreement_ref='isolated-ui-authorization',capacity_override=2 WHERE id=?").run(sup.id);users.setRelations(db,sub.id,[sup.id]);
const taskIds={};
for(const action of ['checkin','uncheck','review','refresh'])taskIds[action]=tasks.insert(db,{title:'边界任务-'+action,note:'',creatorId:sup.id,assigneeId:sub.id,planId:null,dueAt:null,remindBeforeMinutes:30,status:['uncheck','review'].includes(action)?'submitted':'pending',createdAt:now}).id;
for(const [id,title] of [['history-a','历史目标 A'],['history-b','历史目标 B']])db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES (?,?,?,?,'phase','archived',?)").run(id,title,sub.id,sub.id,now-200*86400000);
const server=require('../server').start(),{launchBrowser}=require('./ui-browser.cjs');
const output=path.join(process.env.MARKLY_TEST_OUTPUT_DIR||path.join(__dirname,'..','output'),'history-task-safety-ui');fs.mkdirSync(output,{recursive:true});
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
(async()=>{let browser;const pages=[],releases=[],errors=[];try{
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
  browser=await launchBrowser();
  async function mobile(account){const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});await context.addCookies([{name:'sd_session',value:security.createSession(db,account.id),url:base,httpOnly:true,sameSite:'Strict'}]);const page=await context.newPage();pages.push(page);page.on('pageerror',error=>errors.push(error.message));await page.route('https://cdn.jsdelivr.net/**',route=>route.abort());await page.goto(base);await page.locator('#top-account').waitFor();return page;}
  const learner=await mobile(sub),leader=await mobile(sup);
  async function hold(page,routePath,method='GET',failure=false){
    const arrived=deferred(),release=deferred();releases.push(release);const pattern='**'+routePath;let writes=0;
    const handler=async route=>{if(route.request().method()!==method)return route.continue();writes++;const response=failure?null:await route.fetch();arrived.resolve();await release.promise;if(response)await route.fulfill({response});else await route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试旧读取失败"}'});};
    await page.route(pattern,handler);
    return {arrived:arrived.promise,count:()=>writes,async finish(){const received=page.waitForResponse(response=>response.url().endsWith(routePath)&&response.request().method()===method);release.resolve();await received;await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.unroute(pattern,handler);}};
  }
  await learner.locator('[data-view="my"]').tap();await learner.locator('#my-history').tap();await learner.locator('[data-history-plan="history-a"]').waitFor();
  const first=await hold(learner,'/api/cooperation-history/plans/history-a'),second=await hold(learner,'/api/cooperation-history/plans/history-b');
  await learner.locator('[data-history-plan="history-a"]').tap();await first.arrived;await learner.locator('[data-history-plan="history-b"]').tap();await second.arrived;
  await second.finish();await learner.locator('#modal-title').filter({hasText:'历史目标 B'}).waitFor();await first.finish();
  assert.equal(await learner.locator('#modal-title').innerText(),'历史目标 B','the latest chosen history record stays open');
  await learner.screenshot({path:path.join(output,'latest-history-mobile.png'),animations:'disabled'});await learner.locator('#modal-ok').tap();
  const stale=await hold(learner,'/api/cooperation-history/plans/history-a', 'GET',true);await learner.locator('[data-history-plan="history-a"]').tap();await stale.arrived;
  await learner.evaluate(()=>taskModal());await learner.locator('#tm-title').fill('历史读取期间新开的任务');await stale.finish();
  assert.equal(await learner.locator('#tm-title').inputValue(),'历史读取期间新开的任务');assert.equal(await learner.locator('.toast').filter({hasText:'测试旧读取失败'}).count(),0);
  await learner.keyboard.press('Escape');
  for(const action of ['checkin','uncheck','review']){
    const page=action==='review'?leader:learner,id=taskIds[action],routePath='/api/tasks/'+id+'/'+action;
    await page.evaluate(id=>openTask(id),id);await page.locator('#modal-title').filter({hasText:'边界任务-'+action}).waitFor();
    const pending=await hold(page,routePath,'POST');
    if(action==='checkin'){await page.locator('#task-submit').tap();await page.locator('#task-note').fill('真实接口提交内容');await page.locator('#modal-ok').tap();}
    else await page.locator(action==='review'?'#task-approve':'#task-withdraw').tap();
    await pending.arrived;await page.keyboard.press('Escape');await page.evaluate(()=>taskModal());await page.locator('#tm-title').fill('迟到-'+action+'期间的新输入');
    await pending.finish();assert.equal(await page.locator('#tm-title').inputValue(),'迟到-'+action+'期间的新输入');assert.equal(pending.count(),1);
    assert.equal(tasks.byId(db,id).status,({checkin:'submitted',uncheck:'pending',review:'done'})[action]);
    if(action==='checkin')assert.equal(tasks.byId(db,id).checkin_note,'真实接口提交内容');
    await page.screenshot({path:path.join(output,'late-'+action+'-mobile.png'),animations:'disabled'});await page.keyboard.press('Escape');
  }
  await learner.evaluate(id=>openTask(id),taskIds.refresh);await learner.locator('#task-submit').tap();await learner.locator('#task-note').fill('提交成功后读取失败');
  const readFailure=route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"测试列表不可用"}'});await learner.route('**/api/me/worklist',readFailure);
  await learner.locator('#modal-ok').tap();await learner.locator('.toast').filter({hasText:'无需重复提交'}).waitFor();assert.equal(tasks.byId(db,taskIds.refresh).status,'submitted');
  assert.equal(await learner.locator('#modal .dialog').count(),0);await learner.unroute('**/api/me/worklist',readFailure);
  await learner.evaluate(()=>{st.profileId=me.id;goView('profile');});await learner.locator('#profile-primary').waitFor();
  const profile=await hold(learner,'/api/profile/me');await learner.locator('#profile-primary').tap();await profile.arrived;await learner.evaluate(()=>goView('tasks'));await profile.finish();
  assert.equal(await learner.locator('#modal .dialog').count(),0,'a profile read cannot reopen after leaving its page');
  await learner.evaluate(()=>{st.profileId=me.id;goView('profile');});await learner.locator('#profile-primary').tap();await learner.locator('#profile-name').waitFor();await learner.keyboard.press('Escape');
  for(const page of pages)assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile width');
  assert.deepEqual(errors,[]);console.log('HISTORY/TASK SAFETY UI PASS: latest history details, quiet stale errors, three real delayed task writes preserve replacement forms, saved-write refresh failures, and stale/current profile edit reads; mobile width and browser errors checked.');
}catch(error){for(let index=0;index<pages.length;index++){console.error((await pages[index].locator('body').innerText()).slice(-5000));await pages[index].screenshot({path:path.join(output,'failure-'+index+'.png'),fullPage:true});}throw error;}
finally{releases.forEach(release=>release.resolve());if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await server.stopBackground();database.closeDb();const absolute=path.resolve(temp);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep),'cleanup stays in os.tmpdir');fs.rmSync(absolute,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});

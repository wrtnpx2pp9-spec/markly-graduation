'use strict';
// Real HTTP/browser regression, with isolated data and no external notification channels.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('node:assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'markly-async-ui-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';
const {getDb,closeDb}=require('../src/db'),db=getDb(),security=require('../src/security'),users=require('../src/repo/user.repo');
for(const [id,role] of [['admin','admin'],['sub','supervisee']]){const salt=security.genSalt();users.insert(db,{id,username:id,role,displayName:id,passwordHash:security.hashPassword('Test-only-2468',salt),salt,createdAt:Date.now()});}
const sub=users.byUsername(db,'sub'),now=Date.now(),old=now-180*86400000;
const notes=require('../src/repo/note.repo'),life=require('../src/repo/life.repo');
db.prepare("INSERT INTO tasks(id,title,creator_id,assignee_id,status,created_at,done_at) VALUES ('old-task','半年前已完成任务',?,?,'done',?,?)").run(sub.id,sub.id,old,old);
db.prepare("INSERT INTO plans(id,title,creator_id,assignee_id,kind,status,created_at) VALUES ('old-plan','半年前归档目标',?,?,'phase','archived',?)").run(sub.id,sub.id,old);
const taskNote=notes.insert(db,{userId:sub.id,kind:'task_done',title:'旧任务消息',linkType:'task',linkId:'old-task',createdAt:old});
notes.insert(db,{userId:sub.id,kind:'plan_update',title:'旧目标消息',linkType:'plan',linkId:'old-plan',createdAt:old+1});
for(let i=0;i<103;i++)notes.insert(db,{userId:sub.id,kind:'test',title:'通知 '+i,createdAt:now-i*1000});
for(let i=0;i<105;i++)life.insert(db,{userId:sub.id,date:'2026-01-01',content:'生活记录 '+i,mood:'',createdAt:now-i*1000});
const server=require('../server').start(),{launchBrowser}=require('./ui-browser.cjs');
const output=path.join(process.env.MARKLY_TEST_OUTPUT_DIR||path.join(__dirname,'..','output'),'async-ui');fs.mkdirSync(output,{recursive:true});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
(async()=>{let browser,p;try{
  if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  browser=await launchBrowser();const context=await browser.newContext({viewport:{width:390,height:900},serviceWorkers:'block'});
  await context.addCookies([{name:'sd_session',value:security.createSession(db,sub.id),url:base,httpOnly:true,sameSite:'Strict'}]);
  p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));await p.route('https://cdn.jsdelivr.net/**',r=>r.abort());
  await p.goto(base);await p.locator('#top-notes').click();await p.locator('#notes-more').waitFor();
  assert.equal(await p.locator('.note').count(),100);await p.locator('#notes-more').click();await p.locator('#notes-more').waitFor({state:'detached'});assert.equal(await p.locator('.note').count(),105);
  await p.evaluate(async()=>{await pollNotifications();renderView();});assert.equal(await p.locator('.note').count(),105,'compact polling preserves older loaded messages');
  await p.locator(`[data-note-read="${taskNote}"]`).click();await p.locator(`[data-note-read="${taskNote}"]`).waitFor({state:'detached'});assert.equal(db.prepare('SELECT is_read FROM notifications WHERE id=?').get(taskNote).is_read,1);
  assert.equal(await p.evaluate(()=>unread),104);assert.equal(db.prepare("SELECT status FROM tasks WHERE id='old-task'").get().status,'done','reading a message never changes execution status');
  await p.route('**/api/notifications/read',r=>r.fulfill({status:503,contentType:'application/json',body:'{"error":"临时不可用"}'}));
  await p.locator('#notif-read').click();await p.waitForFunction(()=>!document.getElementById('notif-read').disabled);
  assert.equal(await p.locator('#notif-read').innerText(),'全部已读');assert.equal(await p.evaluate(()=>unread),104);
  await p.unroute('**/api/notifications/read');
  const arrived=deferred(),release=deferred();
  await p.route('**/api/tasks/old-task',async r=>{const response=await r.fetch();arrived.resolve();await release.promise;await r.fulfill({response});});
  await p.locator('[data-note-id="old-task"]').click();await arrived.promise;await p.evaluate(()=>window.scrollTo(0,0));await p.waitForFunction(()=>!document.body.classList.contains('tabbar-collapsed'));await p.locator('[data-view="my"]').click();
  const received=p.waitForResponse(r=>r.url().endsWith('/api/tasks/old-task'));release.resolve();await received;await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  assert.equal(await p.locator('#modal .dialog').count(),0,'late task details do not reopen after leaving notifications');await p.unroute('**/api/tasks/old-task');
  await p.locator('#top-notes').click();await p.locator('#notes-more').click();await p.locator('[data-note-id="old-task"]').click();await p.getByRole('heading',{name:'半年前已完成任务',exact:true}).waitFor();await p.locator('#modal-ok').click();
  await p.locator('[data-note-id="old-plan"]').click();await p.locator('.history-records').waitFor();assert.ok((await p.locator('.history-records').innerText()).includes('半年前归档目标'));await p.locator('#modal-ok').click();
  await p.locator('#notif-read').click();await p.waitForFunction(()=>unread===0);assert.equal(db.prepare('SELECT COUNT(*) n FROM notifications WHERE is_read=0').get().n,0);
  await p.waitForFunction(()=>!document.querySelector('.toast'));await p.screenshot({path:path.join(output,'messages-mobile.png'),fullPage:false,animations:'disabled'});
  await p.evaluate(()=>window.scrollTo(0,0));await p.waitForFunction(()=>!document.body.classList.contains('tabbar-collapsed'));await p.locator('[data-view="my"]').click();await p.locator('#my-life').click();await p.locator('#life-more').waitFor();assert.equal(await p.locator('.logitem').count(),100);
  await p.locator('#lf-content').fill('翻页、切换和刷新都保留的未提交记录');await p.locator('#life-more').click();await p.locator('#life-more').waitFor({state:'detached'});assert.equal(await p.locator('.logitem').count(),105);assert.equal(await p.locator('#lf-content').inputValue(),'翻页、切换和刷新都保留的未提交记录');
  await p.evaluate(()=>window.scrollTo(0,0));await p.waitForFunction(()=>!document.body.classList.contains('tabbar-collapsed'));await p.locator('[data-view="my"]').click();await p.locator('#my-life').click();await p.locator('#life-more').waitFor();await p.reload();await p.locator('#life-more').waitFor();assert.equal(await p.locator('#lf-content').inputValue(),'翻页、切换和刷新都保留的未提交记录');
  await p.locator('#lf-add').click();await p.waitForFunction(()=>document.getElementById('lf-content').value==='');assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs').get().n,106);
  const saving=deferred(),finishSave=deferred();
  await p.route('**/api/life',async r=>{if(r.request().method()!=='POST')return r.continue();const response=await r.fetch();saving.resolve();await finishSave.promise;await r.fulfill({response});});
  await p.locator('#lf-content').fill('慢提交切页后仍只保存一次');await p.locator('#lf-add').click();await saving.promise;
  await p.evaluate(()=>window.scrollTo(0,0));await p.waitForFunction(()=>!document.body.classList.contains('tabbar-collapsed'));await p.locator('[data-view="my"]').click();
  const saved=p.waitForResponse(r=>r.url().endsWith('/api/life')&&r.request().method()==='POST');finishSave.resolve();await saved;
  await p.getByText('已保存',{exact:true}).waitFor();assert.equal(await p.evaluate(()=>st.view),'my');assert.equal(db.prepare('SELECT COUNT(*) n FROM life_logs').get().n,107);
  await p.unroute('**/api/life');await p.locator('#my-life').click();await p.locator('#life-more').waitFor();assert.equal(await p.locator('#lf-content').inputValue(),'');
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await p.waitForFunction(()=>!document.querySelector('.toast'));await p.screenshot({path:path.join(output,'life-mobile.png'),fullPage:false,animations:'disabled'});
  assert.deepEqual(errors,[]);console.log('ASYNC UI PASS: paginated notifications/life, compact poll retention, single/all read and retry, late-detail cancellation, old task/plan deep links, draft persistence and save; no browser errors');
}catch(error){if(p){console.error(await p.locator('body').innerText());await p.screenshot({path:path.join(output,'failure.png'),fullPage:true});}throw error;}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});

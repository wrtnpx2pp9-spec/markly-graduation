'use strict';
// New-user entry and accepted-request continuity, using isolated local fixtures only.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'markly-product-entry-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';process.env.MAINTENANCE_MODE='0';
const {getDb,closeDb}=require('../src/db'),db=getDb(),security=require('../src/security'),users=require('../src/repo/user.repo'),profiles=require('../src/repo/profile.repo');
for(const [id,role,name] of [['sup','supervisor','林老师'],['sub','supervisee','小李'],['new-sup','supervisor','新老师'],['admin','admin','管理员']]){
  const salt=security.genSalt();db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES(?,?,?,?,?,?,1,?)').run(id,id,role,security.hashPassword('Test-only-2468',salt),salt,name,Date.now());
}
require('../src/repo/cooperation.repo').save(db,users.byId(db,'sup'),'admin',{state:'active',capacity:2,agreementRef:'product-ui-test',note:'isolated fixture',published:true});
profiles.save(db,'sup',{headline:'一起培养阅读习惯',bio:'从一个小目标开始',skills:['阅读'],serviceStyle:'每晚简短反馈',published:true,accepting:true});
const server=require('../server').start(),{launchBrowser}=require('./ui-browser.cjs');
const output=path.join(process.env.MARKLY_TEST_OUTPUT_DIR||path.join(__dirname,'..','output'),'product-entry-ui');fs.mkdirSync(output,{recursive:true});
const pages=[];
(async()=>{let browser;
try{
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;browser=await launchBrowser();const errors=[];
  async function page(id){const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});await context.addCookies([{name:'sd_session',value:security.createSession(db,id),url:base,httpOnly:true,sameSite:'Strict'}]);const p=await context.newPage();pages.push(p);p.on('pageerror',e=>errors.push(e.message));await p.route('https://cdn.jsdelivr.net/**',r=>r.abort());await p.goto(base);await p.locator('[data-work-empty]').waitFor();return p;}
  async function home(p){await p.locator('[data-view="dashboard"]').click();await p.locator('[data-work-count="mine"]').waitFor();}
  async function swipeUp(p, selector, edge=false){
    const box=await p.locator(selector).boundingBox(),session=await p.context().newCDPSession(p);
    const x=edge?box.x+8:box.x+box.width/2,start=box.y+box.height-32,end=box.y+32;
    try{
      await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:start}]});
      for(let i=1;i<=12;i++){
        await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start+(end-start)*i/12}]});
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }finally{await session.detach();}
  }
  const unobstructed=el=>{const r=el.getBoundingClientRect();return r.height>=44&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));};
  const sub=await page('sub'),sup=await page('sup'),newSup=await page('new-sup');
  const account=await sub.locator('#top-account').boundingBox();assert.ok(account.width>=44&&account.height>=44,'mobile account target is at least 44x44');
  await sub.locator('#top-account').tap();await sub.locator('#my-profile').waitFor();await home(sub);
  await newSup.locator('[data-home-next="my"]').click();await newSup.locator('#my-cert').waitFor();
  await newSup.waitForFunction(()=>!!document.querySelector('#my-authorization')?.textContent);
  await newSup.screenshot({path:path.join(output,'service-preparation-mobile.png'),fullPage:true,animations:'disabled'});
  await sub.screenshot({path:path.join(output,'first-visit-mobile.png'),fullPage:true,animations:'disabled'});
  // The visible first step reaches a real profile, then a real cooperation request.
  await sub.locator('[data-home-next="market"]').click();await sub.locator('[data-person="sup"]').click();
  assert.equal(await sub.locator('.profile-headline').innerText(),'一起培养阅读习惯','profile shows the chosen partner’s information');
  assert.equal(await sub.locator('#profile-primary').isEnabled(),true);
  await sub.screenshot({path:path.join(output,'partner-profile-mobile.png'),fullPage:true,animations:'disabled'});
  await sub.locator('#profile-primary').click();await sub.locator('#start-quick').click();
  await sub.locator('#quick-goal').fill('每天阅读十分钟');await sub.locator('#modal-ok').click();await sub.locator('#request-message').waitFor();
  const request=db.prepare('SELECT id,status,goal FROM service_requests WHERE supervisee_id=?').get('sub');assert.ok(request);
  assert.equal(request.status,'discussing');assert.equal(request.goal,'每天阅读十分钟');
  await home(sup);await sup.locator(`[data-request="${request.id}"]`).click();await sup.locator('#request-confirm').click();await sup.locator('#request-plan').waitFor();
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(request.id).status,'planning');
  await home(sup);await sup.locator(`[data-request="${request.id}"]`).waitFor();assert.equal(await sup.locator('[data-work-count="mine"] b').innerText(),'1');assert.equal(await sup.locator('[data-work-empty]').count(),0);
  await home(sub);await sub.locator(`[data-request="${request.id}"]`).waitFor();assert.equal(await sub.locator('[data-work-count="waiting"] b').innerText(),'1');assert.match(await sub.locator('[data-home-work-status]').innerText(),/正在制定计划/);
  await sup.screenshot({path:path.join(output,'planning-request-mobile.png'),fullPage:true,animations:'disabled'});
  await sup.locator(`[data-request="${request.id}"]`).click();await sup.locator('#request-plan').click();await sup.locator('#rolling-title').fill('建立阅读习惯');await sup.locator('#rolling-rhythm').fill('每周四次，每次十分钟');await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
  const first=db.prepare("SELECT id,status,title FROM plans WHERE kind='phase' ORDER BY created_at DESC").get();
  assert.equal(first.status,'proposed');assert.equal(first.title,'建立阅读习惯');
  await home(sub);await sub.locator(`[data-agreement="${first.id}"]`).click();await sub.locator('#rolling-decline').click();await sub.locator('#rolling-note').fill('先从每周两次开始');await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(first.id).status,'declined');
  assert.equal(db.prepare('SELECT status FROM service_requests WHERE id=?').get(request.id).status,'planning','adjustment returns the same request to planning');
  await home(sup);await sup.locator(`[data-request="${request.id}"]`).click();await sup.locator('#request-plan').click();await sup.locator('#rolling-title').fill('建立阅读习惯，轻量开始');await sup.locator('#rolling-rhythm').fill('每周两次，每次十分钟');await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
  const second=db.prepare("SELECT id FROM plans WHERE kind='phase' AND status='proposed'").get();
  assert.notEqual(second.id,first.id,'revision preserves the earlier plan');
  await home(sub);await sub.locator(`[data-agreement="${second.id}"]`).click();await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});await sub.locator('[data-home-next="tasks"]').waitFor();
  assert.equal(await sub.locator(`[data-request="${request.id}"]`).count(),0,'accepted request no longer asks for a next step');
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(second.id).status,'active');
  assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(first.id).status,'declined','accepting the revision keeps the original result');
  const accepted=db.prepare('SELECT status,plan_id FROM service_requests WHERE id=?').get(request.id);
  assert.equal(accepted.status,'accepted');assert.equal(accepted.plan_id,second.id);
  await sub.screenshot({path:path.join(output,'home-mobile-first.png'),animations:'disabled'});
  await sub.locator('[data-home-next="tasks"]').tap();await sub.locator(`[data-phase="${second.id}"] [data-daily-plan]`).waitFor();
  await sub.screenshot({path:path.join(output,'goals-mobile-first.png'),animations:'disabled'});
  await sub.locator(`[data-phase="${second.id}"] [data-daily-plan]`).tap();
  await sub.setViewportSize({width:320,height:568});await sub.locator('#daily-window').tap();
  await sub.waitForFunction(()=>document.querySelectorAll('[data-daily-edit]').length===14);
  const backgroundY=await sub.evaluate(()=>window.scrollY),lastDate=await sub.locator('[data-daily-edit]').last().getAttribute('data-daily-edit');
  for(let i=0;i<9&&!await sub.locator('[data-daily-edit]').last().evaluate(unobstructed);i++)await swipeUp(sub,'.daily-planner-body');
  assert.equal(await sub.locator('[data-daily-edit]').last().evaluate(unobstructed),true,'touch scrolling reaches the last of fourteen dates on a short phone');
  const plannerOffset=await sub.locator('.daily-planner-body').evaluate(el=>el.scrollTop);assert.ok(plannerOffset>0,'the planner body scrolled with touch');
  assert.equal(await sub.evaluate(()=>window.scrollY),backgroundY,'planner touch scrolling does not move the background');
  assert.equal(await sub.locator('#modal-ok').evaluate(unobstructed),true,'planner close remains reachable after scrolling');
  await sub.screenshot({path:path.join(output,'daily-planner-320x568.png'),animations:'disabled'});
  await sub.locator('[data-daily-edit]').last().tap();await sub.locator('#daily-items').waitFor();
  assert.match(await sub.locator('#modal-title').innerText(),new RegExp(lastDate),'the last date opens the matching editor');
  assert.equal(await sub.locator('#daily-items').isEditable(),true,'accepted plan reaches an editable daily form through visible controls');
  for(const width of [320,390]){
    await sub.setViewportSize({width,height:900});
    const checkbox=await sub.locator('#daily-rest').boundingBox();
    assert.ok(checkbox.width<=28&&checkbox.height<=28,'rest checkbox remains a compact control at '+width+'px');
    assert.equal(await sub.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'daily form fits '+width+'px');
  }
  await sub.locator('label.form-check:has(#daily-rest)').click();
  assert.equal(await sub.locator('#daily-rest').isChecked(),true);assert.equal(await sub.locator('#daily-items').isDisabled(),true,'rest suspends task input');
  await sub.locator('#daily-rest').focus();await sub.keyboard.press('Space');
  assert.equal(await sub.locator('#daily-rest').isChecked(),false);assert.equal(await sub.locator('#daily-items').isEditable(),true,'keyboard restores task input');
  await sub.locator('#daily-items').fill('每天阅读十分钟');
  const dailyActions=sub.locator('#modal .dlg-actions');
  assert.equal(await dailyActions.locator('#daily-save-submit').count(),1,'daily submit is in the action footer');
  assert.equal(await dailyActions.locator('#modal-ok.soft').count(),1,'save draft is secondary in the same footer');
  assert.equal(await dailyActions.locator('.btn:not(.soft):visible').count(),1,'daily editor has one primary action');
  for(const [width,height] of [[320,568],[390,640],[390,400]]){
    await sub.setViewportSize({width,height});
    await sub.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const editorBackgroundY=await sub.evaluate(()=>window.scrollY);
    await swipeUp(sub,'#modal .dialog',true);
    for(const selector of ['#modal-ok','#daily-save-submit'])assert.equal(await sub.locator(selector).evaluate(unobstructed),true,'touch-scrolled daily footer stays reachable at '+width+'x'+height);
    assert.equal(await sub.evaluate(()=>window.scrollY),editorBackgroundY,'editing scroll does not move the background');
    await sub.locator('#daily-reason').focus();
    assert.equal(await sub.locator('#daily-reason').evaluate(el=>el.getBoundingClientRect().bottom<=document.querySelector('.daily-editor-actions').getBoundingClientRect().top+1),true,'the last field can scroll above footer at '+width+'x'+height);
    await sub.screenshot({path:path.join(output,'daily-editor-'+width+'x'+height+'.png'),animations:'disabled'});
  }
  for(const width of [320,390]){
    await sub.setViewportSize({width,height:900});await dailyActions.scrollIntoViewIfNeeded();
    for(const selector of ['#modal-ok','#daily-save-submit'])assert.equal(await sub.locator(selector).evaluate(el=>{
      const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    }),true,'daily footer action is visible and unobstructed at '+width+'px: '+selector);
  }
  await sub.screenshot({path:path.join(output,'daily-form-mobile.png'),fullPage:true,animations:'disabled'});
  let dailyWrites=0,releaseDaily,dailyStarted;
  const dailyGate=new Promise(resolve=>{releaseDaily=resolve;});
  const firstDailyWrite=new Promise(resolve=>{dailyStarted=resolve;});
  await sub.route('**/api/plans/*/daily-proposals',async route=>{if(route.request().method()==='POST'){dailyWrites++;dailyStarted();await dailyGate;}await route.continue();});
  await sub.locator('#daily-save-submit').dblclick();
  await firstDailyWrite;
  await sub.waitForFunction(()=>document.querySelector('#daily-save-submit')?.disabled);
  await sub.keyboard.press('Enter');
  assert.equal(await sub.locator('#modal-ok').isDisabled(),true,'draft cannot race a pending submission');
  assert.equal(await sub.locator('#daily-save-submit').getAttribute('aria-busy'),'true');
  assert.match(await sub.locator('#daily-save-submit').innerText(),/正在|提交中/,'the visible footer explains the pending submission');
  assert.match(await sub.locator('#daily-progress').innerText(),/正在保存并提交/);
  assert.equal(dailyWrites,1,'double-click and repeated Enter save only once');
  await sub.screenshot({path:path.join(output,'daily-submitting-mobile.png'),fullPage:true,animations:'disabled'});
  releaseDaily();await sub.locator('[data-daily-action="withdraw"]').waitFor();
  await sub.unroute('**/api/plans/*/daily-proposals');
  const proposals=db.prepare('SELECT status,payload_json FROM daily_plan_proposals WHERE proposer_id=?').all('sub');
  assert.equal(proposals.length,1,'one daily proposal is persisted');assert.equal(proposals[0].status,'submitted');
  assert.equal(JSON.parse(proposals[0].payload_json).items[0].title,'每天阅读十分钟');
  const closingOffset=await sub.locator('.daily-planner-body').evaluate(el=>{
    el.scrollTop=el.scrollHeight;
    document.addEventListener('click',function captureClose(){
      document.removeEventListener('click',captureClose);
      window.dailyExitOffset=document.querySelector('.overlay.is-leaving .daily-planner-body')?.scrollTop;
    });
    return el.scrollTop;
  });
  await sub.locator('#modal-ok').tap();
  assert.ok(Math.abs((await sub.evaluate(()=>window.dailyExitOffset))-closingOffset)<=1,'closing preserves the internal scrolling position in the exit image');
  // Old cancelled/archived work must not depress the current confirmation rate.
  const plans=require('../src/repo/plan.repo'),tasks=require('../src/repo/task.repo');
  const archived=plans.insert(db,{title:'归档历史',description:'独立测试记录',kind:'task',status:'archived',creatorId:'sup',assigneeId:'sub',startAt:null,dueAt:null,createdAt:Date.now()});
  for(const [title,status,planId] of [['已确认任务','done',null],['取消任务','cancelled',null],['归档未完成','pending',archived.id],['待确认任务','submitted',null]])tasks.insert(db,{title,note:'独立测试记录',status,planId,dueAt:null,remindBeforeMinutes:30,creatorId:'sup',assigneeId:'sub',createdAt:Date.now()});
  await sub.reload();await home(sub);assert.equal(await sub.locator('.arcval b').innerText(),'50%');assert.match(await sub.locator('.hr-txt').innerText(),/1\s*\/\s*2 已确认/);
  await sub.waitForFunction(()=>Math.abs(parseFloat(getComputedStyle(document.querySelector('[data-home-progress]')).strokeDasharray)-50)<0.1);
  const submitted=db.prepare("SELECT id FROM tasks WHERE title='待确认任务'").get();
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(submitted.id);
  // Exercise the production background read path against real isolated data,
  // observing rendered animation values rather than matching source code.
  const progressMotion=await sub.evaluate(async()=>{
    const content=document.querySelector('#content'),samples=[];let pageStarts=0;
    const onStart=event=>{if(event.target===content)pageStarts++;};content.addEventListener('animationstart',onStart);
    await reloadNetworkView();
    const ring=document.querySelector('[data-home-progress]'),started=performance.now();
    await new Promise(resolve=>{function sample(){samples.push(parseFloat(getComputedStyle(ring).strokeDasharray));if(performance.now()-started<700)requestAnimationFrame(sample);else resolve();}sample();});
    content.removeEventListener('animationstart',onStart);
    return {samples,pageStarts,label:document.querySelector('.arcval b').textContent};
  });
  assert.equal(progressMotion.label,'100%');assert.equal(progressMotion.pageStarts,0,'a background refresh does not replay the whole page entrance');
  assert.ok(Math.abs(progressMotion.samples[0]-50)<0.1,'progress starts from the previous confirmed value');
  assert.ok(progressMotion.samples.some(value=>value>50.5&&value<99.5),'progress renders intermediate values');
  assert.ok(Math.abs(progressMotion.samples.at(-1)-100)<0.1,'progress ends at the real new confirmation rate');
  console.log('PROGRESS MOTION',JSON.stringify({from:progressMotion.samples[0],intermediate:progressMotion.samples.find(value=>value>50.5&&value<99.5),to:progressMotion.samples.at(-1),frames:progressMotion.samples.length,pageEntrances:progressMotion.pageStarts}));
  await sub.emulateMedia({reducedMotion:'reduce'});
  db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").run(submitted.id);
  await sub.evaluate(()=>reloadNetworkView());
  assert.equal(await sub.locator('.arcval b').innerText(),'50%','submission alone remains unconfirmed');
  assert.equal(await sub.locator('[data-home-progress]').evaluate(el=>parseFloat(getComputedStyle(el).strokeDasharray)),50,'reduced motion updates progress immediately');
  await sub.emulateMedia({reducedMotion:'no-preference'});
  await sub.locator('[data-view="tasks"]').click();await sub.locator(`[data-phase="${second.id}"]`).waitFor();
  await home(sub);
  const returnedProgress=await sub.locator('[data-home-progress]').evaluate(el=>parseFloat(getComputedStyle(el).strokeDasharray));
  assert.equal(returnedProgress,50,'returning to the page shows current progress without restarting from zero');
  for(const p of [sub,sup,newSup])assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no mobile horizontal overflow');
  await sub.locator('.home-ringcard').scrollIntoViewIfNeeded();
  await sub.screenshot({path:path.join(output,'current-confirmation-mobile.png'),animations:'disabled'});
  assert.deepEqual(errors,[]);console.log('PRODUCT ENTRY UI PASS: first-visit next step, supervisor preparation, profile → request → handoff → homepage resume → decline → revised plan → accept → daily planner; mobile touch reaches date 14 at 320x568, 44x44 account target, short 320x568/390x640 and reduced 390x400 viewport footer and last field reachable without background scrolling, exit image preserves body scroll; one primary daily submit with secondary draft, visible busy feedback and deduplication; cancelled/archived exclusions and submitted confirmation rate, background-refresh progress interpolation and reduced motion; mobile overflow and page errors checked');
}catch(error){for(let i=0;i<pages.length;i++){console.error('FAILED PAGE',i,(await pages[i].locator('body').innerText()).slice(-5000));await pages[i].screenshot({path:path.join(output,`failure-${i}.png`),fullPage:true});}throw error;}
finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

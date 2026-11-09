/* 可重复的浏览器回归：独立临时数据库，不访问真实业务数据。
   运行 npm run test:ui；使用本机 Microsoft Edge，无真实业务数据 */
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'desk-ui-'));
process.env.DB_PATH=path.join(tmp,'app.db');process.env.ILINK_STATE_DIR=path.join(tmp,'ilink');process.env.PORT='0';process.env.HOST='127.0.0.1';
const {getDb,closeDb}=require('../src/db'),db=getDb(),users=require('../src/repo/user.repo'),profiles=require('../src/repo/profile.repo'),security=require('../src/security');
const {launchBrowser}=require('./ui-browser.cjs');
function seed(id,role,name){const salt=security.genSalt();db.prepare('INSERT INTO users(id,username,role,password_hash,salt,display_name,status,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id,id,role,security.hashPassword('Test-only-2468',salt),salt,name,Date.now());}
seed('sup','supervisor','林老师');seed('sub','supervisee','小李');seed('admin','admin','管理员');
require('../src/repo/cooperation.repo').save(db,users.byId(db,'sup'),'admin',{state:'active',capacity:1,agreementRef:'ui-test-record',note:'UI测试授权',published:true});
profiles.save(db,'sup',{headline:'陪你把学习目标变成每天的行动',bio:'擅长英语学习习惯与时间管理。每个阶段一起复盘，找到适合你的节奏。',skills:['英语','时间管理'],serviceStyle:'每天晚间回复，次日上午确认打卡。',published:true,publicVisible:false,accepting:true});
const cert=profiles.submitCert(db,'sup','英语教学资格','示例颁发机构','演示审核材料');
users.setRelations(db,'sub',['sup']);
const server=require('../server').start();
const output=path.join(process.env.MARKLY_TEST_OUTPUT_DIR||path.join(__dirname,'..','output'),'playwright');fs.mkdirSync(output,{recursive:true});
(async()=>{
  let browser;
  try{
    if(!server.listening)await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
    browser=await launchBrowser();
    const errors=[];
    async function page(role,width=1100){const context=await browser.newContext({viewport:{width,height:900}});const p=await context.newPage();p.on('pageerror',e=>errors.push(e.message));await p.route('https://cdn.jsdelivr.net/**',r=>r.abort());await p.goto(base);await p.locator('#li-user').fill(role);await p.locator('#li-pass').fill('Test-only-2468');await p.locator('#li-btn').click();await p.locator('#content').waitFor();assert.equal(await p.evaluate(()=>localStorage.getItem('sd_token')),null);assert.ok((await context.cookies()).some(c=>c.name==='sd_session'&&c.httpOnly));return p;}
    const sub=await page('sub',390),sup=await page('sup'),admin=await page('admin');
    await sup.locator('[data-view="tasks"]').click();await sup.locator('#supervisor-new-goal').click();
    await sup.locator('#rolling-title').fill('三个月学习方向');await sup.locator('#rolling-rhythm').fill('每周四次，提前三天安排');await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
    const root=db.prepare("SELECT * FROM plans WHERE kind='phase'").get(),stage=db.prepare('SELECT * FROM plans WHERE parent_id=?').get(root.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_days').get().n,0);
    await sub.locator('[data-view="tasks"]').click();
    await sub.evaluate(id=>agreementModal(id),root.id);await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();
    await sub.locator('#daily-items').fill('阅读十分钟\n复习20词');
    // Read retry refreshes visible data while preserving the open editor and never replaying writes.
    db.prepare('UPDATE plans SET title=? WHERE id=?').run('三个月学习方向（网络恢复）',root.id);
    await sub.route('**/api/plans?**',r=>r.abort());
    await sub.evaluate(()=>loadSection().catch(()=>{}));
    await sub.locator('#network-status .network-retry').waitFor();
    await sub.evaluate(()=>api('GET','/api/auth/me'));
    assert.equal(await sub.locator('#network-status').isVisible(),true,'unrelated successful reads do not hide the failed refresh');
    await sub.unroute('**/api/plans?**');
    const replayed=[];const recordWrite=req=>{if(['POST','PUT','PATCH','DELETE'].includes(req.method()))replayed.push(req.url());};
    sub.on('request',recordWrite);
    await sub.locator('#network-status .network-retry').click();await sub.locator('#network-status').waitFor({state:'hidden'});
    sub.off('request',recordWrite);assert.deepEqual(replayed,[]);
    assert.equal(await sub.locator('#daily-items').inputValue(),'阅读十分钟\n复习20词');
    assert.ok((await sub.locator('#content').innerText()).includes('三个月学习方向（网络恢复）'));
    await sub.locator('#modal-cancel').click();
    await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();
    assert.equal(await sub.locator('#daily-items').inputValue(),'阅读十分钟\n复习20词');
    await sub.locator('#modal-ok').click();await sub.locator('[data-daily-edit]').first().click();
    assert.equal(await sub.locator('#daily-items').inputValue(),'阅读十分钟\n复习20词');
    await sub.locator('#modal-ok').click();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_plan_proposals').get().n,1);
    await sub.locator('[data-daily-edit]').nth(1).click();
    assert.equal(await sub.locator('#daily-items').inputValue(),'阅读十分钟\n复习20词');
    await sub.locator('#modal-cancel').click();
    await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();
    await sub.locator('#daily-save-submit').click();
    await sub.locator('[data-daily-action="withdraw"]').waitFor();assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_days').get().n,0);
    await sup.reload();await sup.locator(`[data-daily-plan="${stage.id}"]`).click();await sup.locator('[data-daily-action="accept"]').click();await sup.getByText('已确认生效',{exact:false}).waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_days').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items WHERE removed_at IS NULL').get().n,2);
    await sup.locator('[data-daily-edit]').first().click();await sup.locator('#daily-items').fill('阅读十分钟\n复习10词\n听力五分钟');await sup.locator('#daily-reason').fill('减少单词量，增加听力');await sup.locator('#daily-save-submit').click();await sup.locator('[data-daily-action="withdraw"]').waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items WHERE removed_at IS NULL').get().n,2);
    await sub.reload();await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-action="accept"]').click();await sub.locator('[data-daily-action="accept"]').waitFor({state:'detached'});
    assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items WHERE removed_at IS NULL').get().n,3);assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_day_items WHERE removed_at IS NOT NULL').get().n,1);
    await sub.locator('#daily-window').waitFor();await sub.locator('#modal .dialog').evaluate(async el=>{await Promise.all(el.getAnimations({subtree:true}).map(a=>a.finished.catch(()=>{})));});await sub.screenshot({path:path.join(output,'rolling-daily-mobile.png'),fullPage:true});assert.equal(await sub.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const heading=await sub.locator('#modal-title').boundingBox();
    assert.ok(heading.y>=0&&heading.y+heading.height<=900,'daily planner opens at its heading rather than skipping to the footer');
    await sub.locator('#modal-ok').click();await sub.locator('[data-view="dashboard"]').click();
    await sub.locator('[data-day-open]').first().click();
    await sub.locator('[data-detail-item]').first().waitFor();
    assert.equal(await sub.locator('[data-detail-item]').count(),3);
    for(let i=0;i<3;i++){await sub.locator('[data-detail-item]').nth(i).click();await sub.locator('[data-detail-item][aria-checked="true"]').nth(i).waitFor();}
    // Saving an adjustment draft omits item status; the editor must still use
    // the execution record when the persisted draft is opened again.
    await sub.locator('#modal-ok').click();await sub.evaluate(()=>window.scrollTo(0,0));await sub.locator('[data-view="tasks"]').click();
    await sub.locator(`[data-daily-plan="${stage.id}"]`).click();await sub.locator('[data-daily-edit]').first().click();
    await sub.locator('#daily-completed-note').waitFor();await sub.locator('#modal-ok').click();
    await sub.locator('[data-daily-draft]').click();await sub.locator('#daily-completed-note').waitFor();
    assert.equal(await sub.locator('#daily-items').inputValue(),'阅读十分钟\n复习10词\n听力五分钟');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM plan_day_items WHERE status='done' AND removed_at IS NULL").get().n,3,'saving and reopening a draft preserves completed work');
    await sub.screenshot({path:path.join(output,'completed-draft-mobile.png'),fullPage:true,animations:'disabled'});
    await sub.locator('#modal-cancel').click();await sub.evaluate(()=>window.scrollTo(0,0));await sub.locator('[data-view="dashboard"]').click();await sub.locator('[data-day-open]').first().click();
    await sub.locator('#detail-check').click();await sub.locator('#pd-note').fill('完成滚动安排的阅读、词汇与听力');await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    await sub.locator('[data-view="tasks"]').click();await sub.locator(`[data-daily-plan="${stage.id}"]`).click();
    assert.equal(await sub.locator('[data-daily-edit]').first().isDisabled(),true);
    assert.match(await sub.locator('[data-daily-edit]').first().innerText(),/打卡待审核/);await sub.locator('#modal-ok').click();
    await sup.reload();await sup.locator('[data-view="dashboard"]').click();await sup.locator('[data-day-open]').first().click();await sup.locator('#detail-review').click();await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
    assert.equal(db.prepare("SELECT COUNT(*) n FROM plan_days WHERE checkin_state='approved'").get().n,1);
    await sub.reload();await sub.locator(`[data-daily-plan="${stage.id}"]`).click();
    assert.equal(await sub.locator('[data-daily-edit]').first().isDisabled(),true);
    assert.match(await sub.locator('[data-daily-edit]').first().innerText(),/已确认完成/);await sub.locator('#modal-ok').click();
    await sub.locator('[data-view="my"]').click();await sub.locator('[data-end-relation="sup"]').click();await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    await sub.locator('#my-history').click();await sub.locator('[data-history-plan]').first().click();await sub.getByText('每日安排已生效',{exact:false}).first().waitFor();
    assert.deepEqual(errors,[]);console.log('ROLLING UI PASS: empty long stage → acceptance → supervisee daily proposal → supervisor approval → supervisor adjustment → supervisee approval → rolling check-in and review → locked approved day → preserved history after unbinding; no page errors');
  }catch(error){if(browser)for(const context of browser.contexts())for(const p of context.pages()){console.error('FAILED PAGE',p.url(),await p.locator('body').innerText());await p.screenshot({path:path.join(output,'failure-'+(await p.locator('body').getAttribute('data-role'))+'.png'),fullPage:true});}throw error;}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

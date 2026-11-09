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
    // 手机网络切换时要明确提示；恢复后状态提示应消失，避免遮挡正常操作。
    await sub.evaluate(()=>window.dispatchEvent(new Event('offline')));
    await sub.locator('#network-status').waitFor();
    assert.match(await sub.locator('#network-status').innerText(),/离线状态/);
    await sub.evaluate(()=>window.dispatchEvent(new Event('online')));
    await sub.locator('#network-status').waitFor({state:'hidden'});
    await admin.locator('[data-view="certifications"]').click();await admin.locator('[data-cert-review]').click();await admin.locator('#cert-review-note').fill('材料已核验');await admin.locator('#modal-ok').click();
    await sub.locator('[data-view="my"]').click();await sub.locator('#my-life').waitFor();await sub.screenshot({path:path.join(output,'my-mobile.png'),fullPage:true});
    await sub.evaluate(()=>window.scrollTo(0,300));
    await sub.waitForFunction(()=>document.body.classList.contains('tabbar-collapsed'));
    await sub.evaluate(()=>window.scrollTo(0,0));
    await sub.waitForFunction(()=>!document.body.classList.contains('tabbar-collapsed'));
    assert.equal(await sub.evaluate(()=>getComputedStyle(document.querySelector('.tabbar button')).minHeight),'54px','mobile navigation keeps a 44px+ touch target');
    await sub.locator('#my-market').click();await sub.locator('[data-person="sup"]').waitFor();await sub.screenshot({path:path.join(output,'market-mobile.png'),fullPage:true});
    await sub.getByRole('button',{name:'默认排序'}).click();await sub.screenshot({path:path.join(output,'market-menu-mobile.png'),fullPage:true});await sub.getByRole('option',{name:'服务评分'}).click();
    assert.equal(await sub.locator('#market-sort').evaluate((el)=>el.value),'rating');
    await sub.locator('#market-q').fill('英语');await sub.locator('#market-verified').check();await sub.locator('#market-form button[type="submit"]').click();await sub.locator('[data-person="sup"]').click();await sub.locator('#profile-primary').waitFor();
    assert.ok((await sub.locator('#content').innerText()).includes('已认证'));
    await sub.screenshot({path:path.join(output,'profile-mobile.png'),fullPage:true});
    await sub.locator('#profile-primary').click();await sub.locator('#start-quick').click();await sub.locator('#quick-goal').fill('每天背20个英语单词');await sub.locator('#modal-ok').click();await sub.locator('#request-terms').waitFor();
    await sub.locator('#request-terms').click();await sub.locator('#request-terms-input').waitFor();assert.equal(await sub.locator('#request-terms-input').evaluate((el)=>getComputedStyle(el).fontSize),'16px','mobile form inputs avoid iOS focus zoom');await sub.locator('#request-terms-input').fill('每天20词，次日上午确认，每7天复盘');await sub.locator('#modal-ok').click();
    await sup.locator('#refresh-work').click();await sup.locator('[data-request]').first().click();await sup.locator('#request-confirm').click();await sup.locator('#request-plan').waitFor();await sup.locator('#request-plan').click();await sup.locator('#rolling-existing').click();await sup.locator('#modal-cancel').click();
    await sup.locator('#goal-title').fill('建立英语学习习惯');await sup.locator('[data-goal-stage]').first().locator('[data-field="content"]').fill('背20个单词并复习');await sup.locator('#goal-desc').fill('提交词汇范围，次日上午确认');
    await sup.locator('.goal-route-week > summary').first().click();await sup.locator('[data-plan-action="open-week"]').first().click();await sup.locator('[data-day] > summary').first().click();await sup.locator('[data-slot="0"] > summary').click();await sup.locator('[data-slot-field="title"]').first().fill('背10个单词并朗读');await sup.locator('[data-plan-action="add-slot"]').click();await sup.locator('[data-slot="1"] [data-slot-field="title"]').fill('复述词义');await sup.locator('[data-plan-mode="route"]').click();await sup.locator('[data-plan-action="add-stage"][data-length="7"]').click();await sup.locator('[data-goal-stage]').nth(1).locator('[data-field="content"]').fill('复习旧词并精读');
    assert.equal(await sup.locator('[data-goal-stage]').count(),2);await sup.screenshot({path:path.join(output,'plan-composer-desktop.png'),fullPage:true});
    await sup.locator('#modal-ok').click();await sup.locator('.goal-preview > details > summary').click();await sup.getByText('第 2 阶段',{exact:true}).waitFor();await sup.locator('#modal-ok').click();await sup.locator('#modal').filter({has:sup.locator('.dialog')}).waitFor({state:'hidden'});
    await sub.locator('[data-view="dashboard"]').click();await sub.locator('[data-agreement]').waitFor();await sub.locator('[data-agreement]').click();await sub.locator('#modal-ok').click();
    await sub.locator('[data-day-open]').first().waitFor();assert.ok(!(await sub.locator('.hh-status').innerText()).includes('都完成'));await sub.locator('[data-day-open]').first().click();await sub.locator('[data-detail-item]').first().waitFor();assert.equal(await sub.locator('[data-detail-item]').count(),2);for(let i=0;i<2;i++){await sub.locator('[data-detail-item]').nth(i).click();await sub.locator('[data-detail-item][aria-checked="true"]').nth(i).waitFor();}await sub.locator('#detail-check').click();await sub.locator('#pd-note').fill('完成了A组20词');await sub.locator('#modal-ok').click();
    await sub.locator('#modal').waitFor({state:'hidden'});await sub.getByText('已提交 · 待确认',{exact:true}).waitFor();
    await sup.locator('[data-view="dashboard"]').click();await sup.locator('[data-day-open]').first().click();await sup.locator('#detail-review').click();await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plan_days WHERE checkin_state='approved'").get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM life_logs').get().n,0);
    await sub.locator('#refresh-work').click();await sub.locator('[data-view="tasks"]').click();await sub.getByText('当前阶段',{exact:true}).waitFor();
    await sub.screenshot({path:path.join(output,'today-mobile.png'),fullPage:true});
    await sup.locator('[data-view="my"]').click();await sup.locator('#my-market').click();await sup.locator('[data-person="sup"]').waitFor();await sup.screenshot({path:path.join(output,'market-desktop.png'),fullPage:true});
    // 同一目标续期经过真实表单发送与接受，旧阶段内容和确认结果不变。
    const renewalRoot=db.prepare("SELECT * FROM plans WHERE kind='phase' AND status='active'").get();
    const oldStages=db.prepare('SELECT id FROM plans WHERE parent_id=? ORDER BY id').all(renewalRoot.id);
    const oldDays=JSON.stringify(db.prepare('SELECT d.* FROM plan_days d JOIN plans p ON p.id=d.plan_id WHERE p.parent_id=? ORDER BY d.id').all(renewalRoot.id));
    const renewalStart=new Date(db.prepare('SELECT MAX(due_at) value FROM plans WHERE parent_id=?').get(renewalRoot.id).value);renewalStart.setDate(renewalStart.getDate()+1);renewalStart.setHours(0,0,0,0);
    const renewalEnd=new Date(renewalStart);renewalEnd.setDate(renewalEnd.getDate()+6);
    const calendar=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    await sup.locator('[data-view="tasks"]').click();await sup.locator('[data-phase-addcyc]').first().click();await sup.locator('#cyc-title').fill('续期巩固阶段');
    await sup.locator('#cyc-start').fill(calendar(renewalStart));await sup.locator('#cyc-due').fill(calendar(renewalEnd));await sup.locator('#cyc-content').fill('继续复习并朗读');await sup.locator('#modal-ok').click();await sup.locator('#modal').waitFor({state:'hidden'});
    const renewal=db.prepare("SELECT * FROM plans WHERE title='续期巩固阶段'").get();assert.equal(renewal.status,'proposed');
    await sub.locator('[data-view="tasks"]').click();await sub.locator(`[data-agreement="${renewal.id}"]`).click();await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(renewal.id).status,'active');
    assert.equal(renewal.cooperation_period_id,renewalRoot.cooperation_period_id);
    for(const old of oldStages)assert.equal(db.prepare('SELECT status FROM plans WHERE id=?').get(old.id).status,'active');
    assert.equal(JSON.stringify(db.prepare('SELECT d.* FROM plan_days d JOIN plans p ON p.id=d.plan_id WHERE p.parent_id=? AND p.id<>? ORDER BY d.id').all(renewalRoot.id,renewal.id)),oldDays);
    await sub.getByText(`已接受阶段覆盖：`,{exact:false}).first().waitFor();
    await sub.getByText('后续阶段',{exact:true}).waitFor();
    await sub.screenshot({path:path.join(output,'renewal-mobile.png'),fullPage:true});
    await sub.locator('[data-view="my"]').click();await sub.locator('#my-edit').click();await sub.locator('#profile-headline').fill('每天进步一点');await sub.locator('#profile-skills').fill('阅读，英语');await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    assert.equal(profiles.own(db,'sub').headline,'每天进步一点');
    assert.equal(await sub.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'mobile overflow');
    const retained=db.prepare('SELECT COUNT(*) AS n FROM plans').get().n;
    await sub.locator('[data-end-relation="sup"]').click();await sub.locator('#modal-ok').click();await sub.locator('#modal').waitFor({state:'hidden'});
    await sub.locator('#my-history').click();await sub.locator('[data-history-plan]').first().click();await sub.locator('#modal details > summary').first().click();await sub.getByText('完成了A组20词',{exact:false}).waitFor();
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,retained);
    assert.equal(db.prepare("SELECT status FROM service_requests LIMIT 1").get().status,'closed');
    await sub.locator('#modal details > summary').last().scrollIntoViewIfNeeded();
    assert.equal(await sub.locator('.history-records').evaluate(el=>el.scrollHeight>el.clientHeight),true);
    const lastSummary=await sub.locator('#modal details > summary').last().boundingBox(),historyBox=await sub.locator('.history-records').boundingBox();
    assert.ok(lastSummary.y>=historyBox.y&&lastSummary.y+lastSummary.height<=historyBox.y+historyBox.height+1,'last historical day is visible');
    await sub.locator('.history-records').evaluate(el=>{el.scrollTop=0});await sub.screenshot({path:path.join(output,'history-mobile.png'),fullPage:true});await sub.locator('#modal-ok').click();
    await sub.reload();await sub.locator('#history-search').waitFor();
    assert.deepEqual(errors,[],'browser errors');
    console.log('UI PASS: certification → market → profile → negotiation → goal acceptance → multi-item check-in → approval → stage renewal acceptance with old records unchanged → end cooperation → retained history → reload session; no page errors');
  }catch(error){if(browser)for(const context of browser.contexts())for(const p of context.pages()){console.error('FAILED PAGE',p.url(),await p.locator('body').innerText());await p.screenshot({path:path.join(output,'failure-'+(await p.locator('body').getAttribute('data-role'))+'.png'),fullPage:true});}throw error;}finally{if(browser)await browser.close();await new Promise(r=>server.close(r));await server.stopBackground();closeDb();fs.rmSync(tmp,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});

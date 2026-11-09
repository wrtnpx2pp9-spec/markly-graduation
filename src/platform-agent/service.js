'use strict';
const users = require('../repo/user.repo');
const notify = require('../notify');
const { textViolation } = require('../content-safety');
const pi = require('../plan-agent/pi-runtime');
const planConfig = require('../plan-agent/config');
const { createTools } = require('./tool-registry');
const { SYSTEM } = require('./prompts');
const crypto = require('crypto');
const auditRepo = require('../repo/audit.repo');
const security = require('../security');
const fs = require('fs');
const path = require('path');
const { inputViolation } = require('../content-safety');

const bad = (message, statusCode = 400) => { throw Object.assign(Error(message), { statusCode }); };
function identity(u) { return { id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status === 1 ? 'active' : 'disabled', accountLevel: u.account_level || 'basic', createdAt: u.created_at }; }
function overview(db) { return require('../controllers/admin.ctrl').readOverview(db); }
function findUsers(db, query, role) {
  const q=typeof query==='string'?query.trim():'';
  if(q.length>50||(role&&!['supervisor','supervisee'].includes(role)))return {error:'查询条件不正确'};
  return db.prepare("SELECT * FROM users WHERE role!='admin' AND (?='' OR instr(lower(display_name),lower(?))>0 OR instr(lower(username),lower(?))>0) AND (?='' OR role=?) ORDER BY created_at DESC,id LIMIT 20").all(q,q,q,role||'',role||'').map(identity);
}
function userProfile(db, id) { const u=users.byId(db,id); if(!u||u.role==='admin') return { error:'用户不存在' }; const relations=u.role==='supervisor'?users.relationCount(db,u.id):users.activeSupervisorIds(db,u.id).length, tasks=db.prepare('SELECT COUNT(*) AS total,SUM(status=\'done\') AS done FROM tasks WHERE creator_id=? OR assignee_id=?').get(u.id,u.id), plans=db.prepare('SELECT COUNT(*) AS total,SUM(status=\'active\') AS active FROM plans WHERE creator_id=? OR assignee_id=?').get(u.id,u.id); return {...identity(u),operations:{supervisionRelations:relations,tasks:{total:tasks.total||0,done:tasks.done||0},plans:{total:plans.total||0,active:plans.active||0}}}; }
function records(db, kind, userId, limit) {
  if(kind==='operationsQueue')return {
    registrations:db.prepare("SELECT id,role,status,created_at AS createdAt FROM registration_applications WHERE status='pending' ORDER BY created_at LIMIT 50").all(),
    certifications:db.prepare("SELECT c.id,c.user_id AS userId,c.title,c.created_at AS createdAt FROM certifications c JOIN users u ON u.id=c.user_id WHERE c.status='pending' AND u.role='supervisor' ORDER BY c.created_at LIMIT 50").all(),
    requests:db.prepare("SELECT id,status,created_at AS createdAt FROM service_requests WHERE status IN ('discussing','planning','plan_proposed') ORDER BY created_at LIMIT 50").all(),
    limitPerCategory:50, note:'各类最早50条待办，完整总数以运营概览为准；不含联系方式和认证材料'
  };
 const max=Math.min(100,Math.max(1,Number.isInteger(limit)?limit:30)); if(!['tasks','plans','lifeLogs','notifications','activity'].includes(kind))return {error:'记录类型不正确'}; if(userId&&(!users.byId(db,userId)||users.byId(db,userId).role==='admin'))return {error:'用户不存在'}; if(kind==='tasks')return db.prepare(`SELECT id,title,note,status,due_at AS dueAt,creator_id AS creatorId,assignee_id AS assigneeId,created_at AS createdAt FROM tasks ${userId?'WHERE creator_id=? OR assignee_id=?':''} ORDER BY created_at DESC LIMIT ?`).all(...(userId?[userId,userId,max]:[max])); if(kind==='plans')return db.prepare(`SELECT id,title,kind,status,creator_id AS creatorId,assignee_id AS assigneeId,created_at AS createdAt FROM plans ${userId?'WHERE creator_id=? OR assignee_id=?':''} ORDER BY created_at DESC LIMIT ?`).all(...(userId?[userId,userId,max]:[max])); if(kind==='lifeLogs')return db.prepare(`SELECT id,user_id AS userId,log_date AS logDate,content,mood,created_at AS createdAt FROM life_logs ${userId?'WHERE user_id=?':''} ORDER BY created_at DESC LIMIT ?`).all(...(userId?[userId,max]:[max])); if(kind==='notifications')return db.prepare(`SELECT id,user_id AS userId,kind,title,content,is_read AS isRead,created_at AS createdAt FROM notifications ${userId?'WHERE user_id=?':''} ORDER BY created_at DESC LIMIT ?`).all(...(userId?[userId,max]:[max])); return db.prepare(`SELECT subject_id AS userId,event_type AS type,entity_type AS entityType,entity_id AS entityId,summary,created_at AS createdAt FROM activity_events ${userId?'WHERE subject_id=? OR actor_id=?':''} ORDER BY created_at DESC LIMIT ?`).all(...(userId?[userId,userId,max]:[max])); }
const ROOT=path.resolve(__dirname,'../..'), FILE_EXT=new Set(['.js','.json','.md','.html','.css']), SAFE_TOP=new Set(['src','public','docs','scripts']);
function safeProjectPath(relative) { if(typeof relative!=='string'||relative.length>240)return null; const normalized=relative.replace(/\\/g,'/'); if(normalized.includes('..')||normalized.startsWith('.')||/\.env|secret|credential|\.db/i.test(normalized))return null; const absolute=path.resolve(ROOT,normalized), top=normalized.split('/')[0]; return absolute.startsWith(ROOT+path.sep)&&SAFE_TOP.has(top)&&FILE_EXT.has(path.extname(absolute).toLowerCase())?absolute:null; }
function projectTree() { const out=[]; const walk=(dir,base)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(out.length>=400)return;const rel=base+'/'+entry.name;if(entry.isDirectory())walk(path.join(dir,entry.name),rel);else if(safeProjectPath(rel))out.push(rel);}};for(const top of SAFE_TOP)if(fs.existsSync(path.join(ROOT,top)))walk(path.join(ROOT,top),top);return out; }
function projectFile(relative,start,end) { const full=safeProjectPath(relative); if(!full||!fs.existsSync(full))return {error:'文件不在只读允许范围'}; const lines=fs.readFileSync(full,'utf8').split(/\r?\n/), from=Math.max(1,Number.isInteger(start)?start:1), to=Math.min(lines.length,Math.max(from,Number.isInteger(end)?end:Math.min(from+399,lines.length))); return {path:relative,startLine:from,endLine:to,content:lines.slice(from-1,to).join('\n')}; }
function schema(db) { return db.prepare("SELECT type,name,tbl_name AS tableName,sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all(); }
function create(db) {
  db.exec('CREATE TABLE IF NOT EXISTS platform_agent_reports(id TEXT PRIMARY KEY,admin_id TEXT NOT NULL,title TEXT NOT NULL,report_json TEXT NOT NULL,created_at INTEGER NOT NULL)');
  const grants=new Map(), attempts=new Map(), activeRuns=new Map(); let stopped=false,stopPromise=null; const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
  function reauth(admin, secondaryPassword, sessionToken) { if(admin.role!=='admin')bad('仅管理员可验证运营 Pi',403); const now=Date.now(), prior=attempts.get(admin.id); if(prior?.until>now)bad('二级密码验证次数过多，请稍后再试',429); if(!require('../security').validPlatformAgentSecondaryPassword(secondaryPassword)){const next={count:(prior?.count||0)+1,until:0};if(next.count>=5)next.until=now+10*60*1000;attempts.set(admin.id,next);bad('二级密码验证失败',403);} attempts.delete(admin.id); const grant=crypto.randomBytes(32).toString('base64url');grants.set(digest(grant),{adminId:admin.id,session:digest(sessionToken||''),expiresAt:now+5*60*1000});return {reauthToken:grant,expiresAt:now+5*60*1000}; }
  function assertGrant(admin, sessionToken, grant) { const row=grants.get(digest(String(grant||''))); if(!row||row.adminId!==admin.id||row.session!==digest(sessionToken||'')||row.expiresAt<Date.now())bad('请先完成运营 Pi 二级密码验证',403); }
  function run(admin, body, sessionToken, grant) {
    if(stopped)bad('运营 Pi 正在停止，请稍后再试',503);
    const controller=new AbortController();
    const pending=runTask(admin,body,sessionToken,grant,controller).finally(()=>activeRuns.delete(pending));
    activeRuns.set(pending,controller);
    return pending;
  }
  async function runTask(admin, body, sessionToken, grant, controller) {
    const { signal } = controller;
    let accessError;
    function assertAccess() {
      if(accessError)throw accessError;
      if(signal.aborted)bad('本次运营任务已取消',409);
      const current=security.userByToken(db,sessionToken);
      if(!current||current.id!==admin.id||current.role!=='admin'||current.status!==1){
        accessError=Object.assign(Error('管理员权限或原登录会话已失效，本次运营任务已停止'),{statusCode:403});
        controller.abort();
        throw accessError;
      }
    }
    assertAccess();
    assertGrant(admin,sessionToken,grant);
    const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
    if (!instruction || instruction.length > 1000) bad('运营任务说明需为 1—1000 字');
    const contentError = textViolation(instruction);
    if (contentError) bad(contentError);
    const config = planConfig.get(db, true);
    if (!config.enabled) bad('管理员尚未启用 Pi 服务', 409);
    const sent = []; let report=null;
    const allowNotifications = body?.allowNotifications === true;
    const send = (userId, title, content) => {
      assertAccess();
      if (!allowNotifications) return {ok:false,error:'本次任务仅分析整理，未授权发送通知'};
      if (typeof title !== 'string' || typeof content !== 'string' || !title.trim() || !content.trim() || title.length > 80 || content.length > 500) return { ok: false, error: '通知标题或正文不正确' };
      const error = textViolation(title) || textViolation(content);
      if (error) return { ok: false, error };
      const recipient = users.byId(db, userId);
      if (!recipient || recipient.status !== 1 || recipient.role === 'admin') return { ok: false, error: '接收人不可用' };
      db.exec('BEGIN IMMEDIATE');
      try {
        notify.deliver(db, { userId, recipientUser: recipient, kind: 'platform_agent', title: title.trim(), content: content.trim(), linkType: '', linkId: '' });
        db.exec('COMMIT');
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      }
      sent.push({ userId, displayName: recipient.display_name });
      return { ok: true };
    };
    const { Type } = await import('@earendil-works/pi-ai');
    assertAccess();
    const audit=(operation)=>{assertAccess();auditRepo.record(db,{actorId:admin.id,method:'PLATFORM_PI_'+operation.toUpperCase(),path:'/api/admin/platform-agent/runs'});};
    const saveReport=(value)=>{try{assertAccess();if(!value||typeof value.title!=='string'||typeof value.summary!=='string'||value.title.trim().length<1||value.title.length>120||value.summary.length>3000||!Array.isArray(value.sections)||value.sections.length>20||!Array.isArray(value.chartSpecs)||value.chartSpecs.length>8)throw Error('报告结构不正确');if(value.sections.some(s=>!s||typeof s.title!=='string'||typeof (s.content??s.text)!=='string')||value.chartSpecs.some(c=>!c||typeof c.title!=='string'||!Array.isArray(c.labels)||!Array.isArray(c.values)||c.labels.length>50||c.labels.length!==c.values.length||c.labels.some(l=>typeof l!=='string')||c.values.some(v=>typeof v!=='number'||!Number.isFinite(v))))throw Error('请提供标题与正文组成的章节，图表标签与数值数量需一致');if(JSON.stringify(value).length>64000)throw Error('报告过长，请精简到64000字以内');const error=inputViolation(value);if(error)throw Error(error);const clean={title:value.title.trim(),summary:value.summary.trim(),sections:value.sections,chartSpecs:value.chartSpecs};const id=crypto.randomUUID();db.prepare('INSERT INTO platform_agent_reports(id,admin_id,title,report_json,created_at) VALUES(?,?,?,?,?)').run(id,admin.id,clean.title,JSON.stringify(clean),Date.now());report={id,...clean};return {ok:true,reportId:id};}catch(error){return {ok:false,error:error.message};}};
    const tools=createTools(Type, { overview:()=>overview(db), findUsers:(q,r)=>findUsers(db,q,r), getProfile:(id)=>userProfile(db,id), readRecords:(kind,id,limit)=>records(db,kind,id,limit), projectTree, projectFile, schema:()=>schema(db), saveReport, send, audit })
      .map(tool=>({...tool,execute:async(...args)=>{assertAccess();return tool.execute(...args);}}));
    await pi.run({ config, signal, context: { administratorInstruction: instruction, allowNotifications, policy: '仅限平台内部运营管理；只读数据，禁止删除、修改、外发或导出；必须保存报告。' }, tools, systemPrompt: SYSTEM, initialPrompt: '先读取运营概览；需要时查询项目、用户资料或业务记录。不得删除或修改任何平台数据或代码，完成后保存运营报告。', saveCandidate: () => ({ ok: false }) });
    assertAccess();
    return { ok: true, sent, report };
  }
  function reports(admin) { if(admin.role!=='admin')bad('仅管理员可查看运营报告',403); return db.prepare('SELECT id,title,report_json,created_at FROM platform_agent_reports WHERE admin_id=? ORDER BY created_at DESC LIMIT 30').all(admin.id).map(row=>({id:row.id,title:row.title,...JSON.parse(row.report_json),createdAt:row.created_at})); }
  function stop(){
    if(stopPromise)return stopPromise;
    stopped=true;
    for(const controller of activeRuns.values())controller.abort();
    stopPromise=Promise.allSettled([...activeRuns.keys()]).then(()=>{});
    return stopPromise;
  }
  return { run, reauth, reports, stop };
}
module.exports = { create, overview, findUsers, records };

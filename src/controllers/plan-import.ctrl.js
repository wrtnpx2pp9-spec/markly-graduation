'use strict';
const crypto = require('crypto');
const engine = require('../plan-import');
const drafts = require('../plan-drafts');
const users = require('../repo/user.repo');
const audit = require('../repo/audit.repo');
const { sendJson, sendError } = require('../router');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const activeImports = new Set();
const bad = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
function scope(db, user, body) {
  if (user.role !== 'supervisor' || !users.isServiceEnabled(user)) bad('监督服务尚未获得平台授权', 403);
  if (body.requestId) {
    const request = db.prepare('SELECT * FROM service_requests WHERE id=?').get(body.requestId);
    if (!request || request.supervisor_id !== user.id || request.supervisee_id !== body.assigneeId || request.status !== 'planning') bad('无权为该协商制定计划', 403);
  } else if (!users.activeSuperviseeIds(db, user.id).includes(body.assigneeId)) bad('请先建立监督关系', 403);
}
function register(router, deps) {
  const wrap = fn => async c => { try { await fn(c); } catch (e) { sendError(c.res, e.statusCode || 400, e.statusCode ? e.message : '无法整理这份内容，请检查文件或计划格式后重试'); } };
  const own = c => { const row = drafts.get(c.db, c.params.id, c.user.id); if (!row) bad('草稿不存在', 404); return row; };
  const validWorkspace = (body, row = null) => {
    const workspace = body.workspace, bundle = body.bundle;
    const assigneeId = row ? row.assignee_id : body.assigneeId;
    const requestId = row ? (row.request_id || '') : (body.requestId || '');
    if (!workspace || !Array.isArray(workspace.stages) || workspace.stages.length > 12 || workspace.personId !== assigneeId || !bundle || bundle.assigneeId !== assigneeId || (bundle.requestId || '') !== requestId) bad('草稿内容或服务对象不正确');
    if (Buffer.byteLength(JSON.stringify({ workspace, bundle })) > 7500000) bad('草稿内容过大');
  };
  router.addRole('GET', '/api/plan-import/options', c => sendJson(c.res, 200, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, maxDays: 365, maxFileBytes: 2097152 }), ['supervisor']);
  router.addRole('GET', '/api/plan-drafts', c => {
    const filter = c.query.assigneeId ? ' AND assignee_id=?' : '';
    const args = c.query.assigneeId ? [c.user.id, c.query.assigneeId] : [c.user.id];
    const rows = c.db.prepare('SELECT id,version,assignee_id,request_id,workspace_json,limits_json,updated_at FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL' + filter + ' ORDER BY updated_at DESC,id DESC LIMIT 30').all(...args);
    sendJson(c.res, 200, { drafts: rows.map(r => ({ id: r.id, version: r.version, kind: drafts.kind(r), assigneeId: r.assignee_id, requestId: r.request_id, title: JSON.parse(r.workspace_json).title || '未命名草稿', updatedAt: r.updated_at })) });
  }, ['supervisor']);
  router.addRole('GET', '/api/plan-drafts/:id', wrap(c => sendJson(c.res, 200, { draft: drafts.publicDraft(own(c)) })), ['supervisor']);

  // Manual planning used to be browser-only.  Store its incomplete workspace
  // immediately so it can be resumed safely from another browser or device.
  router.addRole('POST', '/api/plan-drafts', wrap(c => {
    scope(c.db, c.user, c.body);
    validWorkspace(c.body);
    if (c.db.prepare('SELECT COUNT(*) AS n FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL').get(c.user.id).n >= 100) bad('未发送草稿已达 100 份，请先清理草稿', 409);
    const source = { name: '手动编排', digest: '', lines: [], notices: ['此草稿由监督者手动填写；发送前仍会执行完整计划校验。'] };
    let row;
    c.db.exec('BEGIN IMMEDIATE');
    try {
      row = drafts.create(c.db, c.user.id, c.body.assigneeId, c.body.requestId, source, { manual: true }, c.body.workspace, { bundle: c.body.bundle, reviewed: true });
      c.db.exec('COMMIT');
    } catch (error) {
      try { c.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    sendJson(c.res, 201, { draft: drafts.publicDraft(row) });
  }), ['supervisor']);

  async function importDraft(c, machine = false) {
    scope(c.db, c.user, c.body);
    const fingerprint = hash(JSON.stringify(c.body)), key = machine ? c.req.headers['idempotency-key'] : null;
    if (machine) {
      if (!key || !/^[\w.-]{8,100}$/.test(key)) bad('需要 8—100 字符的 Idempotency-Key');
      const previous = c.db.prepare('SELECT * FROM plan_api_requests WHERE user_id=? AND key=?').get(c.user.id, key);
      if (previous) { if (previous.fingerprint !== fingerprint) bad('幂等键已用于不同内容', 409); return sendJson(c.res, 200, { draft: drafts.publicDraft(drafts.get(c.db, previous.draft_id, c.user.id)), replayed: true }); }
    }
    const lock = `${c.user.id}`;
    if (activeImports.has(lock)) bad('上一份内容还在整理，请稍后重试', 429);
    if (c.db.prepare('SELECT COUNT(*) AS n FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL').get(c.user.id).n >= 100) bad('未发送草稿已达 100 份，请先清理草稿', 409);
    activeImports.add(lock);
    try {
      const limits = engine.constraints(c.body.constraints);
      let text = c.body.file ? await engine.readDocument(c.body.file) : c.body.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 50000) bad('请输入计划正文，最多 50000 字');
      text = text.trim();
      const parsed = engine.parseText(text); let rules = parsed.rules, sources = parsed.sources, fallback = false;
      if (machine && c.body.rules) { rules = c.body.rules; sources = sources.map(s => ({ ...s, kind: 'suggested' })); }
      else if (process.env.PLAN_ASSIST_URL) {
        try { const candidate = await engine.assist(text, limits); if (candidate) { engine.expand(candidate, limits, c.body.assigneeId); rules = candidate; sources = sources.map(s => ({ ...s, kind: 'suggested' })); } } catch { fallback = true; }
      }
      const expanded = engine.expand(rules, limits, c.body.assigneeId);
      // Sessions and machine credentials have separate revocation paths; recheck the original credential.
      if (machine) checkMachine(c, false);
      else {
        const authenticated = deps.security.authenticate(c.db, c.req);
        if (!authenticated.user || authenticated.user.id !== c.user.id || authenticated.token !== c.authToken) bad('会话已失效，请重新登录后整理计划', 401);
      }
      // Re-check after the asynchronous extraction, including grants revoked while it ran.
      scope(c.db, users.byId(c.db, c.user.id) || {}, c.body);
      const source = { name: String(c.body.file?.name || (machine ? '接口导入' : '粘贴的计划')).slice(0, 200), digest: hash(text), lines: sources, notices: [...expanded.notices, ...(fallback ? ['补充整理暂不可用，已保留规则识别结果；请检查未识别的原文。'] : [])] };
      c.db.exec('BEGIN IMMEDIATE');
      let row;
      try {
        if (c.db.prepare('SELECT COUNT(*) AS n FROM plan_drafts WHERE owner_id=? AND plan_id IS NULL').get(c.user.id).n >= 100) bad('未发送草稿已达 100 份，请先清理草稿', 409);
        row = drafts.create(c.db, c.user.id, c.body.assigneeId, c.body.requestId, source, limits, expanded.workspace);
        if (machine) c.db.prepare('INSERT INTO plan_api_requests(user_id,key,fingerprint,draft_id) VALUES(?,?,?,?)').run(c.user.id, key, fingerprint, row.id);
        c.db.exec('COMMIT');
      } catch (e) { c.db.exec('ROLLBACK'); throw e; }
      sendJson(c.res, 201, { draft: drafts.publicDraft(row) });
    } finally { activeImports.delete(lock); }
  }
  router.addRole('POST', '/api/plan-import', wrap(c => importDraft(c)), ['supervisor']);
  router.addRole('PUT', '/api/plan-drafts/:id', wrap(c => {
    const row = own(c), b = c.body;
    scope(c.db, c.user, { assigneeId: row.assignee_id, requestId: row.request_id });
    if (row.plan_id) bad('已发送草稿不能覆盖', 409);
    if (b.version !== row.version) bad('其他页面已更新这份草稿。本机内容已保留，请重新打开核对', 409);
    validWorkspace(b, row);
    if (typeof b.reviewed !== 'boolean') bad('草稿确认状态不正确');
    const reviewed = drafts.isManual(row) ? 1 : (b.reviewed ? 1 : 0);
    const update = c.db.prepare('UPDATE plan_drafts SET workspace_json=?,bundle_json=?,reviewed=?,version=version+1,updated_at=? WHERE id=? AND version=?').run(JSON.stringify(b.workspace), JSON.stringify(b.bundle), reviewed, Date.now(), row.id, row.version);
    if (!update.changes) bad('其他页面已更新这份草稿。本机内容已保留，请重新打开核对', 409);
    sendJson(c.res, 200, { draft: drafts.publicDraft(own(c)) });
  }), ['supervisor']);
  router.addRole('DELETE', '/api/plan-drafts/:id', wrap(c => { const row = own(c); if (row.plan_id) bad('已发送草稿不可删除'); c.db.prepare('DELETE FROM plan_drafts WHERE id=?').run(row.id); sendJson(c.res, 200, { ok: true }); }), ['supervisor']);

  const access = (db, id) => db.prepare('SELECT user_id,eligible,state,purpose,note,expires_at,daily_quota FROM plan_api_access WHERE user_id=?').get(id) || { user_id: id, eligible: 0, state: 'none' };
  router.addRole('GET', '/api/plan-access', c => sendJson(c.res, 200, { access: access(c.db, c.user.id) }), ['supervisor']);
  router.addRole('POST', '/api/plan-access/apply', wrap(c => {
    const a = access(c.db, c.user.id);
    if (!a.eligible) bad('账号须先经管理员同意，才可申请调用', 403);
    if (['pending', 'active', 'approved'].includes(a.state)) bad('已有待审核申请或有效授权', 409);
    if (typeof c.body.purpose !== 'string' || !c.body.purpose.trim() || c.body.purpose.length > 500) bad('请填写 500 字以内的调用用途');
    c.db.prepare("UPDATE plan_api_access SET state='pending',purpose=?,token_hash=NULL WHERE user_id=?").run(c.body.purpose.trim(), c.user.id); sendJson(c.res, 200, { access: access(c.db, c.user.id) });
  }), ['supervisor']);
  router.addRole('POST', '/api/plan-access/credential', wrap(c => {
    const a = access(c.db, c.user.id); if (!a.eligible || !['approved', 'active'].includes(a.state) || a.expires_at <= Date.now()) bad('没有有效的调用授权', 403);
    const credential = 'mpd_' + crypto.randomBytes(32).toString('base64url');
    c.db.prepare("UPDATE plan_api_access SET token_hash=?,state='active' WHERE user_id=?").run(hash(credential), c.user.id); sendJson(c.res, 200, { credential, expiresAt: a.expires_at });
  }), ['supervisor']);
  router.addRole('GET', '/api/admin/plan-access/:id', c => sendJson(c.res, 200, { access: access(c.db, c.params.id) }), ['admin']);
  router.addRole('PUT', '/api/admin/plan-access/:id', wrap(c => {
    const user = users.byId(c.db, c.params.id), b = c.body, previous = access(c.db, c.params.id);
    if (!user || user.role !== 'supervisor') bad('监督者不存在', 404);
    if (!['eligible', 'approve', 'revoke', 'reject'].includes(b.action) || typeof b.note !== 'string' || !b.note.trim() || b.note.length > 500) bad('请选择操作并填写审核依据');
    if (b.action === 'eligible') c.db.prepare("INSERT INTO plan_api_access(user_id,eligible,note,reviewer_id) VALUES(?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET eligible=1,note=excluded.note,reviewer_id=excluded.reviewer_id").run(user.id, b.note, c.user.id);
    else if (b.action === 'approve') {
      if (!previous.eligible || previous.state !== 'pending') bad('须先开放申请资格，再由账号提交申请', 409);
      if (!Number.isInteger(b.days) || b.days < 1 || b.days > 90 || !Number.isInteger(b.quota) || b.quota < 1 || b.quota > 1000) bad('有效期为 1—90 天，日额度为 1—1000 次');
      c.db.prepare("UPDATE plan_api_access SET state='approved',note=?,reviewer_id=?,expires_at=?,daily_quota=?,token_hash=NULL WHERE user_id=?").run(b.note, c.user.id, Date.now() + b.days * 86400000, b.quota, user.id);
    } else c.db.prepare('UPDATE plan_api_access SET eligible=?,state=?,note=?,reviewer_id=?,token_hash=NULL WHERE user_id=?').run(b.action === 'revoke' ? 0 : previous.eligible, b.action === 'revoke' ? 'revoked' : 'rejected', b.note, c.user.id, user.id);
    sendJson(c.res, 200, { access: access(c.db, user.id) });
  }), ['admin']);
  function checkMachine(c, count = true) {
    const token = /^Bearer (mpd_[\w-]+)$/.exec(c.req.headers?.authorization || '')?.[1];
    const a = token && c.db.prepare('SELECT * FROM plan_api_access WHERE token_hash=?').get(hash(token));
    const user = a && users.byId(c.db, a.user_id);
    if (!a || !a.eligible || a.state !== 'active' || a.expires_at <= Date.now() || !user || user.status !== 1 || !users.isServiceEnabled(user)) bad('调用凭据无效、已过期或已撤销', 401);
    if (count) {
      const today = new Date().toISOString().slice(0, 10);
      if (a.used_day === today && a.used_count >= a.daily_quota) bad('当日调用额度已用完', 429);
      c.db.prepare('UPDATE plan_api_access SET used_count=CASE WHEN used_day=? THEN used_count+1 ELSE 1 END,used_day=? WHERE user_id=?').run(today, today, user.id);
      audit.record(c.db, { actorId: user.id, method: c.req.method, path: c.req.url?.split('?')[0] || '/api/internal/plan-drafts', ip: c.req.socket?.remoteAddress });
    }
    c.user = user;
  }
  router.addPublic('POST', '/api/internal/plan-drafts', wrap(c => { checkMachine(c); return importDraft(c, true); }));
  router.addPublic('GET', '/api/internal/plan-drafts/:id', wrap(c => { checkMachine(c); sendJson(c.res, 200, { draft: drafts.publicDraft(own(c)) }); }));
}
module.exports = { register };

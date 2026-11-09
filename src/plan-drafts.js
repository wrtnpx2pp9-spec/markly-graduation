'use strict';
const crypto = require('crypto');
const { isDeepStrictEqual } = require('node:util');
const { validateBundle, workspaceBundle } = require('./plan-import');
function init(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS plan_drafts (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assignee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, request_id TEXT,
    version INTEGER NOT NULL DEFAULT 1, source_json TEXT NOT NULL, limits_json TEXT NOT NULL,
    workspace_json TEXT NOT NULL, bundle_json TEXT, reviewed INTEGER NOT NULL DEFAULT 0,
    plan_id TEXT, agent_sources_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_drafts_owner ON plan_drafts(owner_id,updated_at);
    CREATE TABLE IF NOT EXISTS plan_api_access (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      eligible INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'none', purpose TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '', reviewer_id TEXT, token_hash TEXT, expires_at INTEGER,
      daily_quota INTEGER NOT NULL DEFAULT 100, used_day TEXT NOT NULL DEFAULT '', used_count INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS plan_api_requests (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
      fingerprint TEXT NOT NULL, draft_id TEXT NOT NULL REFERENCES plan_drafts(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id,key));`);
}
const get = (db, id, owner) => db.prepare('SELECT * FROM plan_drafts WHERE id=? AND owner_id=?').get(id, owner);
function isManual(row) {
  try { return JSON.parse(row.limits_json || '{}').manual === true; } catch { return false; }
}
function kind(row) { return isManual(row) ? 'manual' : 'import'; }
function publicDraft(row) {
  const manual = isManual(row);
  return { id: row.id, version: row.version, kind: manual ? 'manual' : 'import', assigneeId: row.assignee_id, requestId: row.request_id,
    source: JSON.parse(row.source_json), constraints: JSON.parse(row.limits_json), workspace: JSON.parse(row.workspace_json),
    reviewed: !!row.reviewed, planId: row.plan_id, sources: [...(JSON.parse(row.source_json).lines || []), ...JSON.parse(row.agent_sources_json || '[]')], updatedAt: row.updated_at,
    // A manual draft is intentionally incomplete while it is being written.
    // Its final validation happens in /api/plan-bundles when it is sent.
    issues: !manual && row.bundle_json ? validateBundle(JSON.parse(row.bundle_json), JSON.parse(row.limits_json)) : [] };
}
function create(db, owner, assignee, requestId, source, limits, workspace, { bundle, reviewed = false } = {}) {
  const id = crypto.randomUUID(), now = Date.now();
  db.prepare('INSERT INTO plan_drafts(id,owner_id,assignee_id,request_id,source_json,limits_json,workspace_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, assignee, requestId || null, JSON.stringify(source), JSON.stringify(limits), JSON.stringify(workspace), now, now);
  db.prepare('UPDATE plan_drafts SET bundle_json=?,reviewed=? WHERE id=?').run(JSON.stringify(bundle || workspaceBundle(workspace,requestId)), reviewed ? 1 : 0, id);
  return get(db, id, owner);
}
function publishGuard(db, user, body) {
  const row = get(db, body.draftId, user.id);
  if (!row) return { error: '草稿不存在或无权访问', status: 404 };
  if (row.plan_id) return { error: '草稿已发送，请刷新计划列表', status: 409 };
  if (row.version !== body.draftVersion) return { error: '草稿版本已变化，请重新打开核对', status: 409 };
  if (!isManual(row) && !row.reviewed) return { error: '请先核对导入来源和待确认事项', status: 409 };
  if (row.assignee_id !== body.assigneeId || (row.request_id || '') !== (body.requestId || '')) return { error: '草稿服务对象或协商不一致', status: 403 };
  const submitted = { ...body }; delete submitted.draftId; delete submitted.draftVersion;
  let sameContent = false;
  try { sameContent = isDeepStrictEqual(JSON.parse(JSON.stringify(submitted)), JSON.parse(row.bundle_json)); } catch {}
  if (!sameContent) return { error: '请先保存当前内容，再重新预览发送', status: 409 };
  if (isManual(row)) return null;
  const errors = validateBundle(submitted, JSON.parse(row.limits_json)).filter(x => x.severity === 'error');
  if (errors.length) return { error: errors[0].text, status: 400 };
  return null;
}
module.exports = { init, get, kind, isManual, create, publicDraft, publishGuard };

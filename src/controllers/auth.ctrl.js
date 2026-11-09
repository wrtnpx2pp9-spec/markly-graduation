'use strict';
/** 认证控制器（初始化、登录、退出、当前用户、用户列表、状态、健康检查）。 */
// 安全与法律告知：攻击这个站点是违法的，需要追究法律责任。
const userRepo = require('../repo/user.repo');
const sessionRepo = require('../repo/session.repo');
const noteRepo = require('../repo/note.repo');
const { sendJson, sendError } = require('../router');
const activity = require('../repo/activity.repo');
const { createClientIpResolver } = require('../client-ip');

const loginFailures = new Map();
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_ACCOUNT_FAILURES = 8;
const MAX_IP_FAILURES = 30;
const MAX_LOGIN_REQUESTS = 40;
const MAX_SETUP_REQUESTS = 5;
const MAX_RATE_KEYS = 10000;
const loginRequests = new Map();
const setupRequests = new Map();

function bucket(map, key, limit, now = Date.now()) {
  // Bounded, expiring in-memory buckets deliberately fail closed under a key
  // flood: attackers must not turn the limiter itself into an unbounded cache.
  for (const [oldKey, entry] of map) if (entry.resetAt <= now) map.delete(oldKey);
  let entry = map.get(key);
  if (!entry) {
    if (map.size >= MAX_RATE_KEYS) return { allowed: false, retryAfter: Math.ceil(FAILURE_WINDOW_MS / 1000) };
    entry = { count: 0, resetAt: now + FAILURE_WINDOW_MS };
    map.set(key, entry);
  }
  if (entry.count >= limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  entry.count++;
  return { allowed: true, retryAfter: 0 };
}

function readBucket(map, key, limit, now = Date.now()) {
  const entry = map.get(key);
  if (!entry) return { blocked: false, retryAfter: 0 };
  if (entry.resetAt <= now) { map.delete(key); return { blocked: false, retryAfter: 0 }; }
  return { blocked: entry.count >= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
}

function loginKeys(ip, username) {
  const account = String(username || '').trim().toLowerCase();
  return { account: `account:${account}`, ip: `ip:${ip}`, pair: `pair:${ip}:${account}` };
}

function loginBlock(ip, username) {
  const now = Date.now();
  for (const [key, entry] of loginFailures) if (entry.resetAt <= now) loginFailures.delete(key);
  const keys = loginKeys(ip, username);
  const limits = [
    readBucket(loginFailures, keys.account, MAX_ACCOUNT_FAILURES, now),
    readBucket(loginFailures, keys.ip, MAX_IP_FAILURES, now),
    readBucket(loginFailures, keys.pair, MAX_ACCOUNT_FAILURES, now),
  ];
  const missing = Object.values(keys).filter(key => !loginFailures.has(key)).length;
  if (loginFailures.size + missing > MAX_RATE_KEYS) {
    // Reject requests whose failure could not be recorded. Keep live counters;
    // clearing them to make room would reopen blocked accounts and IPs.
    let resetAt = now + FAILURE_WINDOW_MS;
    for (const entry of loginFailures.values()) resetAt = Math.min(resetAt, entry.resetAt);
    limits.push({ blocked: true, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) });
  }
  return limits.reduce((result, item) => item.blocked && (!result.blocked || item.retryAfter > result.retryAfter) ? item : result, { blocked: false, retryAfter: 0 });
}

function recordLoginFailure(ip, username) {
  const keys = loginKeys(ip, username);
  return [
    bucket(loginFailures, keys.account, MAX_ACCOUNT_FAILURES),
    bucket(loginFailures, keys.ip, MAX_IP_FAILURES),
    bucket(loginFailures, keys.pair, MAX_ACCOUNT_FAILURES),
  ].every(result => result.allowed);
}

function clearLoginFailures(ip, username) {
  // A successful sign-in clears only this source/account pair.  It never
  // clears the account-wide or IP-wide counters used against distributed
  // password spraying and request floods.
  loginFailures.delete(loginKeys(ip, username).pair);
}

function sendRateLimit(res, retryAfter, message = '请求过于频繁，请稍后再试') {
  if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(Math.max(1, retryAfter || 1)));
  return sendError(res, 429, message);
}

function register(router, deps) {
  const { db, security } = deps;
  const clientIp = createClientIpResolver();

  router.addPublic('GET', '/api/health', (c) => sendJson(c.res, 200, { ok: true, ts: Date.now(), name: 'supervise-desk' }));
  router.addPublic('GET', '/api/status', (c) => {
    const count = userRepo.count(db);
    sendJson(c.res, 200, { bootstrapped: userRepo.countByRole(db, 'admin') > 0, users: count });
  });

  router.addPublic('POST', '/api/auth/setup', (c) => {
    const setupLimit = bucket(setupRequests, `setup:${clientIp(c.req)}`, MAX_SETUP_REQUESTS);
    if (!setupLimit.allowed) return sendRateLimit(c.res, setupLimit.retryAfter, '初始化尝试过于频繁，请稍后再试');
    // 必须持有部署密钥；不能通过删除管理员后抢占公开初始化入口。
    if (userRepo.countByRole(db, 'admin') > 0) return sendError(c.res, 400, '管理员账号已存在，不能重复初始化');
    if (!security.validSetupToken(c.body?.setupToken)) return sendError(c.res, 403, '初始化已锁定或部署密钥不正确，请联系部署人员');
    const { admin } = c.body || {};
    if (!admin?.username || !admin?.password) return sendError(c.res, 400, '管理员账号缺少 username/password');
    if (typeof admin.username !== 'string' || !admin.username.trim() || admin.username.length > 64 || typeof admin.password !== 'string' || admin.password.length < 8 || admin.password.length > 256) return sendError(c.res, 400, '用户名需为1至64字，密码需为8至256字');
    admin.username = admin.username.trim();
    let adm;
    try {
      db.exec('BEGIN IMMEDIATE');
      if (userRepo.countByRole(db, 'admin') > 0) {
        db.exec('ROLLBACK');
        return sendError(c.res, 400, '管理员账号已存在，不能重复初始化');
      }
      adm = makeUser(admin, 'admin');
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      if (String(e.message || '').includes('UNIQUE')) return sendError(c.res, 409, '用户名已存在');
      throw e;
    }
    sendJson(c.res, 200, { ok: true, admin: userRepo.toPublic(adm) });
  });

  router.addPublic('POST', '/api/auth/login', async (c) => {
    const { username, password } = c.body || {};
    const ip = clientIp(c.req);
    // Rate-limit every login request before scrypt runs.  This protects CPU
    // from username spraying, malformed retries and credential stuffing.
    const requestLimit = bucket(loginRequests, `login:${ip}`, MAX_LOGIN_REQUESTS);
    if (!requestLimit.allowed) return sendRateLimit(c.res, requestLimit.retryAfter, '登录请求过于频繁，请稍后再试');
    if (typeof username !== 'string' || !username.trim() || username.length > 64 || typeof password !== 'string' || !password || password.length > 256) return sendError(c.res, 400, '请填写有效的用户名和密码');
    const blocked = loginBlock(ip, username);
    if (blocked.blocked) return sendRateLimit(c.res, blocked.retryAfter, '登录尝试过于频繁，请稍后再试');
    const user = userRepo.byUsername(db, username.trim());
    let verified;
    try { verified = await security.verifyPasswordAsync(user, password); }
    catch (error) { if (error.statusCode === 429) return sendRateLimit(c.res, 1, error.message); throw error; }
    // 异步计算期间账号可能被停用、删除或重置密码，必须重新核验。
    const latest = user && userRepo.byId(db, user.id);
    const blockedDuringVerification = loginBlock(ip, username);
    if (blockedDuringVerification.blocked) return sendRateLimit(c.res, blockedDuringVerification.retryAfter, '登录尝试过于频繁，请稍后再试');
    if (!verified || !latest || latest.status === 0 || latest.password_hash !== user.password_hash) {
      if (!recordLoginFailure(ip, username)) return sendRateLimit(c.res, Math.ceil(FAILURE_WINDOW_MS / 1000), '登录尝试过于频繁，请稍后再试');
      return sendError(c.res, 401, '用户名或密码错误');
    }
    clearLoginFailures(ip, username);
    const token = security.createSession(db, user.id);
    activity.record(db,{actorId:user.id,subjectId:user.id,type:'user_login',summary:'用户登录平台'});
    if (c.req.headers['x-markly-client'] === 'web') {
      security.sessionCookie(c.req, c.res, token);
      return sendJson(c.res, 200, { user: userRepo.toPublic(latest) });
    }
    sendJson(c.res, 200, { token, user: userRepo.toPublic(latest) });
  });

  router.add('POST', '/api/auth/logout', (c) => {
    const { token } = deps.security.authenticate(db, c.req);
    if (token) sessionRepo.remove(db, token);
    if (c.req.headers['x-markly-client'] === 'web') security.sessionCookie(c.req, c.res, null);
    sendJson(c.res, 200, { ok: true });
  });

  router.add('GET', '/api/auth/me', (c) => {
    sendJson(c.res, 200, { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, user: userRepo.toPublic(c.user), unread: noteRepo.unreadCount(db, c.user.id), supervision: c.user.role === 'supervisor' ? { level: c.user.account_level || 'basic', used: userRepo.relationCount(db, c.user.id), capacity: userRepo.supervisorCapacity(db, c.user.id) } : c.user.role === 'supervisee' ? { supervisorIds: userRepo.activeSupervisorIds(db, c.user.id) } : null });
  });

  // 用户列表按“绑定关系”隔离（管理员除外）：绑定后只出现对方；未绑定的监督者可看到未绑定被监督者
  router.add('GET', '/api/people', (c) => {
    const { db, user } = c;
    const people = userRepo.peopleFor(db, user);
    const managedIds = user.role === 'supervisor' ? new Set(userRepo.activeSuperviseeIds(db, user.id)) : null;
    const peopleView = people.map((person) => {
      const relationship = user.role === 'supervisor'
        ? (managedIds.has(person.id) ? 'managed' : 'available')
        : user.role === 'supervisee' ? 'supervisor' : 'related';
      const identity = userRepo.toPublic(person).identity;
      if (relationship === 'available') return { id: person.id, role: person.role, identity, displayName: person.display_name, relationship };
      return { id: person.id, username: person.username, role: person.role, identity, displayName: person.display_name, avatar: person.avatar || '', gender: person.gender || 'unspecified', status: person.status, relationship };
    });
    sendJson(c.res, 200, { people: peopleView });
  });

  function makeUser(u, role) {
    const salt = security.genSalt();
    return userRepo.insert(db, {
      username: u.username,
      role,
      passwordHash: security.hashPassword(u.password, salt),
      salt,
      displayName: u.displayName || u.username,
      createdAt: Date.now(),
    });
  }
}

module.exports = { register };

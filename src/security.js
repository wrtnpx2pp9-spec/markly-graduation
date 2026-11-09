'use strict';
/**
 * 安全模块：密码哈希、会话令牌。不含任何业务逻辑，只提供“加密 / 会话”能力。
 * 依赖注入：通过 db + 仓储访问数据库，避免耦合到架构细节。
 */
const crypto = require('crypto');
const userRepo = require('./repo/user.repo');
const sessionRepo = require('./repo/session.repo');

const SESSION_DAYS = 30;
let activePasswordChecks = 0;

function verifyPasswordAsync(user, password) {
  if (activePasswordChecks >= 4) return Promise.reject(Object.assign(new Error('登录繁忙，请稍后重试'), { statusCode: 429 }));
  activePasswordChecks++;
  // 不存在的账号也执行相同开销的计算，避免简单的账号存在性时间差。
  const valid = user && /^[a-f0-9]{128}$/i.test(user.password_hash);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, valid ? user.salt : 'login-dummy-salt', 64, (error, hash) => {
      activePasswordChecks--;
      if (error) return reject(error);
      resolve(!!valid && crypto.timingSafeEqual(hash, Buffer.from(user.password_hash, 'hex')));
    });
  });
}

function validSetupToken(provided) {
  const configured = process.env.SETUP_TOKEN;
  if (!configured || configured.length < 32 || configured.length > 256 || typeof provided !== 'string' || provided.length > 256) return false;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(configured));
}
function validPlatformAgentSecondaryPassword(provided) {
  const configured = process.env.ADMIN_AGENT_SECONDARY_PASSWORD;
  if (!configured || configured.length < 16 || configured.length > 256 || typeof provided !== 'string' || provided.length > 256) return false;
  const digest = value => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(provided), digest(configured));
}

function genSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function verifyPassword(user, password) {
  if (!user || typeof password !== 'string' || password.length > 256 || !/^[a-f0-9]{128}$/i.test(user.password_hash)) return false;
  const hash = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

function createSession(db, userId, days = SESSION_DAYS) {
  return sessionRepo.create(db, userId, Date.now() + days * 24 * 3600 * 1000);
}

function userByToken(db, token) {
  if (!token) return null;
  const s = sessionRepo.find(db, token);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    sessionRepo.remove(db, token);
    return null;
  }
  const user = userRepo.byId(db, s.user_id);
  return user && user.status !== 0 ? user : null;
}

function authenticate(db, req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('sd_session='))?.slice(11) || null;
  const user = userByToken(db, token);
  return { user, token };
}

function sessionCookie(req, res, token) {
  const secure = req.socket?.encrypted || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `sd_session=${token || ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? SESSION_DAYS * 86400 : 0}${secure ? '; Secure' : ''}`);
}

module.exports = { sessionCookie, genSalt, hashPassword, verifyPassword, verifyPasswordAsync, validSetupToken, validPlatformAgentSecondaryPassword, createSession, userByToken, authenticate };

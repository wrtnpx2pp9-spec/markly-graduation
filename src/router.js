'use strict';
const auditRepo = require('./repo/audit.repo');
const { inputViolation } = require('./content-safety');
/**
 * 极简路由框架（不含任何业务逻辑，只做：路径匹配、鉴权挂载、统一的响应助手）。
 * 业务路由由 src/app.js 通过各个 controller register() 注入。
 */

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[^/]+/g, (m) => {
      keys.push(m.slice(1));
      return '([^/]+)';
    }) + '$'
  );
  return { regex, keys };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendError(res, status, msg) {
  sendJson(res, status, { error: msg });
}

/**
 * createRouter({ db, deps }) -> { add, addPublic, dispatch }
 * - deps.security.authenticate(req) 用于受保护路由的鉴权（逻辑注入，框架不关心其实现）
 */
function createRouter({ db, deps }) {
  // Route registration happens once during boot, while dispatch runs for every
  // API request.  Keeping a bucket per method avoids scanning unrelated
  // routes (especially the many GET routes) on writes without changing the
  // registration order within a method.
  const routesByMethod = new Map();

  function add(method, pattern, handler, opts = {}) {
    const normalizedMethod = method.toUpperCase();
    const pc = compile(pattern);
    const route = {
      method: normalizedMethod, ...pc, handler,
      isPublic: !!opts.isPublic, roles: opts.roles,
    };
    const routes = routesByMethod.get(normalizedMethod) || [];
    routes.push(route);
    routesByMethod.set(normalizedMethod, routes);
  }

  function dispatch(method, pathname, req, res, query, body) {
    method = method.toUpperCase();
    const headers = req.headers || {};
    // JSON arrays, primitives and null are valid JSON, but this API accepts
    // named fields only. Reject them before a controller can call .trim().
    if (['POST', 'PUT', 'PATCH'].includes(method) && (!body || Array.isArray(body) || typeof body !== 'object')) {
      return sendError(res, 400, '请求体必须是 JSON 对象');
    }
    // Cookie writes require a non-simple same-origin browser request, including login.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) &&
        (headers.cookie?.includes('sd_session=') || headers['x-markly-client'] === 'web') &&
        (headers['x-markly-client'] !== 'web' || (headers['sec-fetch-site'] && headers['sec-fetch-site'] !== 'same-origin'))) {
      return sendError(res, 403, '请从本站页面提交操作');
    }
    for (const r of routesByMethod.get(method) || []) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {};
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      } catch { return sendError(res, 400, '路径参数编码不正确'); }

      // Apply one consistent content gate before either public or protected
      // handlers. This covers forms, JSON payloads and query-string inputs.
      const inputError = inputViolation(body) || inputViolation(query);
      if (inputError) return sendError(res, 400, inputError);

      if (!r.isPublic) {
        const { user, token } = deps.security.authenticate(db, req);
        if (!user) return sendError(res, 401, '未登录或会话失效');
        if (headers['x-markly-user'] && headers['x-markly-user'] !== user.id) return sendError(res, 401, '账号已在其他页面切换，请重新登录');
        if (r.roles && !r.roles.includes(user.role)) return sendError(res, 403, '无权限访问');
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          try { auditRepo.record(db, { actorId: user.id, method, path: pathname, ip: req.socket?.remoteAddress }); } catch (error) { console.error('[audit] record error:', error.message); }
        }
        return r.handler({ req, res, query, body, params, user, authToken: token, db, deps });
      }
      return r.handler({ req, res, query, body, params, user: null, db, deps });
    }
    sendError(res, 404, '接口不存在');
  }

  return {
    add,
    addPublic: (method, pattern, handler) => add(method, pattern, handler, { isPublic: true }),
    addRole: (method, pattern, handler, roles) => add(method, pattern, handler, { roles }),
    dispatch,
  };
}

module.exports = { createRouter, sendJson, sendError };

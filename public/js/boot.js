/* Markly · 启动入口 */
'use strict';

// ---------- 启动 ----------
let bootPending = false;
async function bootApp() {
  if (bootPending) return;
  bootPending = true;
  let session=token,userId=me?.id;
  const current=()=>session===token&&userId===me?.id;
  $app.innerHTML = '<main class="startup-state" data-startup role="status" aria-live="polite"><span class="auth-mark" aria-hidden="true">M</span><h1>Markly</h1><p>正在准备你的页面…</p></main>';
  try {
    const status = await api('GET', '/api/status');
    if(!current())return;
    if (status.bootstrapped) {
      const meRes = await api('GET', '/api/auth/me');
      if(!current())return;
      if (!meRes.__unauth && meRes.user) {
        setToken(token, meRes.user);
        session=token;userId=me?.id;
        await loadAll();
        if(!current())return;
        routeProfileHash();
        startPolling();
        if (networkOnline) clearNetworkStatus();
        return;
      }
    }
    if (!status.bootstrapped) renderSetup();
    else renderLogin();
    if (networkOnline) clearNetworkStatus();
  } catch (e) {
    if(!current())return;
    // A 401 already renders the login form in the request layer. Other read
    // failures need a real startup retry, including one-time initialization.
    if (!document.getElementById('li-user')) {
      $app.innerHTML = `<main class="startup-state" data-startup><span class="auth-mark" aria-hidden="true">M</span><h1>页面暂时无法加载</h1><p role="alert">${esc(e.message || '请稍后重试')}</p><button type="button" class="btn" id="startup-retry">重新加载</button></main>`;
      document.getElementById('startup-retry').onclick = bootApp;
    }
  } finally {
    bootPending = false;
  }
}
bootApp();

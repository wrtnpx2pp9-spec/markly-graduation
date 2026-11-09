/* Markly · 认证视图：初始化 / 登录 */
'use strict';

function wirePasswordToggle(buttonId, inputId) {
  const button = document.getElementById(buttonId), input = document.getElementById(inputId);
  if (!button || !input) return;
  button.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  };
}

// ---------- 认证视图 ----------
function renderSetup() {
  document.body.classList.remove('has-tabbar'); document.body.dataset.role = 'guest';
  $app.innerHTML = `
  <div class="authwrap">
    <form class="authcard card" id="setup-form">
      <div class="authlogo">Markly</div>
      <div class="authsub">创建管理员账号</div>
      <label for="adm-user">用户名</label><input id="adm-user" name="username" value="admin" autocomplete="username" autocapitalize="none" spellcheck="false" required />
      <label for="adm-name">显示名称</label><input id="adm-name" name="displayName" value="管理员" autocomplete="nickname" />
      <label for="adm-pass">密码</label><div class="password-field"><input id="adm-pass" name="password" type="password" autocomplete="new-password" required /><button class="password-toggle" type="button" id="setup-password-toggle" aria-label="显示密码" aria-controls="adm-pass" aria-pressed="false">显示</button></div>
      <label for="setup-token">部署密钥</label><input id="setup-token" type="password" autocomplete="off" maxlength="256" required aria-describedby="setup-help" />
      <p class="muted" id="setup-help">请向部署人员获取密钥。</p>
      <div class="err" id="setup-err" role="alert"></div>
      <button class="btn block" id="setup-btn" type="submit">创建并进入</button>
    </form>
  </div>`;
  wirePasswordToggle('setup-password-toggle', 'adm-pass');
  const form = $('#setup-form');
  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $('#setup-btn');
    if (button.disabled) return;
    let session=token;
    const current=()=>session===token&&form.isConnected&&$('#setup-form')===form;
    const admin = {
      username: $('#adm-user').value.trim(),
      password: $('#adm-pass').value,
      displayName: $('#adm-name').value.trim(),
    };
    $('#setup-err').textContent = '';
    if (!admin.username || !admin.password) {
      $('#setup-err').textContent = '管理员账号必须填写用户名和密码'; return;
    }
    button.disabled = true; button.textContent = '正在创建…'; form.setAttribute('aria-busy', 'true');
    try {
      await api('POST', '/api/auth/setup', { admin, setupToken: $('#setup-token').value });
      if(!current())return;
      const login = await api('POST', '/api/auth/login', { username: admin.username, password: admin.password });
      if(!current())return;
      setToken(login.token, login.user);
      session=token;
      await loadAll();
      if(!current())return;
      routeProfileHash();
    } catch (e) { if (current()&&$('#setup-err')) $('#setup-err').textContent = e.message; }
    finally { button.disabled = false; button.textContent = '创建并进入'; form.removeAttribute('aria-busy'); }
  };
}

function renderLogin(message = '') {
  document.body.classList.remove("has-tabbar"); document.body.dataset.role="guest";
  $app.innerHTML = `
  <div class="authwrap login-wrap">
    <section class="auth-intro" aria-labelledby="auth-heading">
      <div class="auth-wordmark"><span class="auth-mark" aria-hidden="true">M</span> Markly</div>
      <p class="auth-eyebrow">生活记录 · 学习监督</p>
      <h1 id="auth-heading">把想做的事，<br/>变成每天的进步。</h1>
    </section>
    <form class="authcard card" id="login-form" aria-labelledby="login-heading">
      <div class="authlogo">Markly</div>
      <h2 id="login-heading">欢迎回来</h2>
      <label for="li-user">用户名</label><input id="li-user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="输入用户名" />
      <label for="li-pass">密码</label><div class="password-field"><input id="li-pass" name="password" type="password" autocomplete="current-password" required placeholder="输入密码" /><button class="password-toggle" type="button" id="login-password-toggle" aria-label="显示密码" aria-controls="li-pass" aria-pressed="false">显示</button></div>
      <div class="err" id="li-err" role="alert">${esc(typeof message === 'string' ? message : '')}</div>
      <button class="btn block" id="li-btn" type="submit">登录</button>
      <div class="switch"><button class="linkbtn" id="li-register" type="button">申请注册</button><button class="linkbtn" id="li-registration-status" type="button">查询申请</button></div>
    </form>
  </div>`;
  $('#li-register').onclick=renderRegistration;
  $('#li-registration-status').onclick=()=>renderRegistrationStatus();
  wirePasswordToggle('login-password-toggle', 'li-pass');
  const form = $('#login-form');
  const doLogin = async (event) => {
    event.preventDefault();
    const button = $('#li-btn');
    if (button.disabled) return;
    let session=token;
    const current=()=>session===token&&form.isConnected&&$('#login-form')===form;
    const switches = [...form.querySelectorAll('.switch button')];
    button.disabled = true; button.textContent="正在登录…"; form.setAttribute('aria-busy', 'true');
    switches.forEach(control => { control.disabled = true; });
    $('#li-err').textContent = '';
    try {
      const d = await api('POST', '/api/auth/login', { username: $('#li-user').value.trim(), password: $('#li-pass').value });
      if(!current())return;
      setToken(d.token, d.user);
      session=token;
      await loadAll();
      if(!current())return;
      routeProfileHash();
    } catch (e) { if (current()&&$('#li-err')) $('#li-err').textContent = e.message; }
    finally { button.disabled = false; button.textContent="登录"; form.removeAttribute('aria-busy'); switches.forEach(control => { control.disabled = false; }); }
  };
  form.onsubmit = doLogin;
}

function setToken(t, u) {
  advanceSession(); me = u;
  localStorage.removeItem(tokenKey);
  startPolling();
}

// ---------- 数据加载 ----------
let allLoadSerial=0,adminLoadSerial=0;
async function loadAll() {
  const serial=++allLoadSerial,session=token,userId=me?.id;
  const current=()=>serial===allLoadSerial&&session===token&&userId===me?.id;
  const meRes = await api('GET', '/api/auth/me');
  if (!current()||meRes.__unauth||meRes.user?.id!==userId) return;
  serviceTimezone = meRes.timezone || serviceTimezone;
  me = meRes.user; me.supervision = meRes.supervision; unread = meRes.unread || 0;
  if (me.role !== 'admin') { const pp = await api('GET', '/api/people');if(!current())return; people = pp.people; }
  // 浏览器刷新后留在用户刚才所在的页面，尤其是「目标」页不能被重置回今天。
  const savedView = sessionStorage.getItem(viewStorageKey());
  const publicViews = ['history', 'dashboard', 'work', 'tasks', 'market', 'my', 'life', 'notes', 'settings'];
  if (me.role === 'supervisor') publicViews.push('supervisees');
  st.view = me.role === 'admin' ? 'overview' : (publicViews.includes(savedView) ? savedView : 'dashboard');
  if (me.role === 'admin') st.view = normalizeView(savedView);
  if (me.role !== 'admin') await loadSection();
}

async function loadAdmin() {
  const serial=++adminLoadSerial,session=token,userId=me?.id;
  const [o, users] = await Promise.all([
    api('GET', '/api/admin/overview'),
    apiAll('/api/admin/users', 'users'),
  ]);
  if(serial!==adminLoadSerial||session!==token||userId!==me?.id)return;
  st.admin = { overview: o, users };
}
async function refreshAdminOverview() {
  const session=token,userId=me?.id;
  const overview = await api('GET', '/api/admin/overview?fresh=1');
  if(session!==token||userId!==me?.id)return;
  st.admin = { ...(st.admin || {}), overview };
  return overview;
}
function patchAdminUser(user, extra = {}) {
  if (!user) return;
  const current = st.admin?.users || [];
  const index = current.findIndex(item => item.id === user.id);
  const next = { ...(index >= 0 ? current[index] : {}), ...user, ...extra };
  const users = index >= 0 ? current.map(item => item.id === user.id ? next : item) : [next, ...current];
  st.admin = { ...(st.admin || {}), users };
}
function removeAdminUser(id) {
  if (!st.admin) return;
  st.admin = { ...st.admin, users: (st.admin.users || []).filter(user => user.id !== id) };
}

let sectionLoadSerial=0,notesLoadSerial=0,lifeLoadSerial=0;
let notesWindowReadSerial=0,notesWindowAppliedSerial=0;
async function loadSection() {
  const serial=++sectionLoadSerial,session=token,userId=me?.id;
  const [tasks, plans, work] = await Promise.all([
    // 首屏只拉取进行中/待处理和最近 90 天的已结束记录；完整历史按需进入历史页。
    apiAll('/api/tasks?window=recent', 'tasks'),
    apiAll('/api/plans?window=recent', 'plans'),
    api('GET', '/api/me/worklist'),
  ]);
  if(serial!==sectionLoadSerial||session!==token||userId!==me?.id)return;
  st.tasks = tasks;
  st.plans = plans;
  st.workDays = work.days || [];
  st._pd = {};
  st.sectionLoadedAt = Date.now();
}
function sectionFresh(maxAgeMs = 20000) {
  return !!st.sectionLoadedAt && Date.now() - st.sectionLoadedAt < maxAgeMs;
}
function observeNotificationWindow(rows, { notify = true } = {}) {
  const latestAt = st.lastSeenNoteAt || 0;
  const latestIds = new Set(st.lastSeenNoteIds || []);
  const initialized = st.notesBaselineLoaded ?? latestAt > 0;
  // An empty first response still establishes the baseline. IDs distinguish
  // reminders created in the same millisecond without keeping every old ID.
  const incoming = rows.filter(row => !row.isRead && (row.createdAt > latestAt
    || row.createdAt === latestAt && !latestIds.has(row.id)));
  if (notify && initialized && incoming.length) maybeDesktopNotify(incoming);
  const nextAt = rows.reduce((max, row) => Math.max(max, row.createdAt), latestAt);
  st.lastSeenNoteAt = nextAt;
  st.lastSeenNoteIds = [...new Set([
    ...(nextAt === latestAt ? latestIds : []),
    ...rows.filter(row => row.createdAt === nextAt).map(row => row.id),
  ])];
  st.notesBaselineLoaded = true;
}
async function loadNotes(offset=0,{preserveOlder=false}={}) {
  const serial=++notesLoadSerial,readSerial=++notesWindowReadSerial,revision=notesReadRevision,session=token,userId=me?.id;
  const n = await api('GET', '/api/notifications?limit=100&offset='+offset);
  if(serial!==notesLoadSerial||revision!==notesReadRevision||session!==token||userId!==me?.id)return;
  const fresh=readSerial>=notesWindowAppliedSerial;
  // Older pages still belong in the feed, but a delayed page must not rewind
  // a newer recent window's read flags or its full-account unread count.
  const knownIds=new Set(st.notes.map(row=>row.id));
  const rows=fresh?n.notifications:n.notifications.filter(row=>!knownIds.has(row.id));
  st.notes = offset||preserveOlder||!fresh?mergeNotes(st.notes,rows):rows;
  if(!preserveOlder)st.notesNextOffset=n.nextOffset??null;
  if(!fresh)return;
  notesWindowAppliedSerial=readSerial;
  observeNotificationWindow(rows, { notify: !offset });
  unread = n.unread;
  updateBadge();
}
async function loadLife(offset=0) {
  const serial=++lifeLoadSerial,session=token,userId=me?.id;
  const l = await api('GET', '/api/life?limit=100&offset='+offset);
  if(serial!==lifeLoadSerial||session!==token||userId!==me?.id)return;
  st.logs = offset?[...new Map([...st.logs,...l.logs].map(row=>[row.id,row])).values()]:l.logs;
  st.lifeNextOffset=l.nextOffset??null;
}

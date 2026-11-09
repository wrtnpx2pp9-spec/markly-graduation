/* Markly · 应用外壳：管理后台左侧边栏 / 普通用户顶栏 / 视图路由 / 退出 */
'use strict';

const SIDEBAR_ITEMS = [
  { k: 'overview', label: '平台总览', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="8" height="8" rx="2.2"/><rect x="13" y="3" width="8" height="8" rx="2.2"/><rect x="3" y="13" width="8" height="8" rx="2.2"/><rect x="13" y="13" width="8" height="8" rx="2.2"/></svg>' },
  { k: 'users', label: '用户管理', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.6"/><path d="M3.2 19.2c.8-3.1 3.1-4.8 5.8-4.8s5 1.7 5.8 4.8"/><circle cx="16.8" cy="9.2" r="2.8"/><path d="M16.6 14.7c2 .5 3.5 1.9 4 4"/></svg>' },
  { k: 'market', label: '监督者广场', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="4.5"/><path d="M16.8 20.6c-1.5-2.4-3.6-3.4-5.8-3.4s-4.3 1-5.8 3.4"/><path d="M19.5 9.9c0 4.7-3.8 8.5-8.5 8.5S2.5 14.6 2.5 9.9"/></svg>' },
  { k: 'platform-agent', label: '平台 Pi', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 10h.01M16 10h.01M8 15c1.1.8 2.4 1.2 4 1.2s2.9-.4 4-1.2"/></svg>' },
];

const ICON_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 20H6.5A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4h3"/><path d="M15.5 16.5 20 12l-4.5-4.5"/><path d="M20 12h-11"/></svg>';
let mobileNavScrollBound = false;
let lastAnimatedView = '';

// On a phone the fixed tab bar can cover the last action in long cards. Hide
// it while reading downward and reveal it immediately when the user scrolls
// back up; desktop navigation is unaffected.
function enableMobileNavAutoHide() {
  if (mobileNavScrollBound) return;
  mobileNavScrollBound = true;
  let previousY = window.scrollY;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const currentY = window.scrollY;
      const mobile = window.matchMedia('(max-width: 600px)').matches;
      if (!mobile || !document.body.classList.contains('has-tabbar') || document.querySelector('#modal .dialog')) {
        document.body.classList.remove('tabbar-collapsed');
      } else if (currentY < 32 || currentY < previousY - 8) {
        document.body.classList.remove('tabbar-collapsed');
      } else if (currentY > previousY + 12) {
        document.body.classList.add('tabbar-collapsed');
      }
      previousY = currentY;
      ticking = false;
    });
  }, { passive: true });
}

function allowedViews() {
  return me?.role === 'admin'
    ? ['overview', 'users', 'registrations', 'market', 'platform-agent', 'certifications', 'my', 'profile']
    : ['intake', 'history', 'dashboard', 'tasks', 'market', 'my', 'profile', 'requests', 'request', 'life', 'notes', 'settings', ...(me?.role === 'supervisor' ? ['supervisees'] : [])];
}
function normalizeView(view) {
  if (view === 'work') view = 'dashboard';
  return allowedViews().includes(view) ? view : (me?.role === 'admin' ? 'overview' : 'dashboard');
}
function viewStorageKey() { return 'sd_last_view:' + me.id; }
function setPublicView(view) {
  st.view = normalizeView(view);
  if (me) sessionStorage.setItem(viewStorageKey(), st.view);
}
function routeHash() {
  const id = st.view === 'profile' ? st.profileId : st.view === 'request' ? st.requestId : null;
  return '#' + st.view + (id ? '/' + encodeURIComponent(id) : '');
}
function goView(view) {
  if (!me) return;
  if(view==='notes' && st.view!=='notes') st.notesReturn=st.view;
  setPublicView(view);
  const hash = routeHash();
  if (location.hash !== hash) history.pushState(null, '', location.pathname + location.search + hash);
  closeModal();
  if (typeof document !== 'undefined') document.body.classList.remove('tabbar-collapsed');
  renderApp();
  window.scrollTo(0, 0);
}
// Also supports the original shared #profile/<id> links.
function routeProfileHash() {
  if (!me) return;
  try {
    const parts = location.hash.slice(1).split('/');
    const view = normalizeView(parts[0] || st.view);
    if (['profile', 'request'].includes(view)) {
      if (parts.length !== 2 || !parts[1]) throw new Error('页面链接不完整');
      st[view === 'profile' ? 'profileId' : 'requestId'] = decodeURIComponent(parts[1]);
    }
    setPublicView(view);
  } catch (error) { setPublicView('dashboard'); toast(error.message); }
  history.replaceState(null, '', location.pathname + location.search + routeHash());
  closeModal();
  renderApp();
}
window.addEventListener('popstate', routeProfileHash);
window.addEventListener('hashchange', () => {
  if (me && location.hash !== routeHash()) routeProfileHash();
});

async function refreshTasksInPlace() {
  const content = document.getElementById('content');
  const scrollTop = window.scrollY;
  try {
    await loadSection();
    if (st.view !== 'tasks' || !content?.isConnected) return;
    renderTasks(content);
    window.scrollTo(0, scrollTop);
  } catch (error) { toast(error.message); }
}

// Retry the current read view as well as the failed request. Keep any open
// editor intact: refreshing data must never resubmit or discard its draft.
async function reloadNetworkView() {
  if (document.querySelector('[data-startup]')) {
    if (typeof bootApp === 'function') await bootApp();
    return;
  }
  if (!me || !document.getElementById('content')) return;
  const generation=token,view=st.view,content=document.getElementById('content');
  const fields=[...content.querySelectorAll('input[id],textarea[id],select[id]')]
    .map(el=>({id:el.id,value:el.value,checked:el.checked}));
  if(me.role!=='admin')await loadSection();
  if(view==='notes')await loadNotes();
  if(view==='life')await loadLife();
  if(generation!==token||view!==st.view||!content.isConnected)return;
  renderView();
  for(const saved of fields){
    const field=document.getElementById(saved.id);
    if(field&&content.contains(field)){field.value=saved.value;field.checked=saved.checked;}
  }
}

// ---------- 主应用 ----------
function renderApp() {
  document.body.classList.remove('has-tabbar');
  document.body.dataset.role = me?.role || 'guest';
  if (!me) { renderLogin(); return; }
  setPublicView(st.view);
  document.body.dataset.pageView=st.view;
  if(me.role!=='admin'&&st.view==='intake') { $app.innerHTML='<main id="content"></main>';renderView();return; }
  const isAdmin = me.role === 'admin';

  if (isAdmin) {
    // 管理后台：左侧毛玻璃边栏 + 内容区
    $app.innerHTML = `
    <div class="app-shell">
      <aside class="side">
        <div class="side-brand"><span class="app-ico"></span><b>Markly</b></div>
        <nav class="side-nav">
          ${SIDEBAR_ITEMS.map((it) => `
            <button data-view="${it.k}" class="side-item ${st.view === it.k ? 'active' : ''}">
              ${it.icon}<span>${it.label}</span>
            </button>`).join('')}
        </nav>
        <div class="side-foot">
          <div class="side-user">
            <span class="avatar">${esc(String(me.displayName || 'A').slice(0, 1))}</span>
            <div class="su-txt"><b>${esc(me.displayName)}</b><i>${esc(roleLabel(me.role,me.identity))}</i></div>
          </div>
          <button class="side-out" data-action="logout">${ICON_LOGOUT}<span>退出登录</span></button>
        </div>
      </aside>
      <div class="side-main"><main id="content"></main></div>
    </div>`;
  } else {
    // 普通用户：移动优先 —— 顶栏(品牌+账户) + 底部玻璃导航
    document.body.classList.add('has-tabbar');
    enableMobileNavAutoHide();
    const isSup = me.role === 'supervisor';
    const labels = { dashboard: '待处理', tasks: '目标', my: '我的' };
    const icons = {
      dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.2 12 4l8 7.2"/><path d="M6 10.5V20h12v-9.5"/><path d="M10 20v-5h4v5"/></svg>',
      tasks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8.5 9.5 10 11l3-3"/><path d="M8.5 14 10 15.5l3-3"/></svg>',
      supervisees: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.4"/><path d="M3.6 19c.9-2.8 3-4.4 5.4-4.4s4.5 1.6 5.4 4.4"/><circle cx="16.6" cy="9.2" r="2.6"/><path d="M16.8 14.7c1.8.5 3.1 1.8 3.7 3.9"/></svg>',
      life: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4"/></svg>',
      notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9a6 6 0 0 1 12 0v4l1.5 2.8H4.5L6 13z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
      settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/></svg>',
    };
    $app.innerHTML = `
    <header class="topbar">
      <div class="brand">Markly</div>
      ${['market','notes','supervisees'].includes(st.view)?'<button class="page-back secondary-back" id="secondary-back">← 返回'+(st.view==='notes'?'上一页':'我的')+'</button>':''}
      <div class="userbox">
        <button class="ghost" id="top-notes">消息 <span data-badge>${unread||''}</span></button>
        <button class="account-button" id="top-account" aria-label="进入我的主页">${avatarHTML(me)}</button>
      </div>
    </header>
    <main id="content"></main>
    <nav class="tabbar">
      ${Object.entries(labels).map(([k, v]) => `
        <button data-view="${k}" class="${st.view === k || (k === 'dashboard' && st.view === 'work') ? 'active' : ''}">${icons[k] || icons[k==='market'?'supervisees':'settings']}<span>${v}</span>
          ${k === 'notes' ? `<span class="badge ${unread ? 'show' : ''}" data-badge>${unread}</span>` : ''}
        </button>`).join('')}
    </nav>`;
  }

  $app.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => { goView(b.dataset.view); };
  });
  $app.querySelectorAll('.tabbar button').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.view === 'tasks' && st.view === 'tasks') { refreshTasksInPlace(); return; }
      goView(b.dataset.view);
    };
  });
  $app.querySelectorAll('.side-item').forEach((b) => {
    b.onclick = () => { goView(b.dataset.view); };
  });
  const lg = $app.querySelector('[data-action="logout"]');
  if($('#secondary-back'))$('#secondary-back').onclick=()=>goView(st.view==='notes'&&st.notesReturn&&st.notesReturn!=='notes'?normalizeView(st.notesReturn):'my');
  if($('#top-notes'))$('#top-notes').onclick=()=>goView('notes');
  if($('#top-account'))$('#top-account').onclick=()=>goView('my');
  if (lg) lg.onclick = doLogout;
  const content = document.getElementById('content');
  renderView();
  if (st.view === 'notes') loadNotes().then(()=>{if(st.view==='notes' && document.getElementById('content') === content)renderView();}).catch(e=>toast(e.message));
  if (st.view === 'life') loadLife().then(()=>{if(st.view==='life' && document.getElementById('content') === content)renderView();}).catch(e=>toast(e.message));
  if (st.view === 'tasks') loadSection().then(()=>{if(st.view==='tasks' && document.getElementById('content') === content)renderView();}).catch(e=>toast(e.message));
}

async function doLogout() {
  openModal('暂时离开 Markly？', '<div class="logout-art">↗</div><p class="logout-copy">已保存的记录会留在这里。下次登录，继续你的进展。</p>', async () => {
    await api('POST', '/api/auth/logout');
    closeModal(); logoutLocal(); renderLogin();
  });
  $('#modal-ok').textContent='退出登录';
  $('#modal-cancel').textContent='继续使用';
}

// 视图切换后的轻量过渡；数据刷新保持当前位置，不重播整页动画。
function animIn(el) {
  el.classList.remove('anim-in');
  void el.offsetWidth; // 强制重排，让动画每次都能重放
  el.classList.add('anim-in');
}

function renderView() {
  if (st.view === 'work') setPublicView('dashboard');
  const c = document.getElementById('content');
  if (!c) return;
  if (me.role === 'admin') {
    if (st.view === 'registrations') renderRegistrations(c);
    else if (st.view === 'certifications') renderCertificationAdmin(c);
    else if (st.view === 'market') renderMarket(c);
    else if (st.view === 'my') renderMy(c);
    else if (st.view === 'profile') renderProfile(c,st.profileId||me.id);
    else if (st.view === 'overview') renderAdminOverview(c);
    else if (st.view === 'users') renderAdminUsers(c);
    else if (st.view === 'platform-agent') renderPlatformAgent(c);
    else { st.view = 'overview'; renderAdminOverview(c); }
  } else if (st.view === 'dashboard') {
    if (me.role === 'supervisor') renderSupervisorHome(c);
    else renderSuperviseeHome(c);
    const workSection = document.createElement('section');
    workSection.id = 'home-work';
    c.querySelector('.home-hero')?.after(workSection);
    renderWorkHome(workSection);
  }
  else if (st.view === 'intake') renderIntake(c);
  else if (st.view === 'market') renderMarket(c);
  else if (st.view === 'my') renderMy(c);
  else if (st.view === 'profile') renderProfile(c,st.profileId||me.id);
  else if (st.view === 'history') renderCooperationHistory(c);
  else if (st.view === 'requests') renderRequests(c);
  else if (st.view === 'request') renderRequest(c,st.requestId);
  else if (st.view === 'supervisees' && me.role === 'supervisor') renderSuperviseesView(c);
  else if (st.view === 'tasks') renderTasks(c);
  else if (st.view === 'life') renderLife(c);
  else if (st.view === 'notes') renderNotes(c);
  else if (st.view === 'settings') renderSettings(c);
  const animationKey = [token, me.id, st.view, st.view === 'profile' ? st.profileId : st.view === 'request' ? st.requestId : ''].join(':');
  if (animationKey !== lastAnimatedView) {
    lastAnimatedView = animationKey;
    animIn(c);
  } else c.classList.remove('anim-in');
}

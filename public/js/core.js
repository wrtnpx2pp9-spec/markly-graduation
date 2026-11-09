/* Markly · 核心层：状态 / API / 工具 / 弹窗组件 / 通知轮询 */
'use strict';

'use strict';
/* Markly front-end */

const $app = document.getElementById('app');
const $modal = document.getElementById('modal');
const $ = (sel) => document.querySelector(sel);   // 前端取元素助手（不要再依赖 jQuery 的 $）
const tokenKey = 'sd_token';

localStorage.removeItem(tokenKey); // Remove legacy script-readable credentials.
let token = ''; // In-memory session generation, never a credential.
let sessionGeneration = 0;
function advanceSession() { token = String(++sessionGeneration); }
function sessionChangedError() {
  return Object.assign(new Error('会话已变化，请重新打开页面'), { code: 'session_changed' });
}
let me = null;               // 当前登录用户 {id,username,role,displayName}
let unread = 0;
let people = [];
let st = {
  view: 'dashboard',
  tasks: [],          // 当前角色可见的全部任务
  plans: [],
  filterPlan: null,
  filterStatus: 'all',
  supervisorGoalPerson: 'all',
  supervisorGoalStatus: 'all',
  logs: [],
  notes: [],
  cfg: {},
  lastSeenNoteAt: 0,
  lastSeenNoteIds: [],
  notesBaselineLoaded: false,
  rank: { scope: 'group', dim: 'checkin' },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- 网络状态与请求去重 ----------
// 手机网络会在 Wi-Fi、蜂窝网络和后台恢复之间频繁切换。写操作不能自动重放，
// 否则可能重复创建计划或重复提交打卡；相同的并发写入则共用同一个请求。
const inFlightWrites = new Map();
let networkRetry = null;
let networkOnline = true;

function networkStatusNode() {
  if (typeof document === 'undefined' || !document.body) return null;
  let node = document.getElementById('network-status');
  if (node) return node;
  node = document.createElement('aside');
  node.id = 'network-status';
  node.className = 'network-status';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.hidden = true;
  const text = document.createElement('span');
  text.className = 'network-status-text';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'network-retry';
  retry.textContent = '重新加载';
  retry.hidden = true;
  retry.onclick = async () => {
    const action = networkRetry;
    if (!action) return;
    retry.disabled = true;
    try { await action(); }
    catch (_) { /* 请求层会更新状态提示。 */ }
    finally { retry.disabled = false; }
  };
  node.append(text, retry);
  document.body.append(node);
  return node;
}

function showNetworkStatus(message, retry = null) {
  const node = networkStatusNode();
  if (!node) return;
  networkRetry = retry;
  node.querySelector('.network-status-text').textContent = message;
  const button = node.querySelector('.network-retry');
  button.hidden = !retry;
  node.hidden = false;
}

function clearNetworkStatus() {
  networkRetry = null;
  const node = typeof document === 'undefined' ? null : document.getElementById('network-status');
  if (node) node.hidden = true;
}

function initNetworkStatus() {
  if (typeof window === 'undefined') return;
  networkOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
  if (!networkOnline) showNetworkStatus('当前处于离线状态；请保留当前页面，恢复网络后再操作。');
  window.addEventListener('offline', () => {
    networkOnline = false;
    showNetworkStatus('当前处于离线状态；请保留当前页面，恢复网络后再操作。');
  });
  window.addEventListener('online', () => {
    networkOnline = true;
    if (networkRetry) showNetworkStatus('网络已恢复，可以重新加载。', networkRetry);
    else clearNetworkStatus();
  });
}

// ---------- 请求 ----------
function api(method, path, body, extraHeaders) {
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const key = isWrite ? `${token}\n${method}\n${path}\n${JSON.stringify(body)}` : null;
  if (key && inFlightWrites.has(key)) return inFlightWrites.get(key);
  const request = apiRequest(method, path, body, extraHeaders);
  if (key) {
    inFlightWrites.set(key, request);
    request.then(() => inFlightWrites.delete(key), () => inFlightWrites.delete(key));
  }
  return request;
}

async function apiRequest(method, path, body, extraHeaders) {
  const requestToken=token,requestUserId=me?.id;
  const current=()=>requestToken===token&&requestUserId===me?.id;
  const headers = { 'X-Markly-Client': 'web' };
  if (me) headers['X-Markly-User'] = me.id;
  Object.assign(headers, extraHeaders || {});
  const opts = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res;
  try {
    res = await fetch(path, opts);
  } catch (_) {
    if(!current())throw sessionChangedError();
    const canRetry = method === 'GET';
    const retry = canRetry ? async () => {
      if (!current()) return;
      await api(method, path, body, extraHeaders);
      if (typeof reloadNetworkView === 'function') await reloadNetworkView();
      if (networkOnline) clearNetworkStatus();
    } : null;
    showNetworkStatus(canRetry
      ? '网络连接不可用，请恢复网络后重新加载。'
      : '网络连接中断，当前提交不会自动重试；请检查结果后再次提交。', retry);
    const error = new Error(canRetry ? '网络不可用，请恢复网络后重试加载' : '网络中断，提交结果未知，请恢复网络后刷新确认');
    error.code = 'network';
    throw error;
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if(!current())throw sessionChangedError();
  if (res.status === 401 && !['/api/auth/login', '/api/auth/setup'].includes(path)) {
    const wasSignedIn = !!me;
    logoutLocal();
    renderLogin(wasSignedIn ? '登录已失效，请重新登录后继续。' : '');
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok) {
    const error = new Error((data && data.error) || ('请求失败 ' + res.status));
    error.status = res.status;
    throw error;
  }
  return data;
}

async function apiAll(path, key, pageSize = 200) {
  const session=token,userId=me?.id;
  const current=()=>session===token&&userId===me?.id;
  const rows = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    if(!current())throw sessionChangedError();
    const separator = path.includes('?') ? '&' : '?';
    const data = await api('GET', `${path}${separator}limit=${pageSize}&offset=${offset}`);
    if(!current())throw sessionChangedError();
    if (data.__unauth) return rows;
    rows.push(...(data[key] || []));
    if (data.nextOffset == null || data.nextOffset <= offset) break;
    offset = data.nextOffset;
  }
  return rows;
}

function logoutLocal() {
  clearNetworkStatus();
  closeModal();
  st.filterPlan = null; st.filterStatus = 'all';
  st.profileId = null; st.profileReturn = null; st.requestId = null;
  st.history = null;
  st.admin = null; st.cfg = {}; st.platformPiReauth = '';
  st.adminSupervisorDirectory = null; st.adminPage = null;
  st.registrationStatus = 'pending'; st.certUserId = ''; st.certStatus = 'pending';
  st.supervisorGoalPerson = 'all'; st.supervisorGoalStatus = 'all';
  advanceSession();
  localStorage.removeItem(tokenKey);
  me = null;
  unread = 0; st.lastSeenNoteAt = 0; st.lastSeenNoteIds = []; st.notesBaselineLoaded = false;
  notesReadRevision++;
  _pollInFlight = null;
  st.notesNextOffset=null;st.lifeNextOffset=null;
  people=[]; st.tasks=[]; st.plans=[]; st._pd={}; st.notes=[]; st.logs=[]; st.workDays=[]; st.sectionLoadedAt=0;
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

// ---------- 工具 ----------
function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function dismissWithMotion(node, onRemoved) {
  if (prefersReducedMotion() || !node.classList) { node.remove(); onRemoved?.(); return; }
  let timer;
  const remove = () => {
    clearTimeout(timer);
    node.removeEventListener('animationend', finish);
    node.remove();
    onRemoved?.();
  };
  const finish = event => { if (event.target === node) remove(); };
  node.classList.add('is-leaving');
  node.addEventListener('animationend', finish);
  // Cleanup still runs when a stylesheet is unavailable or animation is cancelled.
  timer = setTimeout(remove, 240);
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role','status');
  t.setAttribute('aria-live','polite');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => dismissWithMotion(t), 2600);
}
function roleLabel(r, identity) {
  if (r === 'supervisor' && identity === 'mentor') return 'Mentor';
  if (r === 'supervisee' && identity === 'mentee') return 'Mentee';
  if (r === 'supervisor') return 'Supervisor';
  if (r === 'supervisee') return 'Supervisee';
  if (r === 'admin') return '管理员';
  return r || '';
}
function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', { timeZone: serviceTimezone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('zh-CN', { timeZone: serviceTimezone, year: 'numeric', month: '2-digit', day: '2-digit' });
}
// Calendar days and wall-clock inputs use the deployment's published business timezone.
let serviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
function toLocalInput(ts) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone:serviceTimezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ts)).map(p=>[p.type,p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function fromLocalInput(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('请填写有效的日期和时间');
  const wall = Date.parse(value + ':00Z');
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0,16) !== value) throw Error('日期不正确');
  let ts = wall;
  for (let i=0;i<4;i++) {
    const delta = wall - Date.parse(toLocalInput(ts) + ':00Z');
    if (!delta) return ts;
    ts += delta;
  }
  throw Error('该时间在日程时区不存在，请调整时间');
}
function todayStr() { return toLocalInput(Date.now()).slice(0,10); }
function isOverdue(t) { return t.status === 'pending' && t.dueAt && t.dueAt < Date.now(); }
function personName(id) {
  const p = people.find((x) => x.id === id);
  return p ? p.displayName : '…';
}

// ---------- 弹窗组件（.overlay + .dialog + .dlg-actions） ----------
// openModal(title, bodyHTML, onOk)：onOk 为「确定」按钮回调（自行负责校验、调 API、成功后调用 closeModal）。
let modalReturnFocus = null;
let modalReadSerial = 0;
const leavingModalNodes = new Set();
function modalReadGuard() {
  const serial=++modalReadSerial,session=token,view=st.view;
  return ()=>serial===modalReadSerial&&session===token&&view===st.view;
}
function modalKeys(e) {
  const dialog = $modal.querySelector('.dialog');
  if (!dialog) return;
  if (e.key === 'Escape') { e.preventDefault(); closeModal(); return; }
  if (e.key !== 'Tab') return;
  const controls = [...dialog.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length);
  const first = controls[0] || dialog, last = controls.at(-1) || dialog;
  if (e.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) { e.preventDefault(); first.focus(); }
}
function openModal(title, body, onOk) {
  // A replacement can open immediately, without sharing IDs or focus with its exit image.
  for (const node of leavingModalNodes) node.remove();
  leavingModalNodes.clear();
  modalReadSerial++;
  if (!$modal.querySelector('.dialog')) modalReturnFocus = document.activeElement;
  $app.inert = true;
  document.addEventListener('keydown', modalKeys);

  $modal.innerHTML = `
    <div class="overlay">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
        <h3 id="modal-title">${esc(title)}</h3>
        ${body}
        ${/type="(?:date|time|datetime-local)"|goal-workspace-header/.test(body) ? `<small class="modal-timezone">日程时区：${esc(serviceTimezone)}</small>` : ''}
        <div class="dlg-actions">
          <button class="btn soft" type="button" id="modal-cancel">取消</button>
          <button class="btn" type="button" id="modal-ok">确定</button>
        </div>
      </div>
    </div>`;
  const dialog = $modal.querySelector('.dialog');
  const okBtn = $('#modal-ok');
  const cancelBtn = $('#modal-cancel');
  $modal.querySelector('.overlay').addEventListener('click', (e) => {
    // Only a click on the backdrop closes the modal. In-place editors may
    // replace the clicked control before this bubbling listener runs.
    if (e.target === e.currentTarget) closeModal();
  });
  cancelBtn.onclick = closeModal;

  const submit = async () => {
    if (okBtn.disabled) return;
    const label = okBtn.textContent;
    okBtn.disabled = true;
    try {
      const operation = typeof onOk === 'function' ? onOk() : null;
      if (operation && typeof operation.then === 'function') {
        if ($modal.querySelector('.dialog') === dialog) {
          okBtn.setAttribute('aria-busy', 'true');
          if (okBtn.textContent === label) okBtn.textContent = '处理中…';
        }
        await operation;
      }
    }
    catch (e) { toast(e && e.message ? e.message : '操作失败'); }
    finally {
      okBtn.disabled = false;
      okBtn.removeAttribute?.('aria-busy');
      if (okBtn.textContent === '处理中…') okBtn.textContent = label;
    }
  };

  const form = $modal.querySelector('form');
  if (form) {
    if (!form.id) form.id = `modal-form-${Date.now()}`;
    okBtn.type = 'submit';
    okBtn.setAttribute('form', form.id);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await submit();
    });
  } else {
    okBtn.onclick = submit;
  }

  const first = [...$modal.querySelectorAll('input, select, textarea')].find(el => !el.disabled && el.getClientRects().length);
  // Read-only dialogs should open at their heading, not scroll to footer actions.
  (first || dialog).focus();
}
function cooperationLabel(state) {
  return ({pending:'待平台审核',active:'已启用服务',paused:'暂停新增服务',ended:'合作已结束'})[state]||'待平台审核';
}
function closeModal() {
  modalReadSerial++;
  const overlay = $modal.querySelector('.overlay');
  if (overlay && !prefersReducedMotion() && overlay.cloneNode && document.body?.appendChild) {
    // Remove the live modal synchronously. The inert exit image never participates
    // in editor guards, focus trapping, ID lookups or a subsequently opened modal.
    const image = overlay.cloneNode(true);
    const originalNodes = [overlay, ...overlay.querySelectorAll('*')];
    const imageNodes = [image, ...image.querySelectorAll('*')];
    const scrollOffsets = originalNodes.flatMap((el, index) => el.scrollTop || el.scrollLeft
      ? [{ node:imageNodes[index], top:el.scrollTop, left:el.scrollLeft }] : []);
    const fields = overlay.querySelectorAll('input, textarea, select');
    image.querySelectorAll('input, textarea, select').forEach((el, index) => {
      // Browsers reject assigning a selected file path; keep file inputs passive.
      if (el.type !== 'file') el.value = fields[index].value;
      if ('checked' in el) el.checked = fields[index].checked;
    });
    image.inert = true;
    image.setAttribute('aria-hidden', 'true');
    image.style.pointerEvents = 'none';
    image.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    image.querySelectorAll('[form]').forEach(el => el.removeAttribute('form'));
    image.querySelectorAll('[for]').forEach(el => el.removeAttribute('for'));
    image.querySelectorAll('[role="dialog"]').forEach(el => {
      el.setAttribute('role', 'presentation');
      el.removeAttribute('aria-modal');
      el.removeAttribute('aria-labelledby');
    });
    document.body.appendChild(image);
    // Restore only nodes that had moved, including independently scrolling bodies.
    scrollOffsets.forEach(({node, top, left}) => { node.scrollTop = top; node.scrollLeft = left; });
    leavingModalNodes.add(image);
    dismissWithMotion(image, () => leavingModalNodes.delete(image));
  }
  $modal.innerHTML = '';
  $app.inert = false;
  document.removeEventListener('keydown', modalKeys);
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

initNetworkStatus();

// ---------- 通知：徽标 / 桌面通知 / 轮询 ----------
function updateBadge() {
  document.querySelectorAll('[data-badge]').forEach((b) => {
    b.textContent = unread;
    b.classList.toggle('show', unread > 0);
  });
}
function maybeDesktopNotify(notes) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  (notes || []).forEach((n) => {
    try { new Notification(n.title || 'Markly', { body: n.content || '', icon: '/icons/icon-192.png' }); } catch (e) {}
  });
}
let _pollTimer = null;
let _pollInFlight = null;
let _pollVisibilityBound = false;
let notesReadRevision = 0;
function mergeNotes(previous, incoming) {
  const rows=new Map(previous.map(row=>[row.id,row]));
  for(const row of incoming)rows.set(row.id,row);
  return [...rows.values()].sort((a,b)=>b.createdAt-a.createdAt||String(b.id).localeCompare(String(a.id)));
}
async function pollNotifications() {
  // Do not keep waking the API while the tab is in the background.  A visible
  // tab polls a compact recent window; opening the notification page still
  // loads the complete list on demand.
  if (!_pollTimer || !me || document.hidden || _pollInFlight) return;
  const pending={session:token,userId:me.id};
  _pollInFlight = pending;
  const current=()=>pending.session===token&&pending.userId===me?.id;
  const revision=notesReadRevision,readSerial=++notesWindowReadSerial;
  try {
    const n = await api('GET', '/api/notifications?limit=20');
    if(!current())return;
    if (!n || n.__unauth) { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } return; }
    if(revision!==notesReadRevision||readSerial<notesWindowAppliedSerial)return;
    notesWindowAppliedSerial=readSerial;
    st.notes = mergeNotes(st.notes,n.notifications);
    observeNotificationWindow(n.notifications);
    unread = n.unread;
    updateBadge();
  } catch (_) {
    // The request layer owns connection status and retry presentation.
  } finally {
    if(_pollInFlight===pending)_pollInFlight = null;
  }
}
function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(pollNotifications, 30000);
  if (!_pollVisibilityBound) {
    _pollVisibilityBound = true;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollNotifications(); });
  }
  pollNotifications();
}

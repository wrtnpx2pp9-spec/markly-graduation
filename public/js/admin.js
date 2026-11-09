/* Markly · 管理后台组件：平台总览 / 用户管理 / 用户弹窗 */
'use strict';

// ---------- 管理员控制台：总览 ----------
async function renderAdminOverview(c) {
  const generation=Symbol();c.adminLoad=generation;
  c.innerHTML='<h1>平台总览</h1><p>正在读取最新数据…</p>';
  try { const overview=await api('GET','/api/admin/overview?fresh=1');if(!c.isConnected||c.adminLoad!==generation||st.view!=='overview')return;st.admin={...st.admin,overview}; }
  catch(error){if(c.isConnected)c.innerHTML=`<p>${esc(error.message)}</p><button class="btn" onclick="renderView()">重新加载</button>`;return;}

  const o = st.admin?.overview || {};
  const u = o.users || {};
  const t = o.tasks || {};
  const p = o.plans || {};
  const op = o.operations || {}, checkins = op.checkins || {}, relations = op.relations || {}, notificationOps = op.notifications || {}, trend = op.trend || [];
  const actPlans = p.active || 0;
  const donePct = t.total ? Math.round(((t.done || 0) / t.total) * 100) : 0;
  const trendMax = Math.max(1, ...trend.map((d) => Math.max(d.tasksDone || 0, d.checkins || 0)));

  c.innerHTML = `
  <section class="admin-overview">
  <div class="row spread page-head">
    <div><div class="overview-eyebrow">MARKLY · 管理工作台</div><h1 style="margin:0">平台总览</h1><p class="overview-intro">查看平台记录，跟进每一份进展。</p></div>
    <div class="row"><button class="btn sm soft" id="overview-refresh">刷新数据</button><button class="btn sm" data-goto="users">用户管理 →</button></div>
  </div>

  <p class="muted">统计更新：${fmtTime(o.generatedAt)} · ${esc(o.timezone||'服务器本地时间')}</p>
  <div class="row"><button class="btn soft" data-goto="registrations">待审核注册 ${o.intake?.registrations||0}</button><button class="btn soft" data-goto="certifications">待审核认证 ${o.intake?.certifications||0}</button><button class="btn soft" data-goto="platform-agent">整理运营报告</button></div>
  <div class="grid stats">
    <div class="card stat"><div class="num">${u.total || 0}</div><div class="lbl">用户总数（含管理员）</div></div>
    <div class="card stat ok"><div class="num">${u.supervisor || 0}</div><div class="lbl">监督者</div></div>
    <div class="card stat"><div class="num">${u.supervisee || 0}</div><div class="lbl">被监督者</div></div>
    <div class="card stat danger"><div class="num">${u.disabled || 0}</div><div class="lbl">已停用</div></div>
  </div>

  <div class="dbl">
    <div class="card">
      <div class="tile-flex">
        <div class="tile-main">
          <h2>任务概况</h2>
          <div class="row mstats">
            <div class="mstat"><b>${t.total || 0}</b><span>任务总数</span></div>
            <div class="mstat"><b class="warn">${t.pending || 0}</b><span>待完成</span></div>
            <div class="mstat"><b class="ok">${t.done || 0}</b><span>已完成</span></div>
            <div class="mstat"><b class="danger">${t.overdue || 0}</b><span>已超时</span></div>
          </div>
        </div>
        <div class="overview-completion">
          <div class="row spread"><span>任务完成率</span><b>${t.total ? donePct + '%' : '暂无任务'}</b></div>
          <div class="overview-progress" role="progressbar" aria-label="任务完成率" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${donePct}"><i style="width:${donePct}%"></i></div>
          <p>${t.total ? `已完成 ${t.done || 0} 项，共 ${t.total} 项任务` : '任务建立后，可在这里查看执行进度。'}</p>
        </div>
      </div>
    </div>
    <div class="card">
      <h2>监督计划</h2>
      <div class="row mstats">
        <div class="mstat"><b>${p.total || 0}</b><span>计划总数</span></div>
        <div class="mstat"><b class="ok">${actPlans}</b><span>进行中</span></div>
        <div class="mstat"><b class="warn">${p.archived || 0}</b><span>已归档</span></div>
      </div>
    </div>
  </div>

  <div class="dbl" style="margin-top:16px">
    <div class="card"><h2>今日执行</h2><div class="row mstats"><div class="mstat"><b>${t.doneToday || 0}</b><span>今日完成任务</span></div><div class="mstat ${checkins.waitingReview ? 'warn' : 'ok'}"><b>${checkins.waitingReview || 0}</b><span>累计待审核打卡</span></div><div class="mstat ok"><b>${checkins.approvedToday || 0}</b><span>今日确认打卡</span></div><div class="mstat ${checkins.missed ? 'danger' : 'ok'}"><b>${checkins.missed || 0}</b><span>进行中计划历史漏卡</span></div></div></div>
    <div class="card"><h2>需要关注</h2><div class="usr-row"><span>未绑定监督者的用户</span><b class="${relations.unbound ? 'warn' : 'ok'}">${relations.unbound || 0}</b></div><div class="usr-row"><span>未读站内通知</span><b class="${notificationOps.unread ? 'warn' : 'ok'}">${notificationOps.unread || 0}</b></div><div class="usr-row"><span>外发队列待处理</span><b class="${o.outbox?.pending ? 'warn' : 'ok'}">${o.outbox?.pending || 0}</b></div><div class="usr-row"><span>超时任务</span><b class="${t.overdue ? 'danger' : 'ok'}">${t.overdue || 0}</b></div></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="row spread"><h2>近 7 天执行趋势</h2><span class="muted" style="font-size:12px">任务完成 / 打卡确认</span></div><div class="admin-trend">${trend.map((d) => `<div class="trend-day"><div class="trend-bars"><i style="height:${Math.max(0,(d.tasksDone || 0) / trendMax * 100)}%"></i><em style="height:${Math.max(0,(d.checkins || 0) / trendMax * 100)}%"></em></div><small>${esc(d.date)}</small><b>${(d.tasksDone || 0) + (d.checkins || 0)}</b></div>`).join('') || '<div class="empty">暂未积累趋势数据</div>'}</div></div>

  <div class="card" style="margin-top:16px" id="ilink-card"></div>

  <div class="card" style="margin-top:16px">
    <h2>最近加入</h2>
    ${(o.recentUsers || []).map((ru) => `
      <div class="usr-row">
        <div>
          <span class="uname">${esc(ru.displayName)}</span>
          <span class="muted" style="font-size:12px"> @${esc(ru.username)}</span>
        </div>
        <div class="row">
          <span class="roletag">${esc(roleLabel(ru.role,ru.identity))}</span>
          ${ru.status === 1 ? '' : '<span class="tag off">停用</span>'}
        </div>
      </div>`).join('') || '<div class="empty">暂无</div>'}
  </div></section>`;

  c.querySelectorAll('[data-goto]').forEach((b) => {
    b.onclick = () => { if(b.dataset.goto==='certifications'){st.certStatus='pending';st.certUserId='';}goView(b.dataset.goto); };
  });
  $('#overview-refresh').onclick=()=>renderAdminOverview(c);
  initIlinkOverview();
}

// ---------- 平台 Pi：管理员限定的身份识别与站内通知 ----------
function renderPlatformAgent(c) {
  c.innerHTML = `<section class="admin-overview">
    <div class="page-head"><div class="overview-eyebrow">MARKLY · 管理员专属</div><h1 style="margin:0">平台 Pi</h1><p class="overview-intro">只读分析项目与平台数据，生成可留档的运营报告。</p></div>
    <div class="card">
      <h2>运营分析任务</h2>
      <p class="muted" style="font-size:13px">普通用户和监督者没有调用入口。Pi 可只读分析项目源码、文档、数据库结构和平台业务数据，不能修改代码、数据或读取密钥。</p>
      <label>运营 Pi 二级密码<input id="platform-pi-password" type="password" autocomplete="current-password" placeholder="验证后 5 分钟内有效" /></label>
      <div class="dlg-actions" style="margin-top:8px"><button class="btn sm soft" id="platform-pi-reauth">验证二级密码</button><span class="muted" id="platform-pi-auth-state">尚未验证</span></div>
      <div class="row"><button class="btn soft" id="platform-pi-daily">日常运营整理</button><button class="btn soft" id="platform-pi-review">注册与认证待办</button></div><label>管理员运营说明<textarea id="platform-pi-instruction" maxlength="1000" placeholder="例如：分析近 30 天平台任务与计划完成情况，结合项目当前实现，给我一份风险、机会和优先级建议报告。"></textarea></label>
      <label class="form-check"><input type="checkbox" id="platform-pi-notify">本次任务允许按我的明确说明发送站内通知</label><div class="dlg-actions" style="margin-top:14px"><button class="btn" id="platform-pi-run">让 Pi 分析并生成报告</button></div>
      <p class="muted" style="font-size:12px;margin-bottom:0">报告会保存在本后台；默认仅分析整理；通知须勾选授权并在说明中写明对象与内容。</p>
    </div>
    <div class="card" style="margin-top:16px" id="platform-pi-result"><div class="muted">尚未执行。</div></div><div class="card" id="platform-pi-history"><p>正在读取历史报告…</p></div>
  </section>`;
  $('#platform-pi-daily').onclick=()=>{$('#platform-pi-instruction').value='整理当前平台运营概览、近7天趋势、待审核注册与认证、执行和通知积压。列出事实、优先级、负责角色和后台处理入口，保存报告。不发送通知。';};
  $('#platform-pi-review').onclick=()=>{$('#platform-pi-instruction').value='根据最新概览整理注册与监督者认证待办，区分账号开通、资质认证、合作授权，给出人工审核顺序及资料完整性建议并保存报告。不自动审批，不发送通知。';};
  const historyBox=c.querySelector('#platform-pi-history');
  async function loadReports(){try{const {reports}=await api('GET','/api/admin/platform-agent/reports');if(!historyBox.isConnected)return;historyBox.innerHTML='<h2>历史运营报告</h2>'+ (reports.map(r=>`<details><summary>${esc(r.title)} · ${fmtTime(r.createdAt)}</summary><p class="prewrap">${esc(r.summary)}</p>${(r.sections||[]).filter(Boolean).map(s=>`<h3>${esc(s.title||'分析')}</h3><p class="prewrap">${esc(s.content||s.text||JSON.stringify(s))}</p>`).join('')}</details>`).join('')||'<p>尚无报告</p>');}catch(error){if(historyBox.isConnected)historyBox.textContent=error.message;}}
  loadReports();
  $('#platform-pi-run').onclick = async () => {
    const instruction = $('#platform-pi-instruction').value.trim();
    const button = $('#platform-pi-run');
    try {
      button.disabled = true; button.textContent = 'Pi 正在处理…';
      const result = await api('POST', '/api/admin/platform-agent/runs', { instruction, allowNotifications: $('#platform-pi-notify').checked }, { 'X-Platform-Agent-Reauth': st.platformPiReauth || '' });
      loadReports();
      if (!c.isConnected) return;
      const report=result.report, charts=(report?.chartSpecs||[]).filter(Boolean).map(chart=>{const labels=Array.isArray(chart.labels)?chart.labels:[],values=Array.isArray(chart.values)?chart.values:[],max=Math.max(1,...values.map(v=>Number(v)||0));return `<div class="card report-section"><b>${esc(chart.title||'数据图表')}</b>${labels.map((label,i)=>`<div class="row report-chart-row"><small class="report-chart-label">${esc(label)}</small><div class="report-chart-track"><i class="report-chart-bar" style="width:${Math.max(0,Math.min(100,(Number(values[i])||0)/max*100))}%"></i></div><small>${esc(values[i]??0)}</small></div>`).join('')}</div>`;}).join(''); $('#platform-pi-result').innerHTML = report ? `<h2>${esc(report.title)}</h2><p class="prewrap">${esc(report.summary)}</p>${charts}${(report.sections||[]).filter(Boolean).map(s=>`<div class="card report-section"><b>${esc(s.title||'分析')}</b><p class="prewrap">${esc(s.content||s.text||JSON.stringify(s))}</p></div>`).join('')}<p class="muted">已向 ${result.sent.length} 位用户发送站内通知。</p>` : '<h2>执行结果</h2><p class="muted">Pi 未保存报告；请用更明确的分析说明重试。</p>';
      toast('平台 Pi 已完成');
    } catch (error) { toast(error.message); }
    finally { button.disabled = false; button.textContent = '让 Pi 分析并生成报告'; }
  };
  $('#platform-pi-reauth').onclick = async () => {
    try { const result=await api('POST','/api/admin/platform-agent/reauth',{secondaryPassword:$('#platform-pi-password').value});st.platformPiReauth=result.reauthToken;$('#platform-pi-password').value='';$('#platform-pi-auth-state').textContent=`已验证，至 ${fmtTime(result.expiresAt)} 有效`;toast('运营 Pi 已完成二级验证'); }
    catch(error){toast(error.message);}
  };
}

// ---------- 管理员：微信 iLink 提醒（机器人绑定 + 收发状态） ----------
let _ilinkScanTimer = null;
function stopIlinkScan() {
  if (_ilinkScanTimer) { clearInterval(_ilinkScanTimer); _ilinkScanTimer = null; }
}

function initIlinkOverview() {
  stopIlinkScan();
  const wrap = $('#ilink-card');
  if (!wrap) return;
  const tick = () => {
    if (!st || st.view !== 'overview') { stopIlinkScan(); return; }
    api('GET', '/api/ilink/status').then(async (d) => {
      // 待扫码/本地模拟等待确认：每次都去服务器刷新一次扫码状态，确认后自动变“已绑定”
      if (d.binding && d.binding.connectionState === 'awaiting_scan' && d.binding.hasQrcode) {
        try { const r = await api('POST', '/api/ilink/refresh'); d = { ...d, binding: r.binding }; } catch (e) {}
      }
      renderIlinkCard(d, true);
    }).catch(() => {});
  };
  tick();
  _ilinkScanTimer = setInterval(tick, 3000);
}

function ilinkStateLabel(s) {
  return { per_user: '用户独立实例', unbound: '未绑定', awaiting_scan: '等待扫码', authenticated: '已绑定', expired: '二维码已过期', auth_failed: '凭证失效' }[s] || s || '';
}

function renderIlinkCard(d, silent) {
  const el = $('#ilink-card');
  if (!el) return;
  const cfg = d.config || {};
  const b = d.binding || {};
  const boundUsers = d.boundUsers || [];
  const mock = cfg.mode === 'mock';
  const mockNote = mock
    ? '<div class="muted" style="font-size:12px;margin-top:6px">🧪 本地模拟模式：每位用户到自己的「设置 → 微信提醒」完成独立实例演示。</div>'
    : '<div class="muted" style="font-size:12px;margin-top:6px">真实模式：每位用户在自己的设置页面生成并扫描专属二维码。</div>';

  const actions = [];

  const qrArea = (b.hasQrcode && b.qrcodeSvg)
    ? `<div style="text-align:center;padding:6px 0">${b.qrcodeSvg}
        <div class="muted" style="font-size:12px">二维码 ${Math.floor((b.qrcodeExpiresInSec || 0) / 60)} 分内有效，扫码后状态会自动刷新</div>
       </div>`
    : '';

  el.innerHTML = `
  <div class="tile-flex" style="align-items:flex-start">
    <div class="tile-main" style="min-width:0">
      <h2>微信提醒（iLink）<span class="roletag" style="margin-left:8px">${mock ? '本地模拟' : '真实微信'}</span>
        <span class="tag ${b.hasCredentials ? 'on' : 'off'}" style="margin-left:6px">${ilinkStateLabel(b.connectionState)}</span>
      </h2>
      <p class="muted" style="font-size:13px">每个用户在自己的设置页面绑定独立 Cloud BOT；凭据、二维码、游标和会话相互隔离。</p>
      ${b.lastError ? `<div class="err" style="margin:6px 0">${esc(b.lastError)}</div>` : ''}
      <div class="row" style="flex-wrap:wrap;gap:6px;margin-top:6px">
        <label class="form-check"><input type="checkbox" id="ilink-enabled" ${cfg.enabled ? 'checked' : ''} /> 启用微信推送</label>
        <label style="display:inline-flex;align-items:center;gap:4px">模式
          <select id="ilink-mode">
            <option value="mock" ${mock ? 'selected' : ''}>本地模拟（演示）</option>
            <option value="real" ${!mock ? 'selected' : ''}>真实微信</option>
          </select>
        </label>
        <span class="muted" style="font-size:12px">真实模式固定使用官方 iLink 服务</span>
      </div>
      <div class="dlg-actions" style="margin-top:8px">
        <button class="btn sm" id="ilink-save">保存设置</button>
        ${actions.join('')}
      </div>
      ${mockNote}
    </div>
    <div class="muted" style="font-size:12px;text-align:right">
      已绑定用户：<b>${boundUsers.length}</b>
    </div>
  </div>
  ${b.connectionState === 'awaiting_scan' || b.connectionState === 'expired' ? qrArea : ''}
  <div style="margin-top:10px">
    <div class="muted" style="font-size:13px;margin-bottom:4px">最近收发</div>
    <div id="ilink-log" style="max-height:180px;overflow:auto;font-size:12px"></div>
  </div>`;

  const baseWrap = $('#ilink-base-wrap');
  const modeSel = $('#ilink-mode');
  const syncModeInput = () => {
    if (baseWrap) baseWrap.style.display = modeSel && modeSel.value === 'real' ? 'inline-flex' : 'none';
  };
  syncModeInput();
  if (modeSel) modeSel.onchange = syncModeInput;
  $('#ilink-save').onclick = async () => {
    try {
      await api('POST', '/api/ilink/config', {
        enabled: $('#ilink-enabled').checked,
        mode: $('#ilink-mode').value,
        baseUrl: undefined,
      });
      toast('已保存');
      api('GET', '/api/ilink/status').then(renderIlinkCard).catch(() => {});
    } catch (e) { toast(e.message); }
  };
  const confirmBtn = $('#ilink-mock-confirm');
  if (confirmBtn) confirmBtn.onclick = async () => {
    try {
      const r = await api('POST', '/api/ilink/mock/confirm');
      toast(r.binding && r.binding.connectionState === 'authenticated' ? '模拟扫码成功，机器人已绑定' : '已确认');
      api('GET', '/api/ilink/status').then(renderIlinkCard).catch(() => {});
    } catch (e) { toast(e.message); }
  };
  api('GET', '/api/ilink/log?limit=14').then((lg) => {
    const box = $('#ilink-log');
    if (!box) return;
    const logs = lg.logs || [];
    box.innerHTML = logs.length ? logs.map((l) => {
      const dirIcon = l.direction === 'in' ? '📥' : '📤';
      const who = esc(l.userDisplayName || l.wxidMasked || '—');
      const stTag = l.status === 'sent' ? '' : ` <span class="tag off">${esc(l.status)}</span>`;
      return `<div style="padding:3px 0;border-bottom:1px dashed #eee"><span style="opacity:.75">${dirIcon} ${who}</span> ${esc(l.text)}${stTag}
        <span style="opacity:.5;float:right">${fmtTime(l.createdAt)}</span></div>`;
    }).join('') : '<div class="empty">暂无收发记录</div>';
  }).catch(() => {});
}

// ---------- 用户管理：列表 + 搜索 + 角色筛选 ----------
async function renderAdminUsers(c) {
  const generation=Symbol();c.adminLoad=generation;
  c.innerHTML='<h1>用户管理</h1><p>正在读取用户资料…</p>';
  try {await loadAdminUsersPage(0);if(!c.isConnected||c.adminLoad!==generation||st.view!=='users')return;}
  catch(error){if(c.isConnected)c.innerHTML=`<p>${esc(error.message)}</p><button class="btn" onclick="renderView()">重新加载</button>`;return;}

  c.innerHTML = `
  <div class="row spread page-head">
    <h1 style="margin:0">用户管理</h1>
    <div class="row">
      <span class="muted" id="adm-count"></span>
      <button class="btn sm" id="adm-new">+ 新建用户</button>
    </div>
  </div>
  <div class="card" id="adm-panel"></div>`;

  $('#adm-new').onclick = () => adminUserModal(null);
  admPanel(c);
}

async function loadAdminUsersPage(offset=st.adminPage?.offset||0) {
  const query=new URLSearchParams({limit:'100',offset:String(Math.max(0,offset))});
  if(st.adminRoleFilter)query.set('role',st.adminRoleFilter);
  const search=String(st.adminQ||'').trim();if(search)query.set('q',search);
  const data=await api('GET','/api/admin/users?'+query.toString());
  st.admin={...(st.admin||{}),users:data.users||[]};
  st.adminPage={offset:Math.max(0,offset),nextOffset:data.nextOffset,total:data.total||0};
  return data;
}

function admPanel(c) {
  const panel = $('#adm-panel');
  if (!panel) return;
  const chips = [['', '全部'], ['supervisor', '监督者'], ['supervisee', '被监督者']];
  panel.innerHTML = `
   <div class="toolbar">
     <input id="adm-q" class="search" placeholder="搜索名字 / 用户名" value="${esc(st.adminQ || '')}" />
     <div class="seg">
       ${chips.map(([k, v]) => `<button class="btn sm ${st.adminRoleFilter === k ? '' : 'soft'}" data-role-f="${k}">${v}</button>`).join('')}
     </div>
   </div>
   <div id="adm-list"></div>`;

  let searchTimer;
  $('#adm-q').oninput = () => { st.adminQ = $('#adm-q').value; clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadAdminUsersPage(0).then(admList).catch(e=>toast(e.message)),220); };
  panel.querySelectorAll('[data-role-f]').forEach((b) => {
    b.onclick = async () => { st.adminRoleFilter = b.dataset.roleF; try{await loadAdminUsersPage(0);admPanel(c);}catch(e){toast(e.message);} };
  });
  admList();
}

function admList() {
  const allUsers = st.admin?.users || [];
  const levelLabels = { basic: '基础', trusted: '成长', professional: '专业', expert: '资深' };
  const relationHTML = (user) => {
    if (user.role === 'supervisor') {
      const used = user.activeSuperviseeCount ?? allUsers.filter((candidate) => candidate.role === 'supervisee' && (candidate.supervisorIds || []).includes(user.id)).length;
      return `${esc(levelLabels[user.accountLevel] || '基础')} · 已绑定 ${used}/${user.superviseeLimit ?? 0}<br>${esc(cooperationLabel(user.cooperationState))} · 平台分配 · 口碑 ${user.reputationScore || 0}/100 · 已评价服务 ${user.completedServiceCount || 0}`;
    }
    if (user.role !== 'supervisee') return '—';
    const ids = user.supervisorIds || (user.managedBy ? [user.managedBy] : []);
    if (!ids.length) return '<span class="tag off">未绑定</span>';
    return (user.supervisors||ids.map(id=>allUsers.find(candidate=>candidate.id===id))).map((supervisor) => {
      return supervisor
        ? `${esc(supervisor.displayName)} <span style="font-size:11px">@${esc(supervisor.username || '')}</span>${supervisor.status === 1 ? '' : ' <span class="tag off">已停用</span>'}`
        : '<span class="tag off">监督者不存在</span>';
    }).join('<br>');
  };
  const users = st.admin?.users || [];
  const cnt = $('#adm-count');
  if (cnt) cnt.textContent = `共 ${st.adminPage?.total||0} 位用户`;
  const list = $('#adm-list');
  if (!list) return;

  list.innerHTML = users.length ? `
    <div class="tab-scroll">
      <table class="table">
        <thead><tr><th>用户</th><th>角色</th><th>监督关系</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
        <tbody>
          ${users.map((u) => `
            <tr>
              <td data-label="用户"><span class="uname">${esc(u.displayName)}</span><div class="muted" style="font-size:12px">@${esc(u.username)}</div></td>
              <td data-label="角色"><span class="roletag">${esc(roleLabel(u.role,u.identity))}</span></td>
              <td data-label="监督关系" class="muted">${relationHTML(u)}</td>
              <td data-label="状态">${u.status === 1 ? '<span class="tag on">启用</span>' : '<span class="tag off">停用</span>'}</td>
              <td data-label="操作" style="text-align:right">
                ${u.role === 'admin' ? '<span class="muted">内置账号</span>' : `
                  <button class="linkbtn" data-adm="portrait" data-id="${u.id}">用户画像</button>${u.role==='supervisor'?`<button class="linkbtn" data-adm="certifications" data-id="${u.id}">认证材料</button><button class="linkbtn" data-adm="cooperation" data-id="${u.id}">合作审核 / 授权</button><button class="linkbtn" data-adm="plan-access" data-id="${u.id}">计划接口授权</button>`:''}<button class="linkbtn" data-adm="edit" data-id="${u.id}">编辑</button>
                  <button class="linkbtn" data-adm="toggle" data-id="${u.id}" data-active="${u.status === 1 ? 0 : 1}">${u.status === 1 ? '停用' : '启用'}</button>
                  <button class="linkbtn" data-adm="reset" data-id="${u.id}">重置密码</button>
                  <button class="linkbtn danger" data-adm="del" data-id="${u.id}">删除</button>`}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div><div class="row spread" style="margin-top:12px"><small class="muted">当前显示 ${users.length} 位</small><div class="row"><button class="btn sm soft" id="adm-prev" ${st.adminPage?.offset?'':'disabled'}>上一页</button><button class="btn sm soft" id="adm-next" ${st.adminPage?.nextOffset==null?'disabled':''}>下一页</button></div></div>` : '<div class="empty">没有匹配的用户</div>';

  $('#adm-prev')?.addEventListener('click',async()=>{try{await loadAdminUsersPage(Math.max(0,(st.adminPage?.offset||0)-100));admList();}catch(e){toast(e.message);}});
  $('#adm-next')?.addEventListener('click',async()=>{try{await loadAdminUsersPage(st.adminPage.nextOffset);admList();}catch(e){toast(e.message);}});

  list.querySelectorAll('[data-adm="certifications"]').forEach(b=>b.onclick=()=>{st.certUserId=b.dataset.id;st.certStatus='';goView('certifications');});
  list.querySelectorAll('[data-adm="cooperation"]').forEach(b=>b.onclick=()=>adminCooperationModal(st.admin.users.find(u=>u.id===b.dataset.id)));
  list.querySelectorAll('[data-adm="portrait"]').forEach(b=>b.onclick=()=>adminPortraitModal(b.dataset.id));
  list.querySelectorAll('[data-adm="plan-access"]').forEach(b=>b.onclick=()=>planAccessModal(b.dataset.id));
  list.querySelectorAll('[data-adm="edit"]').forEach((b) => { b.onclick = () => adminUserModal(st.admin.users.find((u) => u.id === b.dataset.id)); });
  list.querySelectorAll('[data-adm="toggle"]').forEach((b) => {
    b.onclick = async () => {
      try { const result=await api('POST', `/api/admin/users/${b.dataset.id}/status`, { active: b.dataset.active === '1' }); patchAdminUser(result.user); st.adminSupervisorDirectory=null; await Promise.all([refreshAdminOverview(),loadAdminUsersPage()]); admList(); toast('已更新'); }
      catch (e) { toast(e.message); }
    };
  });
  list.querySelectorAll('[data-adm="reset"]').forEach((b) => { b.onclick = () => adminResetModal(b.dataset.id); });
  list.querySelectorAll('[data-adm="del"]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('确认删除该账号？账号及私人记录不可恢复；双方的合作计划、打卡和复盘历史将保留。')) return;
      try { await api('DELETE', `/api/admin/users/${b.dataset.id}`); removeAdminUser(b.dataset.id); st.adminSupervisorDirectory=null; await Promise.all([refreshAdminOverview(),loadAdminUsersPage()]); admList(); toast('已删除'); }
      catch (e) { toast(e.message); }
    };
  });
}

// 按“@平台账号 / 昵称”查找监督者（供绑定用，去掉预填下拉）
function findSupervisorByRef(txt) {
  const q = String(txt || '').trim().replace(/^@/, '').toLowerCase();
  if (!q) return { empty: true };
  const sups = (st.adminSupervisorDirectory || st.admin?.users || []).filter((x) => x.role === 'supervisor' && x.status === 1);
  const hits = sups.filter((x) => String(x.username).toLowerCase() === q || String(x.displayName).toLowerCase() === q);
  if (!hits.length) return { err: '找不到这个监督者，请填对方的 @平台账号 或 昵称' };
  if (hits.length > 1) return { err: '该昵称有重复，请改填对方的 @平台账号' };
  return { sup: hits[0] };
}

// ---------- 用户新建 / 编辑弹窗 ----------
async function adminUserModal(u) {
  try { if (!st.adminSupervisorDirectory) st.adminSupervisorDirectory=await apiAll('/api/admin/users?role=supervisor&status=1','users'); }
  catch(e) { toast(e.message); return; }
  const users = [...new Map([...(st.admin?.users||[]),...st.adminSupervisorDirectory].map(user=>[user.id,user])).values()];
  const isEdit = !!u;
  const role = u ? u.role : 'supervisee';
  const curSups = isEdit ? users.filter((x) => (u.supervisorIds || (u.managedBy ? [u.managedBy] : [])).includes(x.id)) : [];
  openModal(isEdit ? '编辑用户' : '新建用户', `
    ${isEdit ? '' : '<label>用户名（平台账号，登录用）</label><input id="um-username" autocomplete="off" />'}
    <label>显示名称（昵称）</label><input id="um-display" value="${isEdit ? esc(u.displayName) : ''}" />
    ${identityCardsHTML('um-identity',u?.identity||role)}
    ${isEdit ? '' : '<label>初始密码</label><input id="um-pass" type="password" autocomplete="new-password" />'}
    <div id="um-level-wrap">
      <label>监督者等级</label><select id="um-level">${[['basic', '基础'], ['trusted', '成长'], ['professional', '专业'], ['expert', '资深']].map(([k, v]) => `<option value="${k}" ${(u?.accountLevel || 'basic') === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
      <p class="muted">账号创建后请进入“合作审核 / 授权”登记协议、启用服务并分配人数。能力等级仅作平台评估记录，不自动扩容。</p>
    </div>
    <div id="um-bound-wrap">
      <label>绑定监督者（输入对方的 @平台账号 或 昵称）</label>
      <input id="um-bound" autocomplete="off" placeholder="多个监督者用逗号分隔"
             value="${curSups.map((x) => '@' + esc(x.username)).join(', ')}" />
      <div class="muted" style="font-size:12px;margin-top:4px">支持多个监督者；只有已绑定监督者能查看并安排该用户的任务与计划。</div>
    </div>
  `, async () => {
    try {
      const identity = $modal.querySelector('[name="um-identity"]:checked').value;
      const r = ['mentor','supervisor'].includes(identity)?'supervisor':'supervisee';
      let managedBy = null;
      let supervisorIds = [];
      if (r === 'supervisee') {
        const refs = String($('#um-bound')?.value || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
        for (const item of refs) { const ref = findSupervisorByRef(item); if (ref.err) { toast(ref.err); return; } if (ref.sup) supervisorIds.push(ref.sup.id); }
        managedBy = supervisorIds[0] || null;
      }
      let result;
      if (isEdit) {
        result=await api('PUT', `/api/admin/users/${u.id}`, { displayName: $('#um-display').value.trim(), role: r, identity, managedBy, managedByIds: supervisorIds, accountLevel: r === 'supervisor' ? $('#um-level').value : undefined });
      } else {
        result=await api('POST', '/api/admin/users', {
          username: $('#um-username').value.trim(), password: $('#um-pass').value,
          displayName: $('#um-display').value.trim(), role: r, identity, managedBy, managedByIds: supervisorIds, accountLevel: r === 'supervisor' ? $('#um-level').value : undefined,
        });
      }
      closeModal(); patchAdminUser(result.user,{supervisorIds}); st.adminSupervisorDirectory=null; await Promise.all([refreshAdminOverview(),loadAdminUsersPage()]); admList(); toast(isEdit ? '已更新' : '已创建');
    } catch (e) { toast(e.message); }
  });
  const wrap = $('#um-bound-wrap'); const levelWrap = $('#um-level-wrap');
  const sync = () => { const isSupervisor = ['mentor','supervisor'].includes($modal.querySelector('[name="um-identity"]:checked').value); wrap.style.display = isSupervisor ? 'none' : 'block'; levelWrap.style.display = isSupervisor ? 'block' : 'none'; };
  wireIdentityCards($modal,'um-identity',sync); sync();
}

// ---------- 可解释用户画像（仅管理员；不读取日志正文或私信） ----------
async function adminPortraitModal(id) {
  try {
    const [r, activityLog] = await Promise.all([api('GET', `/api/admin/users/${id}/portrait`),api('GET', `/api/admin/users/${id}/activity?limit=30`)]), p = r.portrait, a = p.activity, h = p.history, pref = p.preferences;
    const pct = v => v == null ? '暂无' : v + '%';
    openModal(`${r.user.displayName} · 用户画像`, `<div class="plan-review-card">
      <p class="muted">${esc(p.scope)}</p>
      <h3>完整平台使用沉淀</h3>
      <p>记录跨度：${h.firstRecordedAt ? esc(fmtDate(h.firstRecordedAt)) : '尚未产生记录'} 至 ${h.lastRecordedAt ? esc(fmtDate(h.lastRecordedAt)) : '—'}<br>
      历史任务：${h.tasks.done}/${h.tasks.total} 已完成（${pct(h.tasks.completionRate)}）<br>
      历史计划：${h.planDays.done}/${h.planDays.total} 天已确认（${pct(h.planDays.completionRate)}）<br>
      历史生活记录：${h.lifeCheckins} 条</p>
      <h3>近期执行</h3><p><b>${esc(a.trend.label)}</b> · ${esc(a.trend.detail)}</p>
      <p>当前计划：${a.activePlanDays.done}/${a.activePlanDays.total} 天已确认（${pct(a.activePlanDays.completionRate)}）<br>近 14 天生活记录：${a.lifeCheckins14d} 条${a.moods.length ? ' · 已填写心情：'+esc(a.moods.join('、')) : ''}</p>
      <h3>本人主动填写的偏好与支持方式</h3>
      ${pref.explicitGoals ? `<p><b>目标：</b>${esc(pref.explicitGoals.goal||'未填写')}<br><b>希望节奏：</b>${esc(pref.explicitGoals.rhythm||'未填写')} · 每周 ${pref.explicitGoals.weeklyMinutes??'—'} 分钟<br><b>希望支持：</b>${esc(pref.explicitGoals.supportPreferences||'未填写')}<br><b>可能阻碍：</b>${esc(pref.explicitGoals.obstacles||'未填写')}</p>` : '<p class="muted">尚未填写服务档案，不能推断偏好。</p>'}
      ${pref.profileSkills.length ? `<p><b>公开技能 / 兴趣标签：</b>${esc(pref.profileSkills.join('、'))}</p>` : ''}
      <h3>需要确认的信号</h3>${p.concerns.length ? p.concerns.map(x=>`<p>${x.level==='attention'?'⚠':'○'} ${esc(x.text)}<br><small class="muted">依据：${esc(x.evidence)}</small></p>`).join('') : '<p class="muted">当前没有需要提示的执行信号。</p>'}
      <h3>活动流水（最近 30 条）</h3>${activityLog.events.length ? activityLog.events.map(e=>`<p><b>${esc({user_login:'登录平台',task_checkin_submitted:'任务打卡提交',task_completed:'任务完成',task_completed_confirmed:'任务确认完成',task_checkin_rejected:'任务打卡被退回',plan_item_completed:'计划事项完成',plan_checkin_submitted:'计划打卡提交',plan_checkin_confirmed:'计划打卡已确认',plan_checkin_rejected:'计划打卡被退回',notification_queued:'通知已入队',notification_sent:'通知已推送',notification_skipped:'通知未推送'}[e.type]||e.type)}</b>${e.summary?' · '+esc(e.summary):''}<br><small class="muted">${esc(fmtTime(e.createdAt))}</small></p>`).join(''):'<p class="muted">尚未产生可追溯活动。</p>'}
      <p class="muted">${esc(p.disclaimer)}</p>
    </div>`, ()=>closeModal());
    $('#modal-ok').textContent='关闭'; $('#modal-cancel').hidden=true;
  } catch (e) { toast(e.message); }
}

// ---------- 重置密码弹窗 ----------
function adminResetModal(id) {
  openModal('重置密码', `
    <label>新密码</label><input id="rp-pass" type="password" autocomplete="new-password" />
  `, async () => {
    const p = $('#rp-pass').value;
    if (!p) { toast('请输入新密码'); return; }
    try { await api('POST', `/api/admin/users/${id}/reset-password`, { password: p }); closeModal(); toast('密码已重置'); } catch (e) { toast(e.message); }
  });
}

function adminCooperationModal(u) {
  openModal('平台合作审核与服务授权',`
    <p><b>${esc(u.displayName)}</b> · 当前分配 ${u.capacityOverride??0} 人。下调额度不解除已有服务关系。</p>
    <label>合作状态<select id="coop-state">${['pending','active','paused','ended'].map(s=>`<option value="${s}" ${u.cooperationState===s?'selected':''}>${cooperationLabel(s)}</option>`).join('')}</select></label>
    <label>合作协议编号 / 签署记录引用<input id="coop-ref" maxlength="200" value="${esc(u.agreementRef||'')}" placeholder="填写已核验的协议编号或签署记录"></label>
    <label>平台分配的同时服务人数<input id="coop-capacity" type="number" min="0" max="1000" step="1" value="${u.capacityOverride??0}"></label>
    <label class="form-check"><input id="coop-published" type="checkbox" ${u.directoryPublished?'checked':''}>在平台监督团队中展示（启用服务后生效）</label>
    <label>审核依据 / 调整原因<textarea id="coop-note" maxlength="1000" placeholder="说明协议核验、能力评估与人数分配依据"></textarea></label>
    <p class="muted">启用前须完成协议核验并分配至少1人。暂停或结束合作会关闭新服务入口，已有计划保留，需平台另行安排履约与交接。</p>
    <div id="coop-history" class="muted">正在读取最近授权记录…</div>`,async()=>{
      const state=$('#coop-state').value,capacity=Number($('#coop-capacity').value),agreementRef=$('#coop-ref').value,note=$('#coop-note').value,published=$('#coop-published').checked;
      const result=await api('PUT',`/api/admin/users/${u.id}/cooperation`,{state,capacity,agreementRef,note,published});
      closeModal();patchAdminUser(result.user,{agreementRef,cooperationNote:note,directoryPublished:published});await Promise.all([refreshAdminOverview(),loadAdminUsersPage()]);admList();toast('平台合作授权已更新');
    });
  const box=$('#coop-history');
  api('GET',`/api/admin/users/${u.id}/cooperation-history`).then(r=>{
    if(!box.isConnected)return;
    box.innerHTML='<b>最近授权记录</b>'+r.events.slice(0,5).map(e=>`<p>${fmtTime(e.created_at)} · ${esc(cooperationLabel(e.after.cooperationState))} · 分配${e.after.capacityOverride??0}人<br>${esc(e.after.cooperationNote||'')}</p>`).join('');
  }).catch(e=>{if(box.isConnected)box.textContent=e.message;});
}

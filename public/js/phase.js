/* Markly · 阶段性打卡计划（长期计划 → 手动子计划(周期N天) → 每日打卡）
   监督者：轻量状态 + 建长期/子计划 + 常用内容模板
   被监督者：每日打卡完整操作界面 */
'use strict';

// 轻缓存：st._pd[planId] = days[]
function _pd() { if (!st._pd) st._pd = {}; return st._pd; }
function phaseLongPlans() {
  return (st.plans || []).filter((p) => p.kind === 'phase')
    .slice().sort((a, b) => ((a.status === 'archived') - (b.status === 'archived')) || ((a.createdAt || 0) - (b.createdAt || 0)));
}
function phaseCycles(parentId) {
  return (st.plans || []).filter((p) => p.kind === 'cycle' && p.parentId === parentId)
    .slice().sort((a, b) => (b.startAt || 0) - (a.startAt || 0));
}
function dayStats(days) {
  const list = (days || []).filter(d=>d.checkinState!=='cancelled');
  return { total: list.length, done: list.filter((d) => d.checkinState === 'approved').length };
}
function todayStrL() { return todayStr(); }

// 拉取子计划逐日数据（已缓存跳过）
async function phaseEnsureDays(c) {
  const need = [];
  (st.plans || []).filter((p) => p.kind === 'cycle').forEach((p) => { if (!_pd()[p.id]) need.push(p.id); });
  if (!need.length) return;
  for (const id of need) {
    try { const r = await api('GET', '/api/plans/' + id + '/days'); _pd()[id] = r.days || []; } catch (e) { toast('每日记录加载失败，请刷新重试'); }
  }
  if(st.view==='tasks' && need.every(id=>_pd()[id])) renderTasks(document.getElementById('content'));
}

function phaseDayFor(planId, dateStr) {
  return (_pd()[planId] || []).find((d) => d.dayDate === dateStr);
}
function fmtD(dstr) { const s = String(dstr || ''); const mm = s.slice(5, 7), dd = s.slice(8, 10); return (mm ? mm + '-' + dd : ''); }

function phaseStageState(cy) {
  const days = _pd()[cy.id] || [];
  const stats = dayStats(days);
  const review = cy.stageReview || {};
  if(cy.status!=='active')return {key:'inactive',label:({proposed:'待执行人接受',declined:'暂未接受',archived:'已归档'})[cy.status]||cy.status,tone:'future',stats,review};
  const completed = !!(stats.total && stats.done === stats.total) && (cy.planningMode!=='rolling'||cy.dueAt<Date.now());
  const ended = completed || !!(cy.dueAt && cy.dueAt < Date.now());
  if (review.lockedAt) return { key: 'signed', label: '联名记录已生成', tone: 'done', stats, review };
  if (review.selfSubmitted && review.supervisorSubmitted) return { key: 'confirm', label: '等待双方确认', tone: 'current', stats, review };
  if (review.selfSubmitted) return { key: 'supervisor', label: '等待监督者评价', tone: 'current', stats, review };
  if (review.supervisorSubmitted) return { key: 'self', label: '等待自我复盘', tone: 'current', stats, review };
  if (ended) return { key: 'self', label: completed ? '执行已确认 · 待复盘' : '阶段已到期 · 待收尾', tone: 'current', stats, review };
  if (cy.startAt && cy.startAt > Date.now()) return { key: 'upcoming', label: '等待到达', tone: 'future', stats, review };
  return { key: 'active', label: '正在进行', tone: 'current', stats, review };
}

function phaseStageAction(cy, state) {
  const review = state.review;
  if (state.key === 'signed') return `<button class="btn sm soft" data-stage-card="${cy.id}">查看联名卡</button>`;
  if (state.key === 'active') {
    const todayDay = (_pd()[cy.id] || []).find((day) => day.dayDate === todayStrL());
    if(!todayDay)return '<span class="pc-chip">今天没有安排</span>';
    if(todayDay.checkinState==='cancelled')return '<span class="pc-chip">今日休息</span>';
    if(todayDay.checkinState==='submitted')return `<button class="btn sm soft" data-day-open="${todayDay.id}">${me.id===cy.creatorId?'审核今日提交':'等待监督者确认'}</button>`;
    if(todayDay.checkinState==='approved')return '<span class="pc-chip ok">今日已确认</span>';
    if (me.role === 'supervisee' && todayDay) return `<button class="btn sm" data-phase-day="${todayDay.id}" data-phase-plan="${cy.id}">今日打卡</button>`;
    if (me.role === 'supervisor' && todayDay) return '<span class="pc-chip">等待今日打卡</span>';
    return '<span class="pc-chip ok">今日已完成</span>';
  }
  if (!['self', 'supervisor', 'confirm'].includes(state.key)) return '';
  if (state.key !== 'confirm' && me.role === 'supervisee') {
    return review.selfSubmitted ? '<span class="pc-chip ok">复盘已提交</span>' : `<button class="btn sm" data-stage-self="${cy.id}">提交复盘</button>`;
  }
  if (state.key !== 'confirm' && me.role === 'supervisor') {
    return review.supervisorSubmitted ? '<span class="pc-chip ok">评价已提交</span>' : `<button class="btn sm" data-stage-supervisor="${cy.id}">提交评价</button>`;
  }
  if (state.key === 'confirm') {
    const confirmed = me.role === 'supervisor' ? review.supervisorConfirmed : review.superviseeConfirmed;
    return confirmed ? '<span class="pc-chip ok">我已确认</span>' : `<button class="btn sm" data-stage-confirm="${cy.id}">确认阶段记录</button>`;
  }
  return '';
}

function phaseJourneyHTML(cycles) {
  if (!cycles.length) return '';
  const current = cycles.find((cycle) => phaseStageState(cycle).key === 'active')
    || cycles.find((cycle) => phaseStageState(cycle).tone === 'current')
    || cycles.filter(cycle=>cycle.status==='active' && phaseStageState(cycle).key==='upcoming').sort((a,b)=>a.startAt-b.startAt)[0]
    || cycles[0];
  const future = cycles.filter(cycle=>cycle.id!==current.id && (cycle.status==='proposed' || phaseStageState(cycle).key==='upcoming'));
  const history = cycles.filter((cycle) => cycle.id !== current.id && !future.includes(cycle));
  const currentState = phaseStageState(current);
  const currentDays = _pd()[current.id] || [];
  const currentPct = currentState.stats.total ? Math.round(currentState.stats.done / currentState.stats.total * 100) : 0;
  const remaining = Math.max(0, currentState.stats.total - currentState.stats.done);
  return `<section class="stage-board">
    <div class="stage-board-head"><div><b>当前阶段</b></div><span class="stage-together"><i></i>共同见证中</span></div>
    <article class="stage-focus">
      <div class="stage-focus-glow"></div>
      <div class="stage-focus-top">
        <div class="stage-number"><b>${cycles.length - cycles.indexOf(current)}</b></div>
        <div class="stage-focus-copy"><span>${fmtD(current.calendarStart)} — ${fmtD(current.calendarEnd)}</span><h3>${esc(current.title.replace(/^第\s*\d+\s*站\s*[·・]?\s*/, ''))}</h3></div>
        <em>${esc(currentState.label)}</em>
      </div>
      <div class="stage-meter"><div><span style="width:${currentPct}%"></span></div><b>${currentPct}%</b></div>
      <div class="stage-focus-bottom">
        <div class="stage-mini-stat"><b>${currentState.stats.done}</b><span>已确认天数</span></div>
        <div class="stage-mini-stat"><b>${remaining}</b><span>已安排待确认</span></div>
        <div class="stage-focus-action">${phaseStageAction(current, currentState)}</div>
      </div>
    </article>
    ${future.length ? `<div class="stage-history-head"><div><b>后续阶段</b></div><strong>${future.length} 段安排</strong></div><div class="stage-history">${future.slice().sort((a,b)=>a.startAt-b.startAt).map(cycle=>phaseHistoryCardHTML(cycle,cycles.length-cycles.indexOf(cycle))).join('')}</div>` : ''}
    ${history.length ? `<div class="stage-history-head"><div><b>成长足迹</b></div><strong>${history.length} 段记录</strong></div>
      <div class="stage-history">${history.map((cycle) => phaseHistoryCardHTML(cycle, cycles.length - cycles.indexOf(cycle))).join('')}</div>` : ''}
  </section>`;
}

function phaseHistoryCardHTML(cycle, number) {
  const state = phaseStageState(cycle);
  const days = _pd()[cycle.id] || [];
  const pct = state.stats.total ? Math.round(state.stats.done / state.stats.total * 100) : 0;
  const result = state.review.resultLabel || (state.key === 'signed' ? '阶段已完成' : state.label);
  return `<article class="stage-memory">
    <div class="stage-memory-index">${String(number).padStart(2, '0')}</div>
    <div class="stage-memory-main">
      <div class="stage-memory-top"><span>${fmtD(cycle.calendarStart)} — ${fmtD(cycle.calendarEnd)}</span><em>${esc(result)}</em></div>
      <h4>${esc(cycle.title.replace(/^第\s*\d+\s*站\s*[·・]?\s*/, ''))}</h4>
      <div class="stage-memory-meta"><span><b>${state.stats.done}</b>/${state.stats.total} 天</span><span>完成率 <b>${pct}%</b></span></div>
    </div>
    <div class="stage-memory-action">${phaseStageAction(cycle, state)}</div>
  </article>`;
}

// ---------------- 计划卡片（监督者轻量 / 被监督者完整） ----------------
function phasePlanHTML(p) {
  const isSup = me.role === 'supervisor';
  const cycles = phaseCycles(p.id);
  const allDays = cycles.reduce((acc, cy) => acc.concat(_pd()[cy.id] || []), []);
  const stt = dayStats(allDays);
  const assigneeName = p.assigneeId ? personName(p.assigneeId) : '';
  const doneAll = p.planningMode !== 'rolling' && cycles.length && stt.total && stt.done === stt.total;

  const head = `
    <div class="pc-top">
      <div class="pc-icon">🎯</div>
      <div class="pc-main">
        <div class="pc-title">${esc(p.title)}
          ${p.status === 'archived' ? '<span class="pc-chip off">已归档</span>' : (doneAll ? '<span class="pc-chip ok">已完成</span>' : '<span class="pc-chip">长期计划</span>')}
        </div>
        <div class="pc-sub muted">
          ${p.coverageStart ? `已接受阶段覆盖：${esc(p.coverageStart)} — ${esc(p.coverageEnd)}<br>` : ''}
          ${p.startAt || p.dueAt ? `原约定：${_d2(p.startAt) || '开始'} ~ ${_d2(p.dueAt) || '未定'} · ` : ''}${isSup ? (p.assigneeId ? `对象：<button class="linkbtn" data-profile-link="${p.assigneeId}" data-profile-return="tasks">${esc(assigneeName || '未指派')}</button>` : '对象：未指派') : (p.creatorId ? `由 <button class="linkbtn" data-profile-link="${p.creatorId}" data-profile-return="tasks">${esc(personName(p.creatorId) || '监督者')}</button> 监督` : '')}
        </div>
      </div>
      <div class="pc-pct" style="--p:${stt.total ? Math.round(stt.done / stt.total * 100) : 0}">${stt.total ? Math.round(stt.done / stt.total * 100) : 0}<i>%</i></div>
    </div>
    <div class="pc-prog"><div class="pc-bar"><i style="width:${stt.total ? Math.round(stt.done / stt.total * 100) : 0}%"></i></div>
      <span>${stt.done}/${stt.total} 天</span></div>`;

  // 每个周期是一站：主视图看路线，每日明细折叠查看
  const cycHTML = cycles.length ? `<details class="phase-detail"><summary>每日记录</summary>${cycles.map((cy) => phaseCycleHTML(cy, isSup)).join('')}</details>` : `
    <div class="empty" style="padding:14px">暂无阶段</div>`;

  return `
  <div class="phase-plan" data-phase="${p.id}">
    ${head}
    ${p.status==='proposed'||p.status==='declined'?agreementCard(p):''}
    ${p.status==='proposed' && p.creatorId===me.id ? `<button class="btn sm soft" data-action="archivePlan" data-id="${p.id}">撤销待接受计划</button>` : ''}
    ${cycles.filter(c=>c.status==='proposed'&&p.status!=='proposed').map(agreementCard).join('')}
    ${serviceReviewHTML(p)}
    ${phaseJourneyHTML(cycles)}
    <div class="phase-cycles">${cycHTML}</div>
    ${cycles.map(cy=>`<div class="row" style="margin-top:8px"><button class="btn sm soft" data-daily-plan="${cy.id}">${esc(cy.title)} · ${cy.status==='active'?'安排近三天 / 调整每日内容':'查看每日安排记录'}</button></div>`).join('')}
    ${isSup && p.creatorId===me.id && p.status==='active' ? `<div class="row" style="gap:8px;margin-top:6px">
        <button class="btn sm" data-phase-addcyc="${p.id}">＋ 追加阶段 / 续期</button>
        <button class="btn sm soft" data-action="archivePlan" data-id="${p.id}">结束并归档目标</button>
      </div>` : ''}
  </div>`;
}

function phaseCycleHTML(cy, isSup) {
  const days = _pd()[cy.id] || [];
  const stt = dayStats(days);
  const today = todayStrL();
  const wDone = weekCount(days, today);

  if (isSup) {
    // 监督者：轻量 → 展开看每天的格子
    const grid = days.map((d) => {
      const done = d.checkinState === 'approved';
      const isT = d.dayDate === today;
      return `<span class="pd-cell ${done ? 'on' : ''} ${isT ? 'today' : ''}" title="${esc(d.content)} · ${d.dayDate}${d.note ? ' · ' + esc(d.note) : ''}">${d.seq}</span>`;
    }).join('');
    return `
    <details class="phase-cyc" ${''}>
      <summary>
        <b>${esc(cy.title)}</b>
        <span class="muted" style="font-size:11.5px">${fmtD(cy.calendarStart || days[0]?.dayDate)} ~ ${fmtD(cy.calendarEnd || days[days.length - 1]?.dayDate)} · ${cy.calendarStart && cy.calendarEnd ? Math.round((Date.parse(cy.calendarEnd+'T00:00:00Z') - Date.parse(cy.calendarStart+'T00:00:00Z')) / 86400000) + 1 + ' 天' : ''}</span>
        <span class="pc-od" style="color:var(--muted)">${stt.done}/${stt.total}</span>
      </summary>
      <div class="day-timeline">${days.map(d=>phaseDayTile(cy,d,today)).join('')}</div>
      ${cy.creatorId===me.id && ['active','proposed'].includes(cy.status) && st.plans.some(p=>p.id===cy.parentId && p.status==='active') ? `<button class="btn sm soft" data-action="archivePlan" data-id="${cy.id}">${cy.status==='proposed'?'撤销待接受阶段':'结束并归档阶段'}</button>` : ''}
    </details>`;
  }

  // 被监督者：完整逐日打卡
  const groups = {};
  days.forEach((d) => { const w = Math.ceil(d.seq / 7); (groups[w] = groups[w] || []).push(d); });
  const rows = Object.keys(groups).map((w) => {
    const g = groups[w];
    const dn = g.filter((d) => d.checkinState === 'approved').length;
    const mainContent = g.find((d) => d.content)?.content || '完成本周约定';
    return `
    <div class="timeline-week">
      <div class="timeline-week-head"><b>第 ${w} 周</b><span>${dn}/${g.length}</span></div>
      <div class="day-timeline">${g.map((d) => phaseDayTile(cy, d, today)).join('')}</div>
    </div>`;
  }).join('');
  return `
  <div class="phase-cyc full">
    <div class="phase-cyc-hd">
      <div><b>${esc(cy.title)}</b><div class="muted" style="font-size:11.5px">${fmtD(days[0] ? days[0].dayDate : '')} ~ ${fmtD(days[days.length - 1] ? days[days.length - 1].dayDate : '')}</div></div>
      <span class="pc-od" style="color:var(--muted)">${stt.done}/${stt.total}</span>
    </div>
    <div class="phase-bar"><i style="width:${stt.total ? Math.round(stt.done / stt.total * 100) : 0}%"></i></div>
    ${rows || '<div class="empty">暂无每日安排</div>'}
  </div>`;
}

function phaseDayTile(cy, d, today) {
  const done = d.checkinState === 'approved';
  const past = d.dayDate < today;
  const isT = d.dayDate === today;
  const future = d.dayDate > today;
  const stateKey = d.checkinState || (done ? 'approved' : 'unsubmitted');
  const date = new Date(d.dayDate + 'T00:00:00');
  const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
  const state = stateKey==='cancelled'?'双方确认休息':stateKey === 'approved' ? '已确认' : (stateKey === 'submitted' ? '待确认' : (stateKey === 'rejected' ? '需要补充' : (isT ? '今天去完成' : (past ? '漏卡' : '待开始'))));
  const action = cy.status!=='active'||stateKey==='cancelled'?'':stateKey === 'submitted'
    ? (me.role === 'supervisor' ? 'phaseDayReview' : 'phaseDayWithdraw')
    : (me.id===cy.assigneeId && !future && cy.status==='active' && stateKey !== 'approved' ? 'phaseDayCheck' : '');
  const comments = d.comments || [];
  return `
  <div class="day-entry ${done ? 'done' : ''} ${stateKey === 'submitted' ? 'submitted' : ''} ${stateKey === 'rejected' ? 'rejected' : ''} ${isT ? 'today' : ''} ${past && !done && stateKey !== 'submitted' ? 'missed' : ''}">
    <span class="day-entry-dot">${phaseMoodIcon(comments.at(-1)?.mood || phaseLegacyMood(d.mood))}</span>
    <span class="day-entry-date">第 ${d.seq} 天 · ${date.getMonth() + 1}月${date.getDate()}日 · 周${weekdays[date.getDay()]}</span>
    <span class="day-entry-body"><b>${esc(d.content) || '完成今天的约定'}</b>${phaseDayTasksHTML(cy,d,today)}${d.checkinReviewNote?`<p class="help-text">需补充：${esc(d.checkinReviewNote)}</p>`:''}${phaseDayCommentsHTML(d)}</span>
    <span class="day-entry-status">${state}</span>
    <span class="day-entry-actions">${action ? `<button class="day-action" data-action="${action}" data-plan="${cy.id}" data-day="${d.id}">${stateKey === 'submitted' ? (me.role === 'supervisor' ? '处理' : '撤回') : '打卡'}</button>` : ''}<button class="day-comment" data-action="phaseDayComment" data-plan="${cy.id}" data-day="${d.id}" aria-label="留言">${phaseCommentIcon()}</button></span>
  </div>`;
}

function phaseDayTasksHTML(cycle, day, today) {
  const items = day.items || [];
  if (!items.length) return '';
  const canToggle = me.id === cycle.assigneeId && cycle.status === 'active' && day.dayDate <= today && !['submitted', 'approved'].includes(day.checkinState);
  return `<div class="day-task-list">${items.map((item) => `<button type="button" class="day-task ${item.status==='done'?'done':''}" ${canToggle?`data-action="phaseDayItem" data-plan="${cycle.id}" data-day="${day.id}" data-item="${item.id}" data-done="${item.status!=='done'}"`:'disabled'}><i>${item.status==='done'?'✓':'○'}</i><span>${esc(item.title)}</span></button>`).join('')}</div>`;
}

function phaseLegacyMood(mood) {
  return ({ '😊': 'happy', '😌': 'calm', '😴': 'tired', '😤': 'tough', '💪': 'cheer' })[mood] || '';
}

function phaseMoodIcon(mood) {
  const mouths = { happy: 'M8 14c1.1 1.3 2.4 2 4 2s2.9-.7 4-2', calm: 'M9 14h6', tired: 'M9 15c1-.7 2-.9 3-.9s2 .2 3 .9', tough: 'M8.5 15c1.2-1 2.3-1.4 3.5-1.4s2.3.4 3.5 1.4', cheer: 'M8 13.5c1 1.7 2.4 2.5 4 2.5s3-.8 4-2.5' };
  if (!mood) return '<span class="mood-empty"></span>';
  return `<svg class="line-mood ${mood}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 10h.01M15.5 10h.01"/><path d="${mouths[mood] || mouths.calm}"/></svg>`;
}

function phaseCommentIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"/></svg>';
}

function phaseDayCommentsHTML(day) {
  const items = [];
  if (day.note) items.push(`<em><i>${me.role === 'supervisor' ? '被监督者' : '我'}</i>${esc(day.note)}</em>`);
  (day.comments || []).slice(-2).forEach((comment) => {
    const author = comment.authorId === me.id ? '我' : (comment.authorRole === 'supervisor' ? '监督者' : '被监督者');
    items.push(`<em><i>${author}</i>${esc(comment.content || '留下了一个状态')}</em>`);
  });
  return items.join('') || '<em class="day-entry-placeholder">还没有留言</em>';
}

function weekCount(days, today) {
  // 本周（含今天所在周，7 天窗口粗算）
  return 0; // 占位：卡片头部已给整体进度
}

// ---------------- 页面区块 ----------------
function phaseSectionHTML(options = {}) {
  const longs = phaseLongPlans().filter(options.filter || (() => true));
  const title = options.title || '🎯 阶段成长';
  const emptyText = options.emptyText || '暂无目标';
  const addLabel = options.addLabel || (options.supervisorMode ? '＋ 新建目标' : '＋ 新建长期计划');
  const showAdd = me.role === 'supervisor' && options.showAdd !== false;
  if (!longs.length) {
    return `
    <div class="card" style="margin-bottom:16px">
      <div class="hc-head"><h2>${title}</h2>${showAdd ? `<button class="btn sm" id="newphase">${addLabel}</button>` : ''}</div>
      <div class="empty">${emptyText}</div>
    </div>`;
  }
  return `
  <div class="card phase-main-card" style="margin-bottom:16px">
    <div class="hc-head"><div><h2>${title}</h2></div>${showAdd ? `<button class="btn sm" id="newphase">${addLabel}</button>` : ''}</div>
    ${longs.map((p) => phasePlanHTML(p)).join('')}
  </div>`;
}

// ---------------- 交互 ----------------
function phaseWire(c) {
  c.querySelectorAll('[data-daily-plan]').forEach(b=>b.onclick=()=>openDailyPlanner(b.dataset.dailyPlan));
  const np = c.querySelector('#newphase');
  if (np) np.onclick = () => newPhaseModal(np.dataset.phaseFor || undefined);

  c.querySelectorAll('[data-phase-addcyc]').forEach((b) => { b.onclick = () => newCycleModal(b.dataset.phaseAddcyc); });
  c.querySelectorAll('[data-stage-self]').forEach((b) => { b.onclick = () => phaseSelfReviewModal(b.dataset.stageSelf); });
  c.querySelectorAll('[data-stage-supervisor]').forEach((b) => { b.onclick = () => phaseSupervisorReviewModal(b.dataset.stageSupervisor); });
  c.querySelectorAll('[data-stage-confirm]').forEach((b) => { b.onclick = () => phaseConfirmModal(b.dataset.stageConfirm); });
  c.querySelectorAll('[data-stage-card]').forEach((b) => { b.onclick = () => phaseRecordModal(b.dataset.stageCard); });

  // 打卡 / 取消（走全局委托也行，这里直接绑定）
  c.querySelectorAll('[data-phase-day]').forEach((b) => {
    b.onclick = () => dayCheckModal(b.dataset.phasePlan, b.dataset.phaseDay);
  });
  c.querySelectorAll('[data-action="phaseDayCheck"]').forEach((b) => {
    b.onclick = () => dayCheckModal(b.dataset.plan, b.dataset.day);
  });
  c.querySelectorAll('[data-action="phaseDayWithdraw"]').forEach((b) => { b.onclick = () => phaseWithdrawModal(b.dataset.plan, b.dataset.day); });
  c.querySelectorAll('[data-action="phaseDayReview"]').forEach((b) => { b.onclick = () => phaseDayReviewModal(b.dataset.plan, b.dataset.day); });
  c.querySelectorAll('[data-action="phaseDayComment"]').forEach((b) => { b.onclick = () => phaseDayCommentModal(b.dataset.plan, b.dataset.day); });
  c.querySelectorAll('[data-action="phaseDayItem"]').forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/plans/${b.dataset.plan}/days/${b.dataset.day}/items/${b.dataset.item}/toggle`, { done: b.dataset.done === 'true' }); delete _pd()[b.dataset.plan]; await phaseRefresh('当天任务已更新'); } catch (e) { toast(e.message); } }; });
}

function phaseCommentMoodIcon(mood) {
  return phaseMoodIcon(mood === 'happy' ? 'happy' : mood === 'calm' ? 'calm' : mood === 'tired' ? 'tired' : mood === 'tough' ? 'tough' : mood === 'cheer' ? 'cheer' : '');
}

function phaseDayCommentModal(planId, dayId) {
  const day = phaseFindDay(planId, dayId);
  if (!day) return;
  const moods = [['happy', '轻松'], ['calm', '平静'], ['tired', '有点累'], ['tough', '在坚持'], ['cheer', '有成就']];
  openModal('给这一天留句话', `<div class="comment-day-title">第${day.seq}天 · ${day.dayDate}<b>${esc(day.content || '今日记录')}</b></div><label>现在的状态</label><div class="mood-row line-moods" id="comment-moods">${moods.map(([key, label]) => `<button type="button" class="mood-chip line-mood-chip" data-mood="${key}">${phaseCommentMoodIcon(key)}<i>${label}</i></button>`).join('')}</div><label>留一句话</label><textarea id="day-comment-content" maxlength="300" placeholder="写下今天的感受，或给同行的人一句回应"></textarea>`, async () => {
    const selected = document.querySelector('#comment-moods .mood-chip.sel');
    const content = $('#day-comment-content').value.trim();
    if (!selected && !content) { toast('请选择状态或留一句话'); return; }
    await api('POST', `/api/plans/${planId}/days/${dayId}/comments`, { mood: selected?.dataset.mood || '', content });
    delete _pd()[planId]; await phaseRefresh('已留下今天的记录');
  });
  $('#modal-ok').textContent = '留下记录';
  document.querySelectorAll('#comment-moods .mood-chip').forEach((button) => { button.onclick = () => { document.querySelectorAll('#comment-moods .mood-chip').forEach((item) => item.classList.remove('sel')); button.classList.add('sel'); }; });
}

function phaseFindDay(planId, dayId) {
  return (_pd()[planId] || []).find((day) => day.id === dayId);
}

function phaseWithdrawModal(planId, dayId) {
  const day = phaseFindDay(planId, dayId);
  if (!day) return;
  openModal('撤回这次打卡？', `<div class="stage-modal-tip">撤回后可重新提交</div><div class="withdraw-preview"><b>第${day.seq}天 · ${esc(day.content || '今日打卡')}</b><span>${day.dayDate} · 待确认</span></div>`, async () => {
    await api('POST', `/api/plans/${planId}/days/${dayId}/withdraw`);
    delete _pd()[planId];
    await phaseRefresh('已撤回，可重新打卡');
  });
  $('#modal-ok').textContent = '撤回打卡';
}

function phaseDayReviewModal(planId, dayId) {
  const day = phaseFindDay(planId, dayId);
  if (!day) return;
  openModal('审核打卡', `<div class="review-preview"><b>第${day.seq}天 · ${esc(day.content || '今日打卡')}</b><span>${day.dayDate}</span>${day.note ? `<p>打卡备注：${esc(day.note)}</p>` : ''}</div><label>驳回原因（驳回时必填）</label><textarea id="day-review-note" maxlength="300" placeholder="需要补充或调整的内容"></textarea>`, async () => {
    await api('POST', `/api/plans/${planId}/days/${dayId}/review`, { decision: 'approved', reviewNote: $('#day-review-note').value.trim() });
    delete _pd()[planId];
    await phaseRefresh('已确认这次打卡');
  });
  $('#modal-ok').textContent = '确认通过';
  const actions = document.querySelector('.dlg-actions');
  const reject = document.createElement('button');
  reject.className = 'btn soft'; reject.type = 'button'; reject.textContent = '驳回';
  reject.onclick = async () => {
    const note = $('#day-review-note').value.trim();
    if (!note) { toast('驳回时请填写原因'); return; }
    try {
      await api('POST', `/api/plans/${planId}/days/${dayId}/review`, { decision: 'rejected', reviewNote: note });
      delete _pd()[planId]; await phaseRefresh('已驳回并发回修改');
    } catch (e) { toast(e.message); }
  };
  if (actions) actions.insertBefore(reject, $('#modal-ok'));
}

function phaseCycleById(cycleId) {
  return (st.plans || []).find((plan) => plan.id === cycleId && plan.kind === 'cycle');
}

function phaseParentOf(cycle) {
  return cycle ? (st.plans || []).find((plan) => plan.id === cycle.parentId) : null;
}

// 打卡后只替换所属的长期计划卡，而不是重绘整页。这样保留用户所在位置，
// 同时让进度、今日状态和操作按钮立即反映最新结果。
function patchPhasePlan(planId) {
  const content = document.getElementById('content');
  const parent = phaseParentOf(phaseCycleById(planId));
  if (st.view !== 'tasks' || !content?.isConnected || !parent) return false;

  const findPlan = () => [...content.querySelectorAll('.phase-plan')]
    .find((el) => el.dataset.phase === parent.id);
  const oldPlan = findPlan();
  if (!oldPlan) return false;

  const previousTop = oldPlan.getBoundingClientRect().top;
  const expanded = [...oldPlan.querySelectorAll('details')].map((detail) => detail.open);
  oldPlan.outerHTML = phasePlanHTML(parent);

  const newPlan = findPlan();
  if (newPlan) {
    newPlan.querySelectorAll('details').forEach((detail, index) => { detail.open = !!expanded[index]; });
    const offset = newPlan.getBoundingClientRect().top - previousTop;
    if (Math.abs(offset) > 0.5) window.scrollBy(0, offset);
  }
  phaseWire(content);
  return true;
}

async function phaseRefresh(message) {
  closeModal();
  await loadSection();
  renderView();
  toast(message);
}

function phaseSelfReviewModal(cycleId) {
  const cycle = phaseCycleById(cycleId);
  if (!cycle) return;
  const review = cycle.stageReview || {};
  openModal('阶段复盘', `
    <div class="stage-modal-tip">双方提交后互相可见</div>
    <label>本阶段完成得怎么样</label>
    <textarea id="stage-self-summary" maxlength="600" placeholder="例如：比上一阶段更容易开始，但周末仍会拖延">${esc(review.selfSummary || '')}</textarea>
    <label>最大的困难（选填）</label>
    <textarea id="stage-self-difficulty" maxlength="300" placeholder="在哪些情境下遇到困难？">${esc(review.selfDifficulty || '')}</textarea>
    <label>哪种陪伴最有帮助（选填）</label>
    <input id="stage-helpful" maxlength="300" placeholder="例如：晚上轻提醒，不连续催促" value="${esc(review.helpfulMethod || '')}" />
    <label>后续安排</label>
    <select id="stage-self-next">
      ${['继续下一阶段', '调整目标后继续', '降低难度', '先暂停'].map((value) => `<option ${review.selfNextAction === value ? 'selected' : ''}>${value}</option>`).join('')}
    </select>
  `, async () => {
    await api('PUT', `/api/plans/${cycle.id}/stage-review/self`, {
      summary: $('#stage-self-summary').value.trim(),
      difficulty: $('#stage-self-difficulty').value.trim(),
      helpfulMethod: $('#stage-helpful').value.trim(),
      nextAction: $('#stage-self-next').value,
    });
    await phaseRefresh('复盘已提交');
  });
  $('#modal-ok').textContent = '提交复盘';
}

function phaseSupervisorReviewModal(cycleId) {
  const cycle = phaseCycleById(cycleId);
  if (!cycle) return;
  const review = cycle.stageReview || {};
  const labels = ['明显进步', '有所进步', '基本稳定', '暂无明显变化', '需要调整目标', '双方意见不一致'];
  openModal('阶段评价', `
    <div class="stage-modal-tip">双方提交后互相可见</div>
    <label>观察到的具体变化</label>
    <textarea id="stage-observation" maxlength="600" placeholder="例如：主动开始的次数增加，周末节奏仍不稳定">${esc(review.supervisorObservation || '')}</textarea>
    <label>进步在哪里（选填）</label>
    <input id="stage-progress" maxlength="300" placeholder="例如：主动性、沟通、恢复能力" value="${esc(review.supervisorProgress || '')}" />
    <label>下一阶段建议（选填）</label>
    <textarea id="stage-suggestion" maxlength="300" placeholder="聚焦一个可执行建议">${esc(review.supervisorSuggestion || '')}</textarea>
    <label>阶段结果</label>
    <select id="stage-result">${labels.map((value) => `<option ${review.resultLabel === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
    <label>是否建议进入下一阶段</label>
    <select id="stage-recommend">${['建议继续', '调整后继续', '建议暂停'].map((value) => `<option ${review.recommendNext === value ? 'selected' : ''}>${value}</option>`).join('')}</select>
  `, async () => {
    await api('PUT', `/api/plans/${cycle.id}/stage-review/supervisor`, {
      observation: $('#stage-observation').value.trim(),
      progress: $('#stage-progress').value.trim(),
      suggestion: $('#stage-suggestion').value.trim(),
      resultLabel: $('#stage-result').value,
      recommendNext: $('#stage-recommend').value,
    });
    await phaseRefresh('评价已提交');
  });
  $('#modal-ok').textContent = '提交评价';
}

function phaseRecordHTML(cycle) {
  const parent = phaseParentOf(cycle);
  const review = cycle.stageReview || {};
  const days = _pd()[cycle.id] || [];
  const currentStats = dayStats(days);
  const snapshot = review.executionSnapshot;
  const stats = snapshot && Number.isFinite(Number(snapshot.total)) ? {
    total: Number(snapshot.total), done: Number(snapshot.done || 0), percent: Number(snapshot.percent || 0)
  } : currentStats;
  const pct = snapshot ? stats.percent : (stats.total ? Math.round(stats.done / stats.total * 100) : 0);
  const statsNote = review.lockedAt
    ? (snapshot ? `确认时统计：${stats.done}/${stats.total} 天（${pct}%） · 当前统计：${currentStats.done}/${currentStats.total} 天（${currentStats.total ? Math.round(currentStats.done / currentStats.total * 100) : 0}%）` : `确认时统计：未记录 · 当前统计：${currentStats.done}/${currentStats.total} 天（${currentStats.total ? Math.round(currentStats.done / currentStats.total * 100) : 0}%）`)
    : `当前统计：${currentStats.done}/${currentStats.total} 天（${currentStats.total ? Math.round(currentStats.done / currentStats.total * 100) : 0}%）`;
  return `<div class="growth-record ${review.lockedAt ? 'locked' : ''}">
    <div class="gr-mark">${review.lockedAt ? '共同见证卡' : '阶段记录预览'}</div>
    <h2>${esc(parent?.title || '成长计划')}</h2>
    <div class="gr-stage">${esc(cycle.title)} · ${fmtD(cycle.calendarStart)}—${fmtD(cycle.calendarEnd)}</div>
    <div class="gr-score"><b>${stats.done}/${stats.total}</b><span>完成天数</span><b>${pct}%</b><span>完成率</span></div><div class="stage-confirm-note">${statsNote}</div>
    <div class="gr-result">${esc(review.resultLabel || '等待共同评价')}</div>
    <blockquote>“${esc(review.selfSummary || '等待被监督者提交自我复盘')}”<small>被监督者 · ${esc(personName(cycle.assigneeId))}</small></blockquote>
    <blockquote>“${esc(review.supervisorObservation || '等待监督者提交阶段评价')}”<small>监督者 · ${esc(personName(parent?.creatorId))}</small></blockquote>
    <div class="gr-confirm"><span>${review.superviseeConfirmed ? '✓' : '○'} 被监督者确认</span><span>${review.supervisorConfirmed ? '✓' : '○'} 监督者确认</span></div>
    ${review.lockedAt ? `<footer>双方已于 ${new Date(review.lockedAt).toLocaleDateString('zh-CN')} 确认 · 记录号 ${esc(cycle.id.slice(0, 8).toUpperCase())}</footer>` : ''}
  </div>`;
}

function phaseConfirmModal(cycleId) {
  const cycle = phaseCycleById(cycleId);
  if (!cycle) return;
  const revision = cycle.stageReview?.revision;
  openModal('确认阶段记录', phaseRecordHTML(cycle) + '<div class="stage-confirm-note">双方确认后锁定记录，无法修改</div>', async () => {
    await api('POST', `/api/plans/${cycle.id}/stage-review/confirm`, { revision });
    await phaseRefresh('记录已确认');
  });
  $('#modal-ok').textContent = '确认记录';
}

function phaseRecordModal(cycleId) {
  const cycle = phaseCycleById(cycleId);
  if (!cycle) return;
  openModal('联名成长记录', phaseRecordHTML(cycle), async () => closeModal());
  $('#modal-cancel').style.display = 'none';
  $('#modal-ok').textContent = '完成';
}

async function dayCheckModal(planId, dayId) {
  const plan = (st.plans || []).find((p) => p.id === planId);
  const day = _pd()[planId] ? _pd()[planId].find((d) => d.id === dayId) : null;
  if (!plan || !day) return;
  openModal('第' + day.seq + '天打卡', `
    <form id="pd-check-form">
      <div class="muted" style="font-size:13px">${day.dayDate} · ${esc(day.content) || '今日打卡'}</div>
      <p class="muted">监督者可见 · 提交后待确认</p>
      <label>今天的状态</label>
      <div class="mood-row line-moods" id="pd-moods">
        ${[['happy', '😊', '轻松'], ['calm', '😌', '平静'], ['tough', '😤', '在坚持'], ['tired', '😴', '有点累'], ['cheer', '💪', '有成就']].map(([key, value, label]) =>
          `<button type="button" class="mood-chip line-mood-chip" data-mood="${value}" title="${label}">${phaseMoodIcon(key)}<i>${label}</i></button>`).join('')}
      </div>
      <label>留一句话</label>
      <textarea id="pd-note" placeholder="例如：背完了 30 个单词、做了一会儿拉伸…"></textarea>
    </form>
  `, async () => {
    const moodEl = document.querySelector('.mood-chip.sel');
    const mood = moodEl ? moodEl.dataset.mood : '';
    const note = ($('#pd-note') ? $('#pd-note').value.trim() : '') || '';
    try {
      await api('POST', `/api/plans/${planId}/days/${dayId}/checkin`, { note, mood });
      const list = _pd()[planId];
      if (Array.isArray(list)) {
        const target = list.find((x) => x.id === dayId);
        if (target) {
          target.checkinState = 'submitted';
          target.note = note || target.note;
          target.mood = mood || target.mood;
          target.checkinReviewNote = '';
        }
      }
      closeModal();
      if (!patchPhasePlan(planId)) {
        const c = document.getElementById('content');
        if (st.view === 'tasks' && c && c.isConnected) renderTasks(c);
        else if (st.view === 'dashboard' && c && c.isConnected) renderView();
      }
      toast('已提交，等待监督者确认');
    } catch (e) { toast(e.message); }
  });
  const box = document.querySelector('#pd-moods');
  if (box) box.querySelectorAll('.mood-chip').forEach((b) => {
    b.onclick = () => { box.querySelectorAll('.mood-chip').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); };
  });
}

// ---------------- 新建长期计划 / 周期子计划 + 模板 ----------------
async function newPhaseModal(id) { return newGoalModal(id); }

async function newCycleModal(parentId) {
  const parent = (st.plans || []).find((p) => p.id === parentId);
  if (!parent) return;
  let templates = [];
  try { templates = (await api('GET', '/api/plan-templates')).templates || []; } catch (e) {}
  const open = () => {
    openModal('追加阶段', `
      <div class="muted">${esc(parent.title)}</div>
      <label>阶段名称</label><input id="cyc-title" placeholder="例如：第二阶段 巩固练习" />
      <div class="row">
        <div style="flex:1"><label>开始日期</label><input id="cyc-start" type="date" /></div>
        <div style="flex:1"><label>结束日期</label><input id="cyc-due" type="date" /></div>
      </div>
      <div class="row" style="gap:10px">
        <div style="flex:0 0 150px"><label>提醒时间（小时）</label><input id="cyc-hour" type="number" value="20" min="0" max="23" /></div>
        <div style="flex:1"><label>${parent.planningMode==='rolling'?'阶段方向与执行节奏':'每天要做什么（模板）'}</label><input id="cyc-content" placeholder="${parent.planningMode==='rolling'?'例如：每周练习四天，具体任务提前2—3天确认':'例如：背30个单词'}" /></div>
      </div>
      <label>补充说明（选填）</label>
      <textarea id="cyc-desc" placeholder="本阶段的目标或反馈方式"></textarea>
      ${templates.length ? `<div class="phase-tpls">
        <div class="muted" style="font-size:12px;margin:8px 0 4px">常用内容</div>
        ${templates.map((t) => `<button type="button" class="tpl-chip" data-tpl="${t.id}">${esc(t.title)}</button>`).join('')}
      </div>` : ''}
      <div class="row" style="margin-top:10px">
        <label style="flex:1">存为常用内容（选填）<input id="cyc-tplsave" placeholder="模板名称" /></label>
      </div>
    `, async () => {
      const start = $('#cyc-start').value, due = $('#cyc-due').value;
      const content = ($('#cyc-content') ? $('#cyc-content').value : '').trim();
      const desc = ($('#cyc-desc') ? $('#cyc-desc').value : '').trim();
      const hour = Number($('#cyc-hour') ? $('#cyc-hour').value : 20);
      const saveTitle = $('#cyc-tplsave') ? $('#cyc-tplsave').value.trim() : '';
      if (!start || !due) { toast('请选择开始与结束日期'); return; }
      if (!content) { toast(parent.planningMode==='rolling'?'请填写阶段方向与执行节奏':'请填写每日任务'); return; }
      if (saveTitle) {
        try { await api('POST', '/api/plan-templates', { title: saveTitle, content }); toast('已存入常用内容'); } catch (e) { toast(e.message); }
      }
      const body = {
        title: ($('#cyc-title').value.trim() || '续期阶段'), kind: 'cycle', parentId,
        assigneeId: parent.assigneeId,
        dailyContent: content,
        description: desc,
        remindHour: hour,
        startAt: fromLocalInput(start + 'T00:00'), dueAt: fromLocalInput(due + 'T23:59') + 59000,
      };
      try {
        await api('POST', '/api/plans', body);
        closeModal(); delete _pd()[parentId]; await loadSection(); renderView(); toast('阶段已发送，等待执行人接受');
      } catch (e) { toast(e.message); }
    });
    $('#modal-ok').textContent = '发送阶段';
    ctlTemplates();
  };
  function ctlTemplates() {
    const box = document.querySelector('.phase-tpls');
    if (!box) return;
    box.querySelectorAll('[data-tpl]').forEach((b) => {
      b.onclick = () => {
        const t = templates.find((x) => x.id === b.dataset.tpl);
        if (t) { const ta = $('#cyc-content'); if (ta) ta.value = t.content; }
      };
    });
  }
  open();
}

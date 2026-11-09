/* Markly · 看板与计划任务组件：打卡 / 计划 / 任务弹窗 */
'use strict';

// ---------- 看板 ----------
function renderDashboard(c) {
  const isSup = me.role === 'supervisor';
  const pending = st.tasks.filter((t) => t.status === 'pending');
  const done = st.tasks.filter((t) => t.status === 'done');
  const overdue = pending.filter(isOverdue);
  const todayDate = todayStr();
  const today = st.tasks.filter((t) => t.dueAt && toLocalInput(t.dueAt).slice(0,10) === todayDate);
  const upcoming = pending.filter((t) => t.dueAt).sort((a, b) => a.dueAt - b.dueAt).slice(0, 8);

  const myPending = isSup
    ? pending.filter((t) => t.assigneeId !== me.id || people.some((p) => p.id === t.assigneeId && p.role === 'supervisee'))
    : pending;

  c.innerHTML = `
  <div class="grid stats">
    <div class="card stat"><div class="num">${pending.length}</div><div class="lbl">待完成</div></div>
    <div class="card stat ok"><div class="num">${done.length}</div><div class="lbl">已完成</div></div>
    <div class="card stat"><div class="num">${today.length}</div><div class="lbl">今日到期</div></div>
    <div class="card stat ${overdue.length ? 'danger' : 'ok'}"><div class="num">${overdue.length}</div><div class="lbl">已超时</div></div>
  </div>

  <div class="grid" style="grid-template-columns:1fr 1fr;margin-top:16px">
    <div class="card">
      <h2>${isSup ? '待监督' : '我的待办'}</h2>
      ${renderTaskList(myPending.slice(0, 8), 'dashboard') || '<div class="empty">暂无待办，去「计划与任务」创建吧</div>'}
    </div>
    <div class="card">
      <h2>即将到期</h2>
      ${renderTaskList(upcoming, 'dashboard') || '<div class="empty">暂无计划中的任务</div>'}
    </div>
  </div>

  ${overdue.length ? `<div class="card" style="margin-top:16px;border-color:#fecaca">
    <h2 style="color:var(--danger)">⚠️ 已超时，需要跟进</h2>
    ${renderTaskList(overdue, 'dashboard')}
  </div>` : ''}

  <div class="card" style="margin-top:16px">
    <h2>监督计划</h2>
    ${renderPlansList() || '<div class="empty">暂无监督计划</div>'}
  </div>`;

  c.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => { goView(b.dataset.goto); }; });
}

// ---------- 任务渲染 ----------
function renderTaskList(list, ctx) {
  if (!list || !list.length) return '';
  const isSup = me.role === 'supervisor';
  return `<div>${list.map((t) => {
    const od = isOverdue(t);
    return `<div class="task ${t.status === 'done' ? 'done' : ''}" data-id="${t.id}">
      <button class="check ${t.status === 'done' ? 'done' : ''}" data-action="toggle" data-id="${t.id}" aria-label="查看任务与完成状态" title="查看任务与完成状态">
        ${t.status === 'done' ? '✓' : t.status==='submitted'?'…':''}
      </button>
      <div class="tbody">
        <div class="ttitle">${esc(t.title)}
          ${od ? '<span class="tag overdue">超时</span>' : ''}
          ${t.status==='submitted'?'<span class="tag">待监督者确认</span>':t.status==='cancelled'?'<span class="tag">已取消</span>':''}
          ${isSup && t.creatorId === me.id ? `<span class="tag who">监督:${esc(personName(t.assigneeId))}</span>` : ''}
        </div>
        <div class="tmeta">${fmtTime(t.dueAt)} 到期 · 提前${t.remindBeforeMinutes ?? 30}分钟提醒${t.checkinNote ? ' · 备注:' + esc(t.checkinNote) : ''}</div>
      </div>
      ${ctx === 'full' ? `<div class="tact">
        ${t.creatorId === me.id && (!t.planId || st.plans.some(p=>p.id===t.planId && p.status==='active')) ? (t.creatorId===t.assigneeId ? `<button class="linkbtn" data-action="del" data-id="${t.id}">删除</button>` : (['pending','submitted'].includes(t.status) ? `<button class="linkbtn" data-action="cancelTask" data-id="${t.id}">取消任务</button>` : '')) : ''}
      </div>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function _d2(ts) { return ts ? new Date(ts).toLocaleDateString('zh-CN', { timeZone: serviceTimezone, month: '2-digit', day: '2-digit' }) : ''; }

function reviewStars(rating) {
  const value = Math.max(0, Math.min(5, Number(rating) || 0));
  return '★'.repeat(value) + '☆'.repeat(5 - value);
}

function serviceReviewHTML(plan) {
  if (!plan || plan.kind === 'cycle' || plan.parentId) return '';
  const review = plan.review;
  if (review) {
    return `<div class="pc-desc" style="margin-top:8px">
      <b>服务评价 <span style="color:#f59e0b">${reviewStars(review.rating)}</span></b>
      ${review.content ? `<div class="muted" style="margin-top:4px">${esc(review.content)}</div>` : ''}
      ${me.role === 'supervisee' && plan.assigneeId === me.id ? `<button class="linkbtn" data-action="serviceReview" data-id="${plan.id}">修改评价</button>` : ''}
    </div>`;
  }
  if (me.role === 'supervisee' && plan.assigneeId === me.id && plan.creatorId !== me.id && (plan.status==='archived'||(plan.status==='active'&&plan.dueAt&&plan.dueAt<Date.now()))) {
    return `<div class="pc-desc" style="margin-top:8px"><button class="btn sm soft" data-action="serviceReview" data-id="${plan.id}">评价这次监督服务</button></div>`;
  }
  if (me.role === 'supervisor' && plan.creatorId === me.id) return '<div class="pc-desc muted" style="margin-top:8px">服务评价：等待对方评价</div>';
  return '';
}

function lockTaskEditor(editor) {
  const controls=[...editor.querySelectorAll('input,select,textarea,[data-service-rating]')];
  const previous=controls.map(control=>control.disabled);
  controls.forEach(control=>{control.disabled=true;});
  editor.setAttribute('aria-busy','true');
  return ()=>{
    controls.forEach((control,index)=>{control.disabled=previous[index];});
    editor.removeAttribute('aria-busy');
  };
}

async function refreshTaskWrite(message, editor, session, originView, originScroll) {
  if(session!==token)return;
  if(editor.isConnected&&$modal.querySelector('.dialog')===editor)closeModal();
  let refreshed=true;
  try{await loadSection();}catch{refreshed=false;}
  if(session!==token)return;
  if(st.view===originView&&!$modal.querySelector('.dialog')){
    renderView();window.scrollTo(0,originScroll);
  }
  toast(refreshed?message:message+'，页面暂时无法刷新；请稍后重新加载，无需重复提交。');
}

function serviceReviewModal(planId) {
  const plan = (st.plans || []).find((item) => item.id === planId);
  if (!plan) return;
  const draftKey='markly:review:'+me.id+':'+planId;
  let draft=null;try{draft=JSON.parse(sessionStorage.getItem(draftKey)||'null');}catch{}
  const review = {...(plan.review || {}),...(draft||{})};
  const originView=st.view,originScroll=window.scrollY,session=token;
  let editor,contentInput;
  let submitting=false;
  const saveDraft=()=>{try{sessionStorage.setItem(draftKey,JSON.stringify({rating:selectedRating,content:contentInput.value}));}catch{}};
  let selectedRating = Number(review.rating) || 5;
  openModal(review.id ? '修改服务评价' : '服务评价', `
    <div class="muted" style="font-size:13px;margin-bottom:10px">评价监督者在「${esc(plan.title)}」中的服务表现</div>
    <label>评分</label>
    <div class="service-rating" role="group" aria-label="选择评分">
      ${[1, 2, 3, 4, 5].map((rating) => `<button type="button" class="service-rating-star ${rating <= selectedRating ? 'selected' : ''}" data-service-rating="${rating}" aria-label="${rating} 星" aria-pressed="${rating === selectedRating}">★</button>`).join('')}
      <span class="service-rating-value" id="sr-rating-value">${selectedRating} 星</span>
    </div>
    <label>评价内容（选填，最多 500 字）</label>
    <textarea id="sr-content" maxlength="500" placeholder="例如：提醒及时、沟通清楚、计划安排合理">${esc(review.content || '')}</textarea>
  `, async () => {
    if(submitting)return;submitting=true;const submit=$('#modal-ok');submit.disabled=true;
    const submittedDraft=JSON.stringify({rating:selectedRating,content:contentInput.value});
    const unlock=lockTaskEditor(editor);
    try {
      await api('PUT', `/api/plans/${plan.id}/review`, { rating: selectedRating, content: contentInput.value.trim() });
      if(session!==token)return;
      try{if(sessionStorage.getItem(draftKey)===submittedDraft)sessionStorage.removeItem(draftKey);}catch{}
      await refreshTaskWrite(review.id ? '评价已更新' : '感谢你的评价',editor,session,originView,originScroll);
    } catch (error) { toast(error.message); } finally {unlock();submitting=false;if(submit.isConnected)submit.disabled=false;}
  });
  editor=$modal.querySelector('.dialog');contentInput=editor.querySelector('#sr-content');
  contentInput.addEventListener('input',saveDraft);
  editor.querySelectorAll('[data-service-rating]').forEach((button) => {
    button.onclick = () => {
      if(submitting)return;
      selectedRating = Number(button.dataset.serviceRating);
      editor.querySelectorAll('[data-service-rating]').forEach((star) => {
        const active = Number(star.dataset.serviceRating) <= selectedRating;
        star.classList.toggle('selected', active);
        star.setAttribute('aria-pressed', String(Number(star.dataset.serviceRating) === selectedRating));
      });
      editor.querySelector('#sr-rating-value').textContent = `${selectedRating} 星`;
      saveDraft();
    };
  });
}

function renderPlansList(filter = () => true) {
  const src = (st.plans || []).filter((p) => (p.kind || 'task') === 'task').filter(filter);
  if (!src.length) return '';
  const isSupView = me.role === 'supervisor';
  return src.map((p) => {
    const ptasks = st.tasks.filter((t) => t.planId === p.id);
    const total = ptasks.length;
    const doneCnt = ptasks.filter((t) => t.status === 'done').length;
    const od = ptasks.filter(isOverdue).length;
    const pct = total ? Math.round((doneCnt / total) * 100) : (p.status === 'archived' ? 100 : 0);
    const isArchived = p.status === 'archived';
    const isDone = !isArchived && total > 0 && doneCnt === total;
    const isCreator = me.role === 'supervisor' && p.creatorId === me.id;
    const assigneeName = p.assigneeId ? personName(p.assigneeId) : '';
    const creatorName = p.creatorId ? personName(p.creatorId) : '';
    const chip = isArchived ? '<span class="pc-chip off">已归档</span>'
      : (isDone ? '<span class="pc-chip ok">已完成</span>' : '<span class="pc-chip">进行中</span>');
    const times = [];
    if (p.startAt || p.dueAt) times.push(`🗓 ${_d2(p.startAt) || '开始'} ~ ${_d2(p.dueAt) || '未定'}`);
    times.push(`⏰ 提前 ${p.remindBeforeMinutes ?? 30} 分钟提醒`);
    const whoHtml = isSupView
      ? (assigneeName ? `监督对象：<button class="linkbtn" data-profile-link="${p.assigneeId}" data-profile-return="tasks">${esc(assigneeName)}</button>` : '<span class="pc-nobind">未指派对象</span>')
      : (creatorName ? `由 <button class="linkbtn" data-profile-link="${p.creatorId}" data-profile-return="tasks">${esc(creatorName)}</button> 监督` : '');
    return `<div class="plan-card ${isArchived ? 'archived' : (isDone ? 'done' : '')}">
      <div class="pc-top">
        <div class="pc-icon">${isArchived ? '🗄' : (isDone ? '✅' : '📋')}</div>
        <div class="pc-main">
          <div class="pc-title">${esc(p.title)} ${chip}</div>
          <div class="pc-sub muted">${times.join(' · ')}</div>
        </div>
        <div class="pc-pct" style="--p:${pct}">${pct}<i>%</i></div>
      </div>
      ${p.status==='proposed'||p.status==='declined'?agreementCard(p):''}
      ${p.description ? `<div class="pc-desc">${esc(p.description)}</div>` : ''}
      ${serviceReviewHTML(p)}
      <div class="pc-prog">
        <div class="pc-bar"><i style="width:${pct}%"></i></div>
        <span>${doneCnt}/${total || 0}</span>
      </div>
      <div class="pc-foot">
        <div class="pc-who">${whoHtml}</div>
        <div class="pc-acts">
          ${od ? `<span class="pc-od">${od} 项超时</span>` : ''}
          <button class="btn sm soft" data-action="openPlan" data-id="${p.id}">任务</button>
          ${!isArchived && isCreator ? `<button class="btn sm soft" data-action="archivePlan" data-id="${p.id}">归档</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ---------- 监督者目标页：同一条目标主线，额外提供对象筛选 ----------
function renderSupervisorGoals(c) {
  // 目标是第一数据源：人员列表还未同步时，也不能把已可见的目标筛成空白。
  const ownedPlans = (st.plans || []).filter((plan) => plan.creatorId === me.id && plan.assigneeId !== me.id);
  const personById = new Map(people.filter((person) => person.relationship === 'managed').map((person) => [person.id, person]));
  ownedPlans.forEach((plan) => {
    if (!personById.has(plan.assigneeId)) {
      personById.set(plan.assigneeId, { id: plan.assigneeId, displayName: personName(plan.assigneeId) || '监督对象', username: '', relationship: 'managed' });
    }
  });
  const supervisees = [...personById.values()];
  const validIds = new Set(supervisees.map((person) => person.id));
  if (st.supervisorGoalPerson !== 'all' && !validIds.has(st.supervisorGoalPerson)) st.supervisorGoalPerson = 'all';
  const selectedPerson = st.supervisorGoalPerson;
  const selectedStatus = st.supervisorGoalStatus || 'all';
  const matches = (plan) => {
    if (selectedPerson !== 'all' && plan.assigneeId !== selectedPerson) return false;
    if (selectedStatus !== 'all' && plan.status !== selectedStatus) return false;
    return plan.creatorId === me.id && plan.assigneeId !== me.id;
  };
  const goals = (st.plans || []).filter((plan) => plan.kind !== 'cycle').filter(matches);
  const phaseGoals = goals.filter((plan) => plan.kind === 'phase');
  const taskGoals = goals.filter((plan) => (plan.kind || 'task') === 'task');
  const statusOptions = [['all', '全部'], ['active', '进行中'], ['proposed', '待接受'], ['archived', '已归档']];
  const detailPlan = st.filterPlan ? st.plans.find((plan) => plan.id === st.filterPlan && matches(plan)) : null;
  const scopedTasks = st.tasks.filter((task) => task.creatorId === me.id && task.assigneeId !== me.id
    && (selectedPerson === 'all' || task.assigneeId === selectedPerson));
  const shownTasks = detailPlan ? scopedTasks.filter((task) => task.planId === detailPlan.id) : scopedTasks;
  const openTasks = scopedTasks.filter((task) => task.status === 'pending').length;

  c.innerHTML = `
    <div class="supervisor-goals-head">
      <div><div class="eyebrow">监督工作台</div><h1>目标</h1></div>
      <button class="btn sm" id="supervisor-new-goal">＋ 新建目标</button>
    </div>

    <section class="card supervisor-people-card">
      <div class="section-heading"><div><h2>我监督的人</h2></div><span class="supervisor-capacity">${supervisees.length} 位</span></div>
      ${supervisees.length ? `<div class="supervisor-people-tabs" role="group" aria-label="按监督对象筛选">
        <button class="supervisor-person-filter ${selectedPerson === 'all' ? 'active' : ''}" data-sup-person="all"><span class="avatar sm person-all-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="4" y="4" width="6" height="6" rx="2"/><rect x="14" y="4" width="6" height="6" rx="2"/><rect x="4" y="14" width="6" height="6" rx="2"/><rect x="14" y="14" width="6" height="6" rx="2"/></svg></span><span><b>全部</b><i>${openTasks} 项待跟进</i></span></button>
        ${supervisees.map((person) => {
          const stat = supPersonStat(person);
          return `<button class="supervisor-person-filter ${selectedPerson === person.id ? 'active' : ''}" data-sup-person="${person.id}">${avatarHTML(person, 'sm')}<span><b>${esc(person.displayName)}</b><i>${stat.od ? `${stat.od} 项超时` : `${stat.total} 项任务`}</i></span></button>`;
        }).join('')}
      </div>` : '<div class="empty compact">暂无监督对象</div>'}
    </section>

    <section class="card supervisor-goal-filter">
      <div class="supervisor-status-tabs" role="group" aria-label="按计划状态筛选">
        ${statusOptions.map(([value, label]) => `<button class="btn sm ${selectedStatus === value ? '' : 'soft'}" data-sup-status="${value}" aria-pressed="${selectedStatus === value}">${label}</button>`).join('')}
      </div>
    </section>

    <div class="supervisor-goals-summary"><span>目标 <b>${goals.length}</b></span><span>阶段目标 <b>${phaseGoals.length}</b></span><span>专项计划 <b>${taskGoals.length}</b></span></div>

    ${phaseGoals.length ? phaseSectionHTML({
      filter: matches,
      title: '阶段目标',
      supervisorMode: true,
      showAdd: false,
    }) : ''}
    ${taskGoals.length ? `<section class="card support-plans-card supervisor-plan-list" style="margin-bottom:16px">
      <div class="section-heading"><div><h2>专项计划</h2></div></div>
      ${renderPlansList(matches)}
    </section>` : ''}
    ${!goals.length ? '<section class="card"><div class="empty">暂无符合条件的目标</div></section>' : ''}
    <section class="card supervisor-task-detail">
      <div class="section-heading"><div><h2>${detailPlan ? `${esc(detailPlan.title)} · 任务` : '任务与打卡'}</h2></div>${detailPlan ? '<button class="btn sm soft" data-action="clearPlan">查看全部</button>' : ''}</div>
      ${renderTaskList(shownTasks, 'full') || '<div class="empty compact">暂时没有可显示的任务</div>'}
    </section>`;

  c.querySelectorAll('[data-sup-person]').forEach((button) => {
    button.setAttribute('aria-pressed',String(button.dataset.supPerson===selectedPerson));
    button.onclick = () => {
      const left=c.querySelector('.supervisor-people-tabs').scrollLeft;
      const top=window.scrollY;
      st.supervisorGoalPerson = button.dataset.supPerson; st.filterPlan = null; renderSupervisorGoals(c);
      c.querySelector('.supervisor-people-tabs').scrollLeft=left;
      window.scrollTo(0,top);
    };
  });
  c.querySelectorAll('[data-sup-status]').forEach((button) => {
    button.onclick = () => {
      const left=c.querySelector('.supervisor-people-tabs')?.scrollLeft||0;
      const top=window.scrollY;
      st.supervisorGoalStatus = button.dataset.supStatus; st.filterPlan = null; renderSupervisorGoals(c);
      const rail=c.querySelector('.supervisor-people-tabs');if(rail)rail.scrollLeft=left;
      window.scrollTo(0,top);
    };
  });
  const createGoal = c.querySelector('#supervisor-new-goal');
  if (createGoal) createGoal.onclick = () => newGoalModal(selectedPerson === 'all' ? undefined : selectedPerson);
  phaseWire(c); wireWork(c); wireAgreements(c); phaseEnsureDays(c);
}

// ---------- 被监督者目标页：自己的计划与今天行动 ----------
function renderSuperviseeGoals(c) {
  const supportPlansHTML = renderPlansList();
  const hasTasks = st.tasks.length > 0;
  const filt = st.tasks.filter((t) => {
    if (st.filterPlan && t.planId !== st.filterPlan) return false;
    if (st.filterStatus === 'pending' && t.status !== 'pending') return false;
    if (st.filterStatus === 'done' && t.status !== 'done') return false;
    if (st.filterStatus === 'overdue' && !isOverdue(t)) return false;
    return true;
  }).sort((a, b) => (a.status === 'done' ? 1 : 0) - (b.status === 'done' ? 1 : 0) || (a.dueAt || a.createdAt) - (b.dueAt || b.createdAt));

  const statuses = [['all', '全部'], ['pending', '待完成'], ['overdue', '已超时'], ['done', '已完成']];
  c.innerHTML = `
  <div class="row spread" style="margin-bottom:18px">
    <div><h1 style="margin:0">我的目标</h1></div>
    <div class="row">
      <button class="btn sm" id="newtask">+ 临时任务</button>
    </div>
  </div>

  ${phaseSectionHTML()}

  ${hasTasks ? `<div class="card task-filter-card" style="margin-bottom:16px">
    <div class="row spread">
      <div class="row">
        ${statuses.map(([k, v]) => `<button class="btn sm ${st.filterStatus === k ? '' : 'soft'}" data-status="${k}">${v}</button>`).join('')}
      </div>
      ${st.filterPlan ? `<button class="btn sm soft" data-action="clearPlan">清除计划筛选${st.filterPlan ? ':' + esc((st.plans.find(p=>p.id===st.filterPlan)||{}).title || '') : ''}</button>` : ''}
    </div>
  </div>` : ''}

  ${supportPlansHTML ? `<div class="card support-plans-card" style="margin-bottom:16px">
    <div class="section-heading"><div><h2>补充监督计划</h2></div></div>
    ${supportPlansHTML}
  </div>` : ''}

  ${hasTasks ? `<div class="card">
    <div class="section-heading"><div><h2>${st.filterPlan ? '计划任务' : '今日行动'}</h2></div></div>
    ${renderTaskList(filt, 'full') || '<div class="empty">没有符合条件的任务</div>'}
  </div>` : ''}`;

  c.querySelectorAll('[data-status]').forEach((b) => {
    b.onclick = () => { st.filterStatus = b.dataset.status; renderTasks(c); };
  });
  const np = $('#newplan'); if (np) np.onclick = () => planModal();
  const nt = $('#newtask'); if (nt) nt.onclick = () => taskModal();
  phaseWire(c);
  wireWork(c); wireAgreements(c);
  phaseEnsureDays(c);
}

function renderTasks(c) {
  if (me.role === 'supervisor') return renderSupervisorGoals(c);
  return renderSuperviseeGoals(c);
}

// ---------- 计划/任务/打卡交互（全局委托，任意页面生效） ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const id = el.dataset.id;

  if (action === 'openPlan') {
    st.filterPlan = id; goView('tasks'); return;
  }
  if (action === 'clearPlan') {
    st.filterPlan = null; if (st.view === 'tasks') renderView(); return;
  }
  if (action === 'archivePlan') {
    const plan=st.plans.find(p=>p.id===id);
    if (!confirm(plan?.status==='proposed' ? (plan.parentId ? '撤销这个待接受阶段？记录保留，可重新追加调整后的阶段。' : '撤销这份待接受计划？整套安排保留为历史，原协商可重新制定计划。') : '结束并归档这个计划？未完成任务将取消，打卡和复盘停止操作，已有记录保留。续期请使用“追加阶段”，无需归档。')) return;
    try { await api('POST', `/api/plans/${id}/archive`); await loadSection(); renderView(); toast('计划已归档'); } catch (err) { toast(err.message); }
    return;
  }
  if (action === 'serviceReview') {
    serviceReviewModal(id);
    return;
  }

  if (action === 'toggle') {
    const selected=st.tasks.find(t=>t.id===id);
    if(selected && selected.creatorId!==selected.assigneeId){await openTask(id);return;}
    const task = st.tasks.find((t) => t.id === id);
    if (!task) return;
    try {
      if (task.status === 'done') {
        await api('POST', `/api/tasks/${id}/uncheck`);
        toast('已取消完成');
      } else {
        await api('POST', `/api/tasks/${id}/checkin`, { note: '' });
        toast('打卡成功 ✓');
      }
      await loadSection();
      renderView();
    } catch (err) { toast(err.message); }
  }

  if (action === 'del') {
    if (!confirm('确定删除这条任务？')) return;
    try { await api('DELETE', `/api/tasks/${id}`); await loadSection(); renderView(); toast('已删除'); } catch (err) { toast(err.message); }
  }
  if (action === 'cancelTask') {
    if (!confirm('取消这项未完成任务？已有安排与提交内容会保留。')) return;
    try { await api('POST', `/api/tasks/${id}/cancel`); await loadSection(); renderView(); toast('任务已取消，记录保留'); } catch (err) { toast(err.message); }
  }

  if (action === 'logout') {
    await doLogout();
  }
});

async function planModal(presetId) {
  const session=token,originView=st.view,originScroll=window.scrollY;
  let editor,submitting=false;
  const opts = people.filter((p) => p.relationship === 'managed').map((p) => `<option value="${p.id}">${esc(p.displayName)}（@${esc(p.username)}）</option>`).join('');
  openModal('新建监督计划', `
    <label>计划标题</label><input id="pm-title" placeholder="例如：期末复习计划" />
    <label>指派给（要监督的被监督者）</label>
    <select id="pm-assignee"><option value="">请选择被监督者</option>${opts}</select>
    <div class="row">
      <div style="flex:1"><label>开始时间</label><input id="pm-start" type="datetime-local" value="${toLocalInput(Date.now())}" /></div>
      <div style="flex:1"><label>截止时间</label><input id="pm-due" type="datetime-local" /></div>
    </div>
    <label>提前几分钟提醒</label><input id="pm-remind" type="number" value="30" min="0" />
    <label>说明</label><textarea id="pm-desc" placeholder="这个计划要做什么、怎么监督"></textarea>
  `, async () => {
    if(submitting)return;
    const field=selector=>editor.querySelector(selector);
    const assigneeId = field('#pm-assignee').value;
    if (!assigneeId) { toast('请选择要指派的被监督者'); return; }
    const body = {
      title: field('#pm-title').value.trim(),
      assigneeId,
      startAt: field('#pm-start').value ? fromLocalInput(field('#pm-start').value) : null,
      dueAt: field('#pm-due').value ? fromLocalInput(field('#pm-due').value) : null,
      remindBeforeMinutes: Number(field('#pm-remind').value),
      description: field('#pm-desc').value.trim(),
    };
    if (!body.title) { toast('请填写计划标题'); return; }
    submitting=true;const unlock=lockTaskEditor(editor);
    try { await api('POST', '/api/plans', body); await refreshTaskWrite('计划已创建',editor,session,originView,originScroll); }
    catch (e) { toast(e.message); }
    finally{unlock();submitting=false;}
  });
  editor=$modal.querySelector('.dialog');
  if (presetId) { const sel = $('#pm-assignee'); if (sel) { const o = sel.querySelector('option[value="' + presetId + '"]'); if (o) sel.value = presetId; } }
}

async function taskModal(presetId) {
  const session=token,originView=st.view,originScroll=window.scrollY;
  let editor,submitting=false;
  const isSup = me.role === 'supervisor';
  const whoOpts = isSup
    ? people.filter((p) => p.relationship === 'managed').map((p) => `<option value="${p.id}">${esc(p.displayName)}（@${esc(p.username)}）</option>`).join('')
    : `<option value="${me.id}">我（${esc(me.displayName)}）</option>`;
  const planOpts = st.plans.filter((p) => p.status === 'active' && (p.kind || 'task') === 'task').map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('');
  openModal('新建任务', `
    <label>任务标题</label><input id="tm-title" placeholder="例如：完成第三章习题" />
    <label>指派给${isSup ? '（要监督的被监督者）' : ''}</label>
    <select id="tm-assignee" ${isSup ? '' : 'disabled'}>${isSup ? '<option value="">请选择被监督者</option>' : ''}${whoOpts}</select>
    ${planOpts ? `<label>所属监督计划（可留空）</label><select id="tm-plan"><option value="">不关联计划</option>${planOpts}</select>` : ''}
    <div class="row">
      <div style="flex:1"><label>截止时间</label><input id="tm-due" type="datetime-local" /></div>
      <div style="flex:1"><label>提前几分钟提醒</label><input id="tm-remind" type="number" value="30" min="0" /></div>
    </div>
    <label>备注</label><textarea id="tm-note" placeholder="选填"></textarea>
  `, async () => {
    if(submitting)return;
    const field=selector=>editor.querySelector(selector);
    const body = {
      title: field('#tm-title').value.trim(),
      assigneeId: field('#tm-assignee').value,
      planId: field('#tm-plan') ? field('#tm-plan').value || null : null,
      dueAt: field('#tm-due').value ? fromLocalInput(field('#tm-due').value) : null,
      remindBeforeMinutes: Number(field('#tm-remind').value),
      note: field('#tm-note').value.trim(),
    };
    if (!body.title) { toast('请填写任务标题'); return; }
    if (isSup && !body.assigneeId) { toast('请选择要指派的被监督者'); return; }
    submitting=true;const unlock=lockTaskEditor(editor);
    try { await api('POST', '/api/tasks', body); await refreshTaskWrite('任务已创建',editor,session,originView,originScroll); }
    catch (e) { toast(e.message); }
    finally{unlock();submitting=false;}
  });
  editor=$modal.querySelector('.dialog');
  const syncPlans=()=>{const select=$('#tm-plan');if(!select)return;const selected=select.value;select.innerHTML='<option value="">不关联计划</option>'+st.plans.filter(p=>p.status==='active'&&p.assigneeId===$('#tm-assignee').value&&(p.creatorId===me.id||p.assigneeId===me.id)&&(p.kind||'task')==='task').map(p=>`<option value="${p.id}">${esc(p.title)}</option>`).join('');if([...select.options].some(o=>o.value===selected))select.value=selected;};
  $('#tm-assignee').addEventListener('change',syncPlans);
  if (presetId) { const sel = $('#tm-assignee'); if (sel) { const o = sel.querySelector('option[value="' + presetId + '"]'); if (o) sel.value = presetId; } }
  syncPlans();
}

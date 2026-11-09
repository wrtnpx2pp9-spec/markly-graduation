/* Markly · 角色专属首页：监督者 / 被监督者（移动优先） */
'use strict';

// ---------- 工具 ----------
function homeGreet() {
  const h = new Date().getHours();
  return h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
}
function homeDateStr() {
  return new Date().toLocaleDateString('zh-CN', { timeZone:typeof serviceTimezone==='string'?serviceTimezone:undefined,month: 'long', day: 'numeric', weekday: 'long' });
}
function homeDayStart() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}
function homeToday(tasks) {
  return tasks.filter((t) => t.dueAt!=null && toLocalInput(t.dueAt).slice(0,10)===todayStr());
}
function homeTodayPlanDays(days) {
  const today = todayStr();
  return (days || []).filter((d) => d.dayDate === today && !['approved','submitted','cancelled'].includes(d.checkinState));
}

// One item belongs to one primary queue. Secondary help status stays on its card.
function buildHomeWorklist({user,days=[],tasks=[],plans=[],today,dateOf=ts=>toLocalInput(ts).slice(0,10)}) {
  const groups={reviews:[],help:[],overdue:[],today:[],undated:[],waiting:[]};
  const supervisor=user.role==='supervisor',planMap=new Map(plans.map(plan=>[plan.id,plan]));
  const seen=new Set();
  function add(group,kind,item,date,sortAt){
    const key=kind+':'+item.id;if(seen.has(key))return;seen.add(key);
    groups[group].push({key,kind,item,date:date||'',sortAt:Number(sortAt)||0});
  }
  for(const day of days){
    if((supervisor?day.creatorId:day.assigneeId)!==user.id)continue;
    if(planMap.has(day.planId)&&planMap.get(day.planId).status!=='active')continue;
    const state=day.checkinState||(day.status==='done'?'approved':'unsubmitted');
    if(state==='cancelled')continue;
    const help=!!day.helpNote&&!day.helpReply;
    const date=day.dayDate,at=day.checkinSubmittedAt??Date.parse(date+'T00:00:00Z')??day.createdAt;
    if(state==='submitted'){add(supervisor?'reviews':'waiting','day',day,date,at);continue;}
    if(supervisor&&help){add('help','day',day,date,at);continue;}
    if(state!=='approved'&&date<=today){add(date<today?'overdue':'today','day',day,date,day.createdAt);continue;}
    if(!supervisor&&help)add('waiting','day',day,date,at);
  }
  for(const task of tasks){
    if((supervisor?task.creatorId:task.assigneeId)!==user.id)continue;
    if(task.planId&&planMap.get(task.planId)?.status!=='active')continue;
    if(!['pending','submitted'].includes(task.status))continue;
    const date=task.dueAt!=null?dateOf(task.dueAt):'';
    // Tasks do not expose a submission timestamp: use existing due/created dates.
    const at=task.dueAt??task.createdAt;
    if(task.status==='submitted'){add(supervisor?'reviews':'waiting','task',task,date,at);continue;}
    if(!date)add('undated','task',task,'',at);
    else if(date<=today)add(date<today?'overdue':'today','task',task,date,at);
  }
  for(const [group,rows] of Object.entries(groups))rows.sort((a,b)=>
    (['reviews','waiting'].includes(group)?a.sortAt-b.sortAt:a.date.localeCompare(b.date)||a.sortAt-b.sortAt)||a.key.localeCompare(b.key));
  return {groups,actionable:Object.entries(groups).filter(([key])=>key!=='waiting').reduce((n,[,rows])=>n+rows.length,0),waiting:groups.waiting.length};
}
function homePendingStatus(tasks=st.tasks||[],days=st.workDays||[],plans=st.plans||[]) {
  tasks=tasks.filter(t=>t.status!=='cancelled'&&(!t.planId||plans.some(p=>p.id===t.planId&&p.status==='active')));
  const planMap=new Map(plans.map(plan=>[plan.id,plan]));
  days=days.filter(d=>d.checkinState!=='cancelled'&&(!planMap.has(d.planId)||planMap.get(d.planId).status==='active'));
  const today=todayStr(),pending=tasks.filter(t=>t.status==='pending');
  const incomplete=days.filter(d=>!['submitted','approved'].includes(d.checkinState));
  const lateDays=incomplete.filter(d=>d.dayDate<today).length;
  const lateTasks=pending.filter(t=>t.dueAt!=null&&toLocalInput(t.dueAt).slice(0,10)<today).length;
  const todayCount=homeToday(pending).length+homeTodayPlanDays(days).length;
  const undated=pending.filter(t=>t.dueAt==null).length;
  const waiting=tasks.filter(t=>t.status==='submitted').length+days.filter(d=>d.checkinState==='submitted').length;
  const help=days.filter(d=>d.helpNote&&!d.helpReply).length;
  if(lateDays)return `有 <b>${lateDays}</b> 天待补交${lateTasks?` · ${lateTasks} 项任务逾期`:''}`;
  if(lateTasks)return `有 <b>${lateTasks}</b> 项逾期待办`;
  if(todayCount)return `今天还有 <b>${todayCount}</b> 件待办`;
  if(undated)return `有 <b>${undated}</b> 项未设截止的待办`;
  if(waiting)return `有 <b>${waiting}</b> 件已提交，等待确认`;
  if(help)return `有 <b>${help}</b> 项困难等待回复`;
  if(plans.some(p=>p.status==='proposed'))return '有新的计划约定待确认';
  if(pending.length||incomplete.length)return '今天没有到期的待办，未来安排已保留';
  if(tasks.length+days.length&&tasks.every(t=>t.status==='done')&&days.every(d=>d.checkinState==='approved'))return '任务都完成啦 🎉';
  return '还没有安排任务';
}

// 进度环（复用 .arcglass，唯一渐变 id）
function homeRing(donePct, sub, fromPct = donePct) {
  homeRing._i = (homeRing._i || 0) + 1;
  const gid = 'agrad-h' + homeRing._i;
  return `
  <div class="arcglass" title="${esc(sub)}">
    <svg class="arc" viewBox="0 0 200 200" aria-hidden="true">
      <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="var(--brand)"/><stop offset="100%" stop-color="var(--brand-2, var(--brand))"/>
      </linearGradient></defs>
      <path class="track" d="M43.4 156.6 A80 80 0 1 1 156.6 156.6" pathLength="100"/>
      <path class="prog" d="M43.4 156.6 A80 80 0 1 1 156.6 156.6" pathLength="100"
            style="stroke:url(#${gid})" data-home-progress="${donePct}" stroke-dasharray="${fromPct} 100"/>
    </svg>
    <div class="arcval"><b>${donePct}%</b><span>${esc(sub)}</span></div>
  </div>`;
}
function homeProgressStart(c, next) {
  const previous = c.querySelector('[data-home-progress]');
  if (!previous) return next;
  const value = parseFloat(typeof getComputedStyle === 'function'
    ? getComputedStyle(previous).strokeDasharray : previous.getAttribute('stroke-dasharray'));
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : next;
}
function animateHomeProgress(c) {
  c.querySelectorAll('[data-home-progress]').forEach(path => {
    const target = path.getAttribute('data-home-progress') + ' 100';
    if (path.getAttribute('stroke-dasharray') === target) return;
    if (typeof prefersReducedMotion === 'function' && prefersReducedMotion()) {
      path.setAttribute('stroke-dasharray', target);
      return;
    }
    // Preserve the old painted value when a refresh replaces this path. This also
    // handles a second refresh while the preceding progress transition is running.
    path.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (path.isConnected && c.contains(path)) path.setAttribute('stroke-dasharray', target);
    });
  });
}

// ---------- 排行榜（组内 / 全平台 × 计划内 / 今日完成 / 今日打卡） ----------
const RANK_SCOPES = [['group', '组内'], ['all', '全平台']];
const RANK_DIMS = [['plan', '计划'], ['today', '今日完成'], ['checkin', '今日打卡']];
const RANK_MEDALS = ['🥇', '🥈', '🥉'];

function rankCardHTML() {
  return `
  <div class="card home-card rank-card">
    <div class="hc-head"><div><h2>排行榜</h2><span class="rk-date muted" data-rank-date></span></div></div>
    <div class="rk-control"><span class="rk-control-label">范围</span><div class="rk-types" role="group" aria-label="排行榜范围">
      ${RANK_SCOPES.map(([k, v]) => `
        <button class="rk-type ${st.rank.scope === k ? 'active' : ''}" data-rs="${k}" aria-pressed="${st.rank.scope === k}"><span class="rk-label">${v}</span></button>`).join('')}
    </div></div>
    <div class="rk-control"><span class="rk-control-label">维度</span>
    <div class="rk-seg rk-dims" role="group" aria-label="排行榜维度">
      ${RANK_DIMS.map(([k, v]) => `<button class="btn sm ${st.rank.dim === k ? '' : 'soft'}" data-rd="${k}" aria-pressed="${st.rank.dim === k}">${v}</button>`).join('')}
    </div>
    </div>
    <div class="rk-body" id="rank-body"><div class="empty">加载中…</div></div>
  </div>`;
}

async function wireRank(c) {
  const card = c.querySelector('.rank-card');
  if (!card) return;
  const body = card.querySelector('#rank-body');
  if (!body) return;
  card.querySelectorAll('[data-rs]').forEach((b) => {
    b.onclick = () => { st.rank.scope = b.dataset.rs; wireRank(c); };
  });
  card.querySelectorAll('[data-rd]').forEach((b) => {
    b.onclick = () => { st.rank.dim = b.dataset.rd; wireRank(c); };
  });
  // 刷新选中态：范围用“大类型”，维度用小按钮
  card.querySelectorAll('[data-rs]').forEach((b) => { const active=b.dataset.rs === st.rank.scope;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active)); });
  card.querySelectorAll('[data-rd]').forEach((b) => { const active=b.dataset.rd === st.rank.dim;b.classList.toggle('soft',!active);b.setAttribute('aria-pressed',String(active)); });
  const dateEl = card.querySelector('[data-rank-date]');
  const request=card._rankRequest=(card._rankRequest||0)+1;
  const scope=st.rank.scope,dim=st.rank.dim;
  body.style.minHeight=Math.max(body.getBoundingClientRect().height,110)+'px';
  body.setAttribute('aria-busy','true');
  try {
    const d = await api('GET', '/api/rank?scope=' + st.rank.scope + '&dim=' + st.rank.dim);
    if(!card.isConnected || request!==card._rankRequest)return;
    if (dateEl) dateEl.textContent = d.date || '';
    const list = d.list || [];
    if (!list.length) {
      body.innerHTML = `<div class="empty">${st.rank.scope === 'group' ? '还没有同组伙伴，切到「全平台」看看大家吧' : '今天还没人上榜，快去完成任务打卡吧'}</div>`;
      return;
    }
    const shown = list.slice(0, 5);
    const meIdx = list.findIndex((x) => x.id === me.id);
    let html = shown.map((x, i) => rankRow(x, i)).join('');
    if (meIdx >= 5) {
      html += `<div class="rk-divider"><span>…</span></div>` + rankRow(list[meIdx], meIdx);
    }
    body.innerHTML = html;
  } catch (e) {
    if(card.isConnected&&request===card._rankRequest)body.innerHTML = '<div class="empty">榜单加载失败，请重新选择重试</div>';
  } finally { if(request===card._rankRequest)body.removeAttribute('aria-busy'); }
}
function rankRow(x, i) {
  const position = Number.isInteger(x.rank) ? x.rank : i + 1;
  const medal = position <= 3 ? `<i class="rk-medal">${RANK_MEDALS[position - 1]}</i>` : `<i class="rk-num">${position}</i>`;
  const isMe = x.id === me.id;
  return `<div class="rk-row ${isMe ? 'me' : ''}">
    <div class="rk-rank">${medal}</div>
    ${avatarHTML(x, 'sm')}
    <div class="rk-name">${esc(x.displayName)}${isMe ? '<span class="rk-me">我</span>' : ''}</div>
    <div class="rk-val"><b>${esc(x.label)}</b><i>${esc(x.sub)}</i><i>近7天 ${x.recentDone || 0}/${x.recentTotal || 0} · ${x.recentCompletionRate || 0}% · 活跃 ${x.recentActiveDays || 0} 天</i></div>
  </div>`;
}

// ---------- 监督者：单个被监督者的统计 ----------
function supPersonStat(s) {
  const tasks = st.tasks || [];
  const mine = tasks.filter((t) => t.assigneeId === s.id);
  const total = mine.length;
  const doneN = mine.filter((t) => t.status === 'done').length;
  const od = mine.filter((t) => isOverdue(t)).length;
  const pct = total ? Math.round((doneN / total) * 100) : 0;
  const cur = mine.filter((t) => t.status === 'pending').sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0))[0];
  return { total, doneN, od, pct, cur };
}

// 被监督者 -> 可展开卡片（含他的计划与完成度），用于监督者“中间”页
function svItemHTML(s) {
  const { total, doneN, od, pct, cur } = supPersonStat(s);
  const tasks = st.tasks || [];
  const plans = (st.plans || []).filter((p) => p.assigneeId === s.id && (p.kind || 'task') === 'task').slice()
    .sort((a, b) => ((a.status === 'archived') - (b.status === 'archived')) || ((b.createdAt || 0) - (a.createdAt || 0)));
  return `
  <div class="sv-item">
    <button class="sv-main" data-see="${s.id}">
      ${avatarHTML(s, 'sm')}
      <div class="sv-info">
        <div class="sv-name">${esc(s.displayName)}<span class="muted" style="font-size:11px;font-weight:400"> @${esc(s.username)}</span></div>
        <div class="sv-cur muted">${cur
          ? '进行中：' + esc(cur.title) + (cur.dueAt ? ' · ' + fmtTime(cur.dueAt) + ' 到期' : '')
          : (total ? '已完成全部，暂无待办' : '还没有安排任务')}</div>
      </div>
      <div class="sv-pct"><b>${pct}%</b><i>完成度</i></div>
      <span class="sv-chev">▾</span>
    </button>
    <div class="sv-detail">
      <div class="sv-stats">
        <span>任务 <b>${total}</b></span>
        <span>完成 <b class="ok">${doneN}</b></span>
        ${od ? `<span class="sv-od">超时 <b>${od}</b></span>` : '<span>暂无超时</span>'}
      </div>
      <div class="sv-plans">
        ${plans.length ? plans.map((pl) => {
          const pt = tasks.filter((t) => t.planId === pl.id && t.assigneeId === s.id);
          const dn = pt.filter((t) => t.status === 'done').length;
          const po = pt.filter(isOverdue).length;
          const pp = pt.length ? Math.round((dn / pt.length) * 100) : (pl.status === 'archived' ? 100 : 0);
          return `
          <div class="sv-plan">
            <div class="sv-plan-top">
              <b>${esc(pl.title)}</b>
              ${pl.status === 'archived' ? '<span class="pc-chip off">已归档</span>' : ''}
              ${po ? `<span class="pc-od">${po} 超时</span>` : ''}
              <button class="linkbtn" data-action="openPlan" data-id="${pl.id}">看任务</button>
            </div>
            <div class="sv-plan-sub muted">${_d2(pl.startAt) || '未设'} ~ ${_d2(pl.dueAt) || '未设'} · ${dn}/${pt.length || 0} 完成</div>
            <div class="pc-bar"><i style="width:${pp}%"></i></div>
          </div>`;
        }).join('') : '<div class="muted" style="font-size:12.5px;padding:2px 0 6px">还没有计划，可以给 TA 新建一个</div>'}
      </div>
      <div class="row" style="gap:8px;margin-top:2px">
        <button class="btn sm" data-planfor="${s.id}">＋ 新建计划给 TA</button>
        <button class="btn sm soft" data-taskfor="${s.id}">＋ 新建任务</button>
        <button class="btn sm soft" data-profile-link="${s.id}" data-profile-return="supervisees">查看主页</button>
      </div>
    </div>
  </div>`;
}

function svAccordionWire(c) {
  c.querySelectorAll('.sv-main[data-see]').forEach((b) => {
    b.onclick = () => {
      const item = b.closest('.sv-item');
      c.querySelectorAll('.sv-item.open').forEach((x) => { if (x !== item) x.classList.remove('open'); });
      item.classList.toggle('open');
    };
  });
  c.querySelectorAll('[data-planfor]').forEach((b) => { b.onclick = () => newGoalModal(b.dataset.planfor); });
  c.querySelectorAll('[data-taskfor]').forEach((b) => { b.onclick = () => taskModal(b.dataset.taskfor); });
}

// ---------- 监督者“中间”页：我监督的人（列表控件） ----------
function renderSuperviseesView(c) {
  const supervisees = people.filter((person) => person.relationship === 'managed');
  const available = people.filter((person) => person.relationship === 'available');
  const used = me.supervision?.used ?? supervisees.length;
  const capacity = me.supervision?.capacity ?? supervisees.length;
  c.innerHTML = `
  <div class="row spread page-head" style="margin-bottom:10px">
    <div><h1 style="margin:0">我监督的人</h1><div class="muted" style="font-size:12px;margin-top:4px">当前容量 ${used}/${capacity}</div></div>
    ${supervisees.length ? '<button class="btn sm" id="sv-newplan">＋ 新建计划</button>' : ''}
  </div>
  <div class="card">
    ${supervisees.length
      ? supervisees.map((s) => svItemHTML(s)).join('')
      : '<div class="empty">还没有监督对象，须经平台审核合作资格并分配服务人数后承接服务</div>'}
  </div>
  ${available.length && used < capacity ? `
  <div class="card" style="margin-top:12px">
    <div class="hc-head"><h2>待绑定</h2><span class="muted">双方确认约定后开始合作</span></div>
    ${available.map((person) => `<div class="attn-row">
      ${avatarHTML(person, 'sm')}
      <div class="attn-info"><div class="attn-name">${esc(person.displayName)}</div><div class="muted" style="font-size:12px">仅展示公开昵称，暂不可查看业务数据</div></div>
      <button class="btn sm" data-bind-supervisee="${person.id}">邀请协商</button>
    </div>`).join('')}
  </div>` : ''}`;
  const np = c.querySelector('#sv-newplan'); if (np) np.onclick = () => newGoalModal();
  c.querySelectorAll('[data-bind-supervisee]').forEach((button) => {
    button.onclick = async () => {
      try {
        await startRequest(button.dataset.bindSupervisee);
      } catch (error) { toast(error.message); }
    };
  });
  svAccordionWire(c);
}

// ---------- 监督者专属首页（首页只放摘要，列表在“我监督的人”页） ----------
function renderSupervisorHome(c) {
  const tasks = st.tasks || [];
  const supervisees = people.filter((person) => person.relationship === 'managed');
  const superviseeIds = new Set(supervisees.map((person) => person.id));
  const scopedTasks = tasks.filter((task) => superviseeIds.has(task.assigneeId));
  const homeQueue=buildHomeWorklist({user:me,days:st.workDays||[],tasks,plans:st.plans||[],today:todayStr()});
  const pending = scopedTasks.filter((t) => t.status === 'pending');
  const done = scopedTasks.filter((t) => t.status === 'done');
  const overdue = pending.filter(isOverdue);
  const today = homeToday(scopedTasks);

  // 待跟进：按“我的人”汇总现在/本周需要留意的内容（只展示，不路由）
  const dayStart = homeDayStart();
  const dayEnd = dayStart + 86400000;
  const weekEnd = dayStart + 7 * 86400000;
  const attn = supervisees.map((s) => {
    const mine = tasks.filter((t) => t.assigneeId === s.id && t.status === 'pending');
    const over = mine.filter(isOverdue).length;
    const todayN = mine.filter((t) => t.dueAt && t.dueAt >= dayStart && t.dueAt < dayEnd).length;
    const weekN = mine.filter((t) => t.dueAt && t.dueAt >= dayEnd && t.dueAt < weekEnd).length;
    return { s, over, today: todayN, week: weekN };
  }).filter((x) => x.over || x.today || x.week)
    .sort((a, b) => (b.over - a.over) || (b.today - a.today) || (b.week - a.week));

  c.innerHTML = `
  <div class="home-hero">
    <div class="hh-top">
      <div>
        <div class="hh-greet">${homeGreet()}</div>
        <h1>${esc(me.displayName)}</h1>
        <div class="hh-sub">${homeDateStr()} · 监督 ${supervisees.length} 位</div>
        <div class="hh-status" data-home-work-status>有 ${homeQueue.actionable} 件待我处理</div>
      </div>
      <span class="hh-role">Supervisor</span>
    </div>
  </div>

  <div class="grid stats home-stats">
    <div class="card stat"><div class="num">${pending.length}</div><div class="lbl">待完成</div></div>
    <div class="card stat"><div class="num">${today.length}</div><div class="lbl">今日到期</div></div>
    <div class="card stat ${overdue.length ? 'danger' : 'ok'}"><div class="num">${overdue.length}</div><div class="lbl">已超时</div></div>
    <div class="card stat ok"><div class="num">${done.length}</div><div class="lbl">已完成</div></div>
  </div>

  <div class="card home-card">
    <div class="hc-head"><h2>待跟进</h2></div>
    <div class="sub-muted">按我监督的人 · 现在 / 本周</div>
    ${attn.length ? attn.map(({ s, over, today: todayN, week }) => `
      <div class="attn-row">
        ${avatarHTML(s, 'sm')}
        <div class="attn-info">
          <div class="attn-name">${esc(s.displayName)}<span class="muted" style="font-size:11px;font-weight:400"> @${esc(s.username)}</span></div>
          <div class="attn-chips">
            ${over ? `<span class="attn-chip danger">已超时 ${over}</span>` : ''}
            ${todayN ? `<span class="attn-chip">今日到期 ${todayN}</span>` : ''}
            ${week ? `<span class="attn-chip">近几天到期 ${week}</span>` : ''}
          </div>
        </div>
      </div>`).join('')
      : '<div class="empty">暂无近期到期的普通任务，其他事项见上方全部待处理。</div>'}
  </div>

  ${rankCardHTML()}`;

  c.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => { goView(b.dataset.goto); }; });
  wireRank(c);
}
// ---------- 被监督者专属首页：聚焦「自己执行 + 打卡」 ----------
function renderSuperviseeHome(c) {
  const activePlans=new Set((st.plans||[]).filter(p=>p.status==='active').map(p=>p.id));
  const tasks = (st.tasks || []).filter(t=>t.status!=='cancelled'&&(!t.planId||activePlans.has(t.planId)));
  const planDays = (st.workDays || []).filter(d=>d.checkinState!=='cancelled'&&activePlans.has(d.planId));
  const pending = tasks.filter((t) => t.status === 'pending');
  const done = tasks.filter((t) => t.status === 'done');
  const pendingPlanDays = planDays.filter((d) => !['approved', 'submitted'].includes(d.checkinState));
  const donePlanDays = planDays.filter((d) => d.checkinState === 'approved');
  const overdue = pending.filter(isOverdue);
  const totalItems = tasks.length + planDays.length;
  const doneItems = done.length + donePlanDays.length;
  const donePct = totalItems ? Math.round((doneItems / totalItems) * 100) : 0;
  const fromPct = homeProgressStart(c, donePct);
  const today = homeToday(pending);
  const todayPlanDays = homeTodayPlanDays(planDays);
  const overduePlanDays = planDays.filter((d) => d.dayDate < todayStr() && !['approved', 'submitted'].includes(d.checkinState));
  const todo = pending.slice().sort((a, b) => (a.dueAt || a.createdAt) - (b.dueAt || b.createdAt));
  const supervisorIds = me.supervision?.supervisorIds || [];
  const mySupervisors = people.filter((person) => supervisorIds.includes(person.id));
  const relationshipPeople = [{ person: me, identity: me.identity === 'mentee' ? 'Mentee' : 'Supervisee', leader: false }]
    .concat(mySupervisors.map((person) => ({ person, identity: person.identity === 'mentor' ? 'Mentor' : 'Supervisor', leader: true })))
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => {
      const order = { male: 0, female: 1 };
      const aGender = a.person.gender || 'unspecified', bGender = b.person.gender || 'unspecified';
      if (order[aGender] !== undefined && order[bGender] !== undefined && order[aGender] !== order[bGender]) return order[aGender] - order[bGender];
      if (aGender === bGender && aGender === 'male') return Number(b.leader) - Number(a.leader);
      if (aGender === bGender && aGender === 'female') return Number(a.leader) - Number(b.leader);
      return a.index - b.index;
    });
  const waitingCount=tasks.filter(t=>t.status==='submitted').length+planDays.filter(d=>d.checkinState==='submitted').length;
  const todayPendingCount = today.length + todayPlanDays.length;
  const statusLine = homePendingStatus();

  c.innerHTML = `
  <div class="home-hero">
    <div class="hh-top">
      <div class="hh-person-copy">
        <div class="hh-greet">${homeGreet()}</div>
        <h1>${esc(me.displayName)}</h1>
        <div class="hh-sub">${homeDateStr()}</div>
        <div class="hh-status" data-home-work-status>${statusLine}</div>
      </div>
      <div class="hh-self">
        <div class="hh-people">
          ${relationshipPeople.map(({ person, identity, leader }) => `<div class="hh-person-card${leader ? ' leader' : ''}">
            ${avatarHTML(person, 'hh-avatar')}
            <span class="hh-person-name">${esc(person.displayName)}</span>
            <span class="hh-role">${identity}</span>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>

  <div class="card home-card">
    <div class="hc-head"><h2>我的进度</h2></div>
    <div class="home-ringcard">
      ${homeRing(donePct, '当前安排确认率', fromPct)}
      <div class="hr-txt">
        <b>${doneItems}</b><span class="muted"> / ${totalItems} 已确认</span>
        <p>${overdue.length+overduePlanDays.length ? `有 ${overdue.length+overduePlanDays.length} 项待补交，可以从一件开始` : '保持节奏，慢慢来'}${todayPendingCount ? ` · 今天还剩 ${todayPendingCount} 件` : ''}</p>
      </div>
    </div>
  </div>

  ${rankCardHTML()}`;

  animateHomeProgress(c);
  c.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => { goView(b.dataset.goto); }; });
  wireRank(c);
}

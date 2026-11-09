/* Cooperation history is loaded independently of the current goals workspace. */
'use strict';
function historyPlanLabel(p) {
  if(p.completed)return '已完成';
  return ({archived:'已归档 · 未全部完成',proposed:'待接受',declined:'未接受'})[p.status] || (p.activeRelation||p.creatorId===p.assigneeId?'进行中':'历史计划');
}
async function renderCooperationHistory(c) {
  const generation=(c._historyGeneration||0)+1;c._historyGeneration=generation;
  const session=token,userId=me.id;
  const currentPage=()=>session===token&&userId===me?.id&&st.view==='history'&&c.isConnected&&c._historyGeneration===generation;
  st.history ||= {personId:'',periodId:'',q:'',offset:0};
  const state={...st.history};
  c.innerHTML='<h1>合作记录</h1><p class="muted">正在读取合作与执行记录…</p>';
  try {
    const query=new URLSearchParams({personId:state.personId,periodId:state.periodId||'',q:state.q,offset:String(state.offset)});
    const [peopleResult,result]=await Promise.all([api('GET','/api/cooperation-history'),api('GET','/api/cooperation-history/plans?'+query)]);
    if(!currentPage())return;
    const selected=peopleResult.list.find(p=>p.personId===state.personId);
    c.innerHTML=`<button class="page-back" id="history-back">← 返回我的</button><div class="row spread"><h1>合作记录</h1><button class="btn soft" id="history-current">当前目标</button></div>
      <form class="card" id="history-search"><label>合作对象<select id="history-person"><option value="">全部合作与个人计划</option>${peopleResult.list.map(p=>`<option value="${esc(p.personId)}" ${state.personId===p.personId?'selected':''}>${esc(p.displayName)} · ${p.active?'当前合作':'历史合作'}</option>`).join('')}</select></label>${selected?`<label>合作批次<select id="history-period"><option value="">全部批次</option>${selected.periods.map((p,i)=>`<option value="${esc(p.id)}" ${state.periodId===p.id?'selected':''}>第 ${selected.periods.length-i} 段 · ${fmtDate(p.startedAt)} — ${p.endedAt?fmtDate(p.endedAt):'至今'}</option>`).join('')}<option value="unassigned" ${state.periodId==='unassigned'?'selected':''}>旧记录（批次待确认）</option></select></label>`:''}<label>计划或阶段名称<input id="history-query" maxlength="100" value="${esc(state.q)}" placeholder="搜索历史目标或阶段"></label><button class="btn" type="submit">查询记录</button></form>
      ${selected?`<section class="card"><h2>与 ${esc(selected.displayName)} 的合作</h2>${selected.periods.map((p,i)=>`<p>第 ${selected.periods.length-i} 段合作 · ${fmtTime(p.startedAt)} — ${p.endedAt?fmtTime(p.endedAt):'至今'}</p>`).join('')||'<p class="muted">旧合作的起止时间未记录，执行记录仍然保留。</p>'}</section>`:''}
      <section aria-label="计划执行记录">${result.plans.map(p=>{const otherId=p.creatorId===me.id?p.assigneeId:p.creatorId;const person=peopleResult.list.find(x=>x.personId===otherId);return `<article class="card"><div class="row spread"><h2>${esc(p.title)}</h2><span class="pc-chip">${historyPlanLabel(p)}</span></div><p>${otherId===me.id?'个人计划':esc(person?.displayName||'历史合作对象')} · ${esc(p.calendarStart||'未指定开始')} — ${esc(p.calendarEnd||'未指定结束')}</p><p>已确认完成 ${p.done} / ${p.total} ${p.kind==='task'?'项任务':'天'}</p><button class="btn soft" data-history-plan="${esc(p.id)}">查看阶段与执行记录</button></article>`;}).join('')||'<div class="card empty">没有符合条件的记录。可更换合作对象或清空搜索词。</div>'}</section>
      <div class="row"><button class="btn soft" id="history-prev" ${state.offset?'':'disabled'}>上一页</button><button class="btn soft" id="history-next" ${result.nextOffset==null?'disabled':''}>下一页</button></div>`;
    c.querySelector('#history-back').onclick=()=>goView('my');c.querySelector('#history-current').onclick=()=>goView('tasks');
    c.querySelector('#history-search').onsubmit=e=>{e.preventDefault();st.history={personId:c.querySelector('#history-person').value,periodId:c.querySelector('#history-person').value===state.personId?(c.querySelector('#history-period')?.value||''):'',q:c.querySelector('#history-query').value.trim(),offset:0};renderCooperationHistory(c);};
    c.querySelector('#history-prev').onclick=()=>{st.history.offset=Math.max(0,state.offset-30);renderCooperationHistory(c);};
    c.querySelector('#history-next').onclick=()=>{st.history.offset=result.nextOffset;renderCooperationHistory(c);};
    c.querySelectorAll('[data-history-plan]').forEach(b=>b.onclick=async()=>{
      if(b.disabled||!currentPage())return;
      const currentRead=modalReadGuard();
      b.disabled=true;try{const detail=await api('GET','/api/cooperation-history/plans/'+encodeURIComponent(b.dataset.historyPlan));if(currentPage()&&currentRead())showHistoryPlan(detail);}catch(e){if(currentPage()&&currentRead())toast(e.message);}finally{b.disabled=false;}
    });
  } catch(e) {if(currentPage()){c.innerHTML=`<h1>合作记录</h1><p>${esc(e.message)}</p><button class="btn soft" id="history-retry">重新加载</button>`;c.querySelector('#history-retry')?.addEventListener('click',()=>renderCooperationHistory(c));}}
}
function historyDayHTML(d, archived=false) {
  const status=archived && d.checkinState==='submitted' ? '结束时已提交 · 未确认' : (({cancelled:'双方确认休息',approved:'已确认完成',submitted:'已提交 · 待确认',rejected:'需要补充',withdrawn:'已撤回'})[d.checkinState]||'未完成');
  return `<details class="plan-review-card"><summary>${esc(d.dayDate)} · ${status} · ${esc(d.content)}</summary>
    ${(d.items||[]).map(i=>`<p>${i.status==='done'?'✓':'○'} ${esc(i.title)}</p>`).join('')}
    ${d.note?`<p class="prewrap">执行记录：${esc(d.note)}</p>`:''}
    ${d.checkinSubmittedAt?`<p>提交时间：${fmtTime(d.checkinSubmittedAt)}</p>`:''}
    ${d.checkinReviewedAt?`<p>确认时间：${fmtTime(d.checkinReviewedAt)}</p>`:''}
    ${d.checkinReviewNote?`<p class="prewrap">审核反馈：${esc(d.checkinReviewNote)}</p>`:''}
    ${d.helpNote?`<p class="prewrap">困难说明：${esc(d.helpNote)}</p>`:''}${d.helpReply?`<p class="prewrap">困难回复：${esc(d.helpReply)}</p>`:''}
    ${(d.comments||[]).map(x=>`<p class="prewrap">${x.authorId===me.id?'我':'合作对象'} · ${fmtTime(x.createdAt)}<br>${esc(x.content)}</p>`).join('')}
  </details>`;
}
function historyReviewHTML(r) {
  if(!r)return '';
  const fields=[['自我复盘',r.selfSummary],['遇到的困难',r.selfDifficulty],['有效方法',r.helpfulMethod],['下一步',r.selfNextAction],['监督者观察',r.supervisorObservation],['进展评价',r.supervisorProgress],['后续建议',r.supervisorSuggestion],['阶段结论',r.resultLabel]];
  const snapshot=r.executionSnapshot;
  const stats=snapshot&&Number.isFinite(Number(snapshot.total))?`确认时统计：${Number(snapshot.done||0)}/${Number(snapshot.total)} 天（${Number(snapshot.percent||0)}%）`:'确认时统计：未记录';
  return `<section class="plan-review-card"><h3>阶段复盘与评价</h3>${r.lockedAt?`<p>双方确认于 ${fmtTime(r.lockedAt)} · ${stats}</p>`:'<p>尚未完成双方确认</p>'}${fields.filter(([,v])=>v).map(([k,v])=>`<p class="prewrap"><b>${k}</b><br>${esc(v)}</p>`).join('')}</section>`;
}
function historyDailyProposals(rows=[]) {
  const labels={draft:'草稿',submitted:'待确认',accepted:'已生效',declined:'已退回',withdrawn:'已撤回',closed:'已关闭'};
  return rows.map(r=>`<details class="plan-review-card"><summary>${esc(r.day_date)} · 每日安排${labels[r.status]||''}</summary><p>发起人：${r.proposer_id===me.id?'我':'对方'} · ${esc(r.reason)}</p><p>原安排：${esc(r.base?.day.content||'尚未安排')}</p><p>提案：${r.payload.rest?'休息':r.payload.items.map(i=>esc(i.title)).join('；')}</p><p>${esc(r.decision_note)}</p></details>`).join('');
}
function showHistoryPlan(detail) {
  const root=detail.records.find(p=>p.id===detail.rootId);
  openModal(root?.title||'历史执行记录',`<div class="history-records"><p class="muted">历史详情 · 仅查看 · 日程时区：${esc(root?.calendarTimezone||'')}</p>${[...(root?[root]:[]),...detail.records.filter(p=>p.id!==detail.rootId)].map(p=>`<section class="card"><h2>${esc(p.title)}</h2><p>${historyPlanLabel(p)}${p.reviewConfirmed?' · 复盘已确认':''} · ${esc(p.calendarStart||'')} — ${esc(p.calendarEnd||'')}</p><p class="prewrap">${esc(p.description||'')}</p>${historyReviewHTML(p.stageReview)}${historyDailyProposals(p.dailyProposals)}${p.days.map(d=>historyDayHTML(d,p.status==='archived')).join('')}${p.tasks.map(t=>`<details class="plan-review-card"><summary>${esc(t.title)} · ${({done:'已完成',pending:'未完成',submitted:'待审核',cancelled:'已取消'})[t.status]||esc(t.status)}</summary><p class="prewrap">${esc(t.note||'')}</p><p class="prewrap">${esc(t.checkinNote||'')}</p><p>截止：${fmtTime(t.dueAt)} · 完成：${fmtTime(t.doneAt)}</p></details>`).join('')}${p.kind==='cycle'&&!p.days.length?'<p>此阶段没有执行日记录。</p>':''}</section>`).join('')}</div>`,closeModal);
  $modal.querySelector('.dialog').classList.add('history-dialog');$('#modal-ok').textContent='关闭';$('#modal-cancel').hidden=true;$('#modal-ok').focus();
}

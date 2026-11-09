/* 用户主流程：今日行动、个人主页、平台监督团队、目标协商。 */
'use strict';
function publicProfileLink(id, returnTo = 'market') { st.profileId=id; st.profileReturn=returnTo; goView('profile'); }
document.addEventListener('click',(event)=>{const link=event.target.closest('[data-profile-link]');if(!link)return;event.preventDefault();event.stopPropagation();publicProfileLink(link.dataset.profileLink,link.dataset.profileReturn||'my');});
SIDEBAR_ITEMS.push({k:'registrations',label:'注册申请',icon:SIDEBAR_ITEMS[1].icon},{k:'certifications',label:'认证审核',icon:SIDEBAR_ITEMS[1].icon},{k:'my',label:'我的主页',icon:SIDEBAR_ITEMS[1].icon});
function certificationDirection(c) { return ({mentor:'Mentor · 导师',supervisor:'Supervisor · 监督者'})[c.direction]||'历史认证（未区分身份）'; }
function certificationApplication(c) {
  let a={};try{a=JSON.parse(c.application_json||'{}');}catch{}
  return `<p><b>认证方向：</b>${esc(certificationDirection(c))}</p>${a.skills?`<p><b>自填技能：</b>${esc(a.skills)}</p><p class="prewrap"><b>优势与经验：</b>${esc(a.strengths)}</p><p class="prewrap"><b>平常空闲时间：</b>${esc(a.availability)}</p><p><b>每周可投入：</b>${esc(a.weeklyMinutes)} 分钟</p><p class="prewrap"><b>服务方式：</b>${esc(a.serviceStyle)}</p>`:''}`;
}
function profileTags(p) {
  return `<div class="tag-list">${p.skills.map(s=>`<span class="skill-tag">${esc(s)}</span>`).join('')}${p.certifications.map(c=>`<span class="cert-tag" title="${esc(c.issuer)}">✓ ${esc(certificationDirection(c))} · ${esc(c.title)}</span>`).join('')}</div>`;
}
function metricHTML(s) {
  if(!s)return '';
  return `<div class="profile-metrics"><div><b>${s.completionRate==null?'暂无':s.completionRate+'%'}</b><span>历史确认完成率</span></div><div><b>${s.completed}/${s.total}</b><span>已确认 / 已到期事项</span></div><div><b>${s.rating==null?'暂无':s.rating+' / 5'}</b><span>${s.reviewCount} 条服务评价</span></div></div>`;
}
function requestStatus(r){return ({discussing:'协商中',planning:'监督者正在制定计划',plan_proposed:'计划待接受',accepted:'已正式开始',closed:'已关闭'})[r.status]||r.status;}
function requestCard(r) {
  const other=me.id===r.supervisor_id?r.supervisee_name:r.supervisor_name;
  const status=r.status==='planning'&&me.id===r.supervisor_id?'待我制定计划':requestStatus(r);
  return `<button class="request-row" data-request="${r.id}"><span><b>${esc(other)}</b><span>${esc(r.goal)}</span></span><span class="pc-chip">${status} →</span></button>`;
}
function wireRequests(c){c.querySelectorAll('[data-request]').forEach(b=>b.onclick=()=>openRequest(b.dataset.request));}
function homeWorkGroup(key,title,rows) {
  if(!rows.length)return '';
  const card=row=>row.kind==='day'?workDayCard(row.item):workTaskCard(row.item);
  return `<section class="card work-section" data-work-group="${key}"><div class="hc-head"><h2>${title} <small>${rows.length}</small></h2></div>${rows.slice(0,5).map(card).join('')}${rows.length>5?`<details data-work-more="${key}"><summary>展开其余 ${rows.length-5} 项</summary>${rows.slice(5).map(card).join('')}</details>`:''}</section>`;
}
function homeNextStepHTML() {
  const active=(st.plans||[]).some(p=>p.status==='active');
  const related=people.some(p=>['managed','supervisor'].includes(p.relationship));
  let title,view,label;
  if(active){title='暂无待处理事项';view='tasks';label='查看安排';}
  else if(related){title='还没有目标';view='tasks';label=me.role==='supervisor'?'新建目标':'查看目标';}
  else if(me.role==='supervisee'){title='还没有监督伙伴';view='market';label='寻找监督伙伴';}
  else{title='准备开始服务';view='my';label='完善服务资料';}
  return `<section class="card work-section" data-work-empty><h2>${title}</h2><button class="btn" data-home-next="${view}">${label}</button></section>`;
}
async function renderWorkHome(c) {
  const supervisor=me.role==='supervisor',generation=Symbol();c.workGeneration=generation;
  c.innerHTML='<div class="hc-head"><h2>全部待处理</h2><button class="btn sm soft" id="refresh-work">刷新</button></div><div class="empty">正在加载待处理事项…</div>';
  c.querySelector('#refresh-work').onclick=()=>renderWorkHome(c);
  try {
    const [,requests]=await Promise.all([loadSection(),api('GET','/api/requests')]);
    if(st.view!=='dashboard'||!c.isConnected||c.workGeneration!==generation)return;
    const queue=buildHomeWorklist({user:me,days:st.workDays,tasks:st.tasks,plans:st.plans,today:todayStrL()});
    const pendingPlans=st.plans.filter(p=>p.status==='proposed'&&(!p.parentId||!st.plans.some(parent=>parent.id===p.parentId&&parent.status==='proposed')));
    const discussion=requests.list.filter(r=>['discussing','planning'].includes(r.status)||(r.status==='plan_proposed'&&!pendingPlans.some(p=>p.id===r.plan_id)));
    const planningCount=discussion.filter(r=>r.status==='planning').length;
    const hero=document.querySelector('[data-home-work-status]');
    if(hero)hero.innerHTML=supervisor?`有 ${queue.actionable+planningCount} 件待我处理`:planningCount&&!queue.actionable&&!queue.waiting&&!pendingPlans.length?'监督者正在制定计划，准备好后会请你确认':homePendingStatus();
    const section=(key,title,html)=>`<section class="card work-section" data-work-group="${key}"><div class="hc-head"><h2>${title}</h2></div>${html}</section>`;
    const titles=supervisor?{reviews:'待我审核',help:'困难待我回应',overdue:'逾期待跟进',today:'今天需要跟进',undated:'未设截止的事项',waiting:'等待对方'}:{overdue:'待补交与补充',today:'今天要做',undated:'未设截止的事项',waiting:'等待对方'};
    c.innerHTML=`<div class="hc-head"><h2>全部待处理</h2><button class="btn sm soft" id="refresh-work">刷新</button></div>
      <div class="work-summary"><span data-work-count="mine"><b>${queue.actionable+(supervisor?planningCount:pendingPlans.length)}</b> 待我处理</span><span data-work-count="waiting"><b>${queue.waiting+(supervisor?pendingPlans.length:planningCount)}</b> 等待对方</span><span><b>${discussion.length}</b> 目标协商</span></div>
      ${pendingPlans.length?section('agreements',supervisor?'等待对方接受的计划':'请确认新的计划',pendingPlans.map(p=>agreementCard(p)).join('')):''}
      ${Object.entries(titles).map(([key,title])=>homeWorkGroup(key,title,queue.groups[key])).join('')}
      ${!queue.actionable&&!queue.waiting&&!pendingPlans.length&&!discussion.length?homeNextStepHTML():''}
      ${discussion.length?section('requests','目标协商',discussion.map(requestCard).join('')):''}`;
    c.querySelector('#refresh-work').onclick=()=>renderWorkHome(c);
    c.querySelectorAll('[data-home-next]').forEach(b=>b.onclick=()=>goView(b.dataset.homeNext));
    wireWork(c);wireRequests(c);wireAgreements(c);
  }catch(e){if(st.view==='dashboard'&&c.isConnected&&c.workGeneration===generation)c.innerHTML=`<div class="card"><p>${esc(e.message)}</p><button class="btn" onclick="renderView()">重新加载</button></div>`;}
}
function workDayCard(d) {
  const label=({submitted:'已提交 · 待确认',approved:'已确认',rejected:'需要补充',withdrawn:'已撤回'})[d.checkinState] || (d.dayDate<todayStrL()?'待补交':'待提交');
  return `<div class="work-row" data-work-item="day:${esc(d.id)}"><div><span class="eyebrow">${esc(d.planTitle||'每日约定')} · ${esc(d.dayDate)}</span><h3>${esc(d.content)}</h3><p class="muted">${label}${d.checkinReviewNote?' · '+esc(d.checkinReviewNote):''}</p>${d.helpNote?`<p class="help-text">困难：${esc(d.helpNote)}${d.helpReply?'<br>回复：'+esc(d.helpReply):''}</p>`:''}</div><button class="btn sm ${d.checkinState==='submitted'&&d.creatorId===me.id?'':'soft'}" data-day-open="${d.id}">${d.checkinState==='submitted'&&d.creatorId===me.id?'审核':'查看 / 处理'}</button></div>`;
}
function workTaskCard(t){return `<div class="work-row" data-work-item="task:${esc(t.id)}"><div><span class="eyebrow">临时任务 · ${t.dueAt!=null?fmtTime(t.dueAt):'未设截止时间'}</span><h3>${esc(t.title)}</h3><p class="muted">${({submitted:'已提交 · 待确认',pending:'待执行',done:'已完成'})[t.status]}</p></div><button class="btn sm soft" data-task-open="${t.id}">查看 / 处理</button></div>`;}
function wireWork(c){c.querySelectorAll('[data-day-open]').forEach(b=>b.onclick=()=>openDay(b.dataset.dayOpen));c.querySelectorAll('[data-task-open]').forEach(b=>b.onclick=()=>openTask(b.dataset.taskOpen));}
async function openDay(id) {
  const current=modalReadGuard();
  try{
    const r=await api('GET','/api/days/'+encodeURIComponent(id)),d=r.day,p=r.plan;
    if(!current())return;
    st.plans=st.plans.filter(x=>x.id!==p.id).concat({...st.plans.find(x=>x.id===p.id),...p});
    const old=_pd()[p.id]||[];_pd()[p.id]=old.filter(x=>x.id!==d.id).concat(d);
    const mine=me.id===p.assigneeId,owner=me.id===p.creatorId,active=p.status==='active';
    let itemBusy=false;
    const show=()=>{
      const locked=['approved','submitted'].includes(d.checkinState);
      const itemHTML=(d.items||[]).map(item=>`<button type="button" class="day-task ${item.status==='done'?'done':''}" data-detail-item="${esc(item.id)}" role="checkbox" aria-checked="${item.status==='done'}" ${!mine||locked||!active||d.dayDate>todayStrL()||itemBusy?'disabled':''}><i>${item.status==='done'?'✓':'○'}</i><span>${esc(item.title)}</span></button>`).join('');
      openModal(p.title,`<p class="eyebrow">${d.dayDate} · 第${d.seq}天</p><h2>${esc(d.content)}</h2>${itemHTML?`<div class="day-task-list" aria-label="当天任务">${itemHTML}</div>`:''}<p>状态：${({cancelled:'双方确认休息',approved:'已确认',submitted:'等待监督者确认',rejected:'需要补充',unsubmitted:'未提交',withdrawn:'已撤回'})[d.checkinState]}</p><p class="prewrap">${esc(d.note||'暂无打卡备注')}</p>${d.checkinReviewNote?`<p class="help-text">需要补充：${esc(d.checkinReviewNote)}</p>`:''}${d.helpNote?`<p class="help-text">困难：${esc(d.helpNote)}<br>回复：${esc(d.helpReply||'等待回复')}</p>`:''}<div class="row">
        ${active&&mine&&d.dayDate<=todayStrL()&&!['approved','submitted','cancelled'].includes(d.checkinState)?'<button class="btn" id="detail-check">提交打卡</button>':''}
        ${active&&mine&&d.checkinState==='submitted'?'<button class="btn soft" id="detail-withdraw">撤回提交</button>':''}
        ${active&&owner&&d.checkinState==='submitted'?'<button class="btn" id="detail-review">确认 / 要求补充</button>':''}
        ${active&&(mine||d.helpNote)?`<button class="btn soft" id="detail-help">${mine?'说明困难':'回复困难'}</button>`:''}</div>`,()=>closeModal());
      $('#modal-ok').textContent='关闭';
      document.querySelectorAll('[data-detail-item]').forEach(button=>button.onclick=async()=>{
        if(itemBusy||button.disabled)return;
        itemBusy=true;
        const dialog=$modal.querySelector('.dialog');
        const itemButtons=[...document.querySelectorAll('[data-detail-item]')];
        itemButtons.forEach(x=>{x.disabled=true;});
        if($('#detail-check'))$('#detail-check').disabled=true;
        try{
          const item=(d.items||[]).find(x=>x.id===button.dataset.detailItem); if(!item)return;
          const result=await api('POST',`/api/plans/${p.id}/days/${d.id}/items/${item.id}/toggle`,{done:item.status!=='done'});
          item.status=result.item.status;
          const cached=(_pd()[p.id]||[]).find(x=>x.id===d.id); if(cached&&cached.items) { const ci=cached.items.find(x=>x.id===item.id); if(ci)ci.status=item.status; }
          if(!dialog?.isConnected||$modal.querySelector('.dialog')!==dialog)return;
          button.classList.toggle('done',item.status==='done');
          button.setAttribute('aria-checked',item.status==='done'?'true':'false');
          const icon=button.querySelector('i');if(icon)icon.textContent=item.status==='done'?'✓':'○';
        }catch(e){if(dialog?.isConnected&&$modal.querySelector('.dialog')===dialog)toast(e.message);}
        finally{
          itemBusy=false;
          if(dialog?.isConnected&&$modal.querySelector('.dialog')===dialog){
            const locked=['approved','submitted'].includes(d.checkinState);
            itemButtons.forEach(x=>{x.disabled=!mine||locked||!active||d.dayDate>todayStrL();});
            if($('#detail-check'))$('#detail-check').disabled=false;
          }
        }
      });
      if($('#detail-check'))$('#detail-check').onclick=()=>dayCheckModal(p.id,d.id);
      if($('#detail-withdraw'))$('#detail-withdraw').onclick=()=>phaseWithdrawModal(p.id,d.id);
      if($('#detail-review'))$('#detail-review').onclick=()=>phaseDayReviewModal(p.id,d.id);
      if($('#detail-help'))$('#detail-help').onclick=()=>{openModal(mine?'遇到什么困难？':'回应执行人的困难',`<textarea id="help-content" maxlength="500" placeholder="例如：今天临时加班，想申请减少任务量">${esc(mine?d.helpNote:d.helpReply)}</textarea>`,async()=>{await api('POST',`/api/plans/${p.id}/days/${d.id}/help`,{content:$('#help-content').value});closeModal();await phaseRefresh('已发送给对方');});};
    };
    show();
  }catch(e){toast(e.message);}
}
async function openTask(id){
  const current=modalReadGuard();
  try{
  const result=await api('GET','/api/tasks/'+encodeURIComponent(id));
  if(!current())return;
  const t=result.task,writable=result.writable===true;
  const owner=t.creatorId===me.id,mine=t.assigneeId===me.id;
  openModal(t.title,`<p>${t.dueAt?'截止 '+fmtTime(t.dueAt):'未设截止时间'}</p><p class="prewrap">${esc(t.note)}</p><p>状态：${({submitted:'等待确认',done:'已完成',pending:'待执行',cancelled:'已取消，原记录保留'})[t.status]}</p><p>${esc(t.checkinNote)}</p>${!writable?'<p class="muted">历史记录 · 仅查看</p>':''}<div class="row">
    ${writable&&mine&&t.status==='pending'?'<button class="btn" id="task-submit">'+(owner?'完成任务':'提交给监督者确认')+'</button>':''}
    ${writable&&mine&&t.status==='submitted'?'<button class="btn soft" id="task-withdraw">撤回提交</button>':''}
    ${writable&&owner&&!mine&&t.status==='submitted'?'<button class="btn" id="task-approve">确认完成</button><button class="btn soft" id="task-reject">要求补充</button>':''}</div>`,()=>closeModal());
  $('#modal-ok').textContent='关闭';
  const detailDialog=$modal.querySelector('.dialog'),session=token,userId=me.id;
  const ownsDialog=dialog=>session===token&&userId===me?.id&&dialog?.isConnected&&$modal.querySelector('.dialog')===dialog;
  let actionBusy=false;
  const act=async(path,body,dialog)=>{
    if(actionBusy||!ownsDialog(dialog))return;
    const view=st.view,controls=[...dialog.querySelectorAll('button,input,textarea,select')].filter(el=>el.id!=='modal-cancel').map(el=>[el,el.disabled]);
    actionBusy=true;controls.forEach(([el])=>el.disabled=true);dialog.setAttribute('aria-busy','true');
    try{
      await api('POST',`/api/tasks/${id}/${path}`,body||{});
      if(!ownsDialog(dialog))return;
      closeModal();let message=path==='checkin'?(owner?'任务已完成':'已提交，等待监督者确认'):path==='uncheck'?'已撤回提交':body.decision==='approved'?'已确认完成':'已要求补充';
      try{await loadSection();}catch{message+='，列表暂时无法刷新；请稍后重新加载，无需重复提交。';}
      if(session!==token||userId!==me?.id||view!==st.view||$modal.querySelector('.dialog'))return;
      renderView();toast(message);
    }catch(error){if(ownsDialog(dialog))toast(error.message);}
    finally{actionBusy=false;controls.forEach(([el,disabled])=>el.disabled=disabled);dialog.removeAttribute('aria-busy');}
  };
  if($('#task-submit'))$('#task-submit').onclick=()=>{if(actionBusy||!ownsDialog(detailDialog))return;openModal('记录实际完成内容',`<textarea id="task-note" maxlength="1000" placeholder="选填：实际完成了什么"></textarea>`,()=>act('checkin',{note:editor.querySelector('#task-note').value},editor));const editor=$modal.querySelector('.dialog');};
  if($('#task-withdraw'))$('#task-withdraw').onclick=()=>act('uncheck',{},detailDialog);
  if($('#task-approve'))$('#task-approve').onclick=()=>act('review',{decision:'approved'},detailDialog);
  if($('#task-reject'))$('#task-reject').onclick=()=>{if(actionBusy||!ownsDialog(detailDialog))return;openModal('请说明需要补充什么','<textarea id="task-reason" maxlength="500"></textarea>',()=>act('review',{decision:'rejected',note:editor.querySelector('#task-reason').value},editor));const editor=$modal.querySelector('.dialog');};
  }catch(e){if(current())toast(e.message);}
}
function agreementCard(p){return `<div class="work-row"><div><h3>${esc(p.title)}</h3><p>${_d2(p.startAt)} — ${_d2(p.dueAt)} · ${esc(p.description||'查看每日安排后再确认')}</p><span class="pc-chip">${p.status==='proposed'?'待执行人接受':p.status==='declined'?'暂未接受':'进行中'}</span>${p.agreementNote?`<p>${esc(p.agreementNote)}</p>`:''}</div><button class="btn sm soft" data-agreement="${p.id}">查看约定</button></div>`;}
function wireAgreements(c){c.querySelectorAll('[data-agreement]').forEach(b=>b.onclick=()=>agreementModal(b.dataset.agreement));}
async function agreementModal(id){
  const current=modalReadGuard();
  try{
  if(!st.plans.some(p=>p.id===id))await loadSection();
  if(!current())return;
  const p=st.plans.find(p=>p.id===id);
  if(!p||p.status==='archived'){const detail=await api('GET','/api/cooperation-history/plans/'+encodeURIComponent(id));if(current())showHistoryPlan(detail);return;}
  if(p.kind==='cycle'&&p.status==='active')return openDailyPlanner(p.id);
  if(p.planningMode==='rolling')return rollingAgreementModal(p);
  const cycles=p.kind==='cycle'?[p]:st.plans.filter(c=>c.parentId===id);
  const daily=await Promise.all(cycles.map(c=>api('GET',`/api/plans/${c.id}/days`)));
  if(!current())return;
  openModal('计划约定',`<div class="goal-preview"><div class="plan-review-intro"><span class="plan-kicker">${esc(personName(p.creatorId))} 为你制定的服务计划</span><h2>${esc(p.title)}</h2><p>${esc(p.description)}</p><p>${esc(p.calendarStart||fmtDate(p.startAt))} — ${esc(p.calendarEnd||fmtDate(p.dueAt))}<br>日程与提醒时区：${esc(p.calendarTimezone||'服务所在地')}</p></div>${goalDaysPreview(cycles.flatMap((cy,i)=>goalCalendarDays(cy,daily[i].days)).sort((a,b)=>a.date.localeCompare(b.date)))}<p class="muted">可按周查看每日安排。接受后开始提醒。</p>${me.id===p.assigneeId&&p.status==='proposed'?'<button class="btn soft" id="agreement-decline">需要调整，给监督者留言</button>':''}</div>`,async()=>{
    if(me.id===p.assigneeId&&p.status==='proposed'){await api('POST',`/api/plans/${id}/agreement`,{decision:'accept'});await loadSection();}
    closeModal();renderView();
  });
  wireGoalAccordion($modal);
  $modal.querySelector('.dialog').classList.add('goal-dialog');
  $('#modal-ok').textContent=me.id===p.assigneeId&&p.status==='proposed'?'接受并开始':'关闭';
  if($('#agreement-decline'))$('#agreement-decline').onclick=()=>openModal('说明调整建议','<textarea id="agreement-note" maxlength="500"></textarea>',async()=>{await api('POST',`/api/plans/${id}/agreement`,{decision:'decline',note:$('#agreement-note').value});closeModal();await loadSection();renderView();});
  }catch(e){if(current())toast(e.message);}
}

async function renderMarket(c){
  const generation=st.marketGeneration=(st.marketGeneration||0)+1;
  let f=st.marketFilter||{q:'',skill:'',verified:false,available:false,sort:'name'};
  let requestSerial=0;
  c.innerHTML=`<div class="market-hero"><div class="eyebrow">平台监督团队</div><h1>找到适合你的同行者</h1></div>
    <form class="card market-filters" id="market-form">
      <label class="form-field">你的目标或关键词<input id="market-q" value="${esc(f.q)}" maxlength="80" placeholder="例如：英语、考研、时间管理"></label>
      <label class="form-field">擅长领域<select id="market-skill"><option value="">全部技能</option></select></label>
      <label class="form-field">排序<select id="market-sort"><option value="name">默认排序</option><option value="completion">确认完成率</option><option value="rating">服务评分</option></select></label>
      <label class="form-check market-check"><input type="checkbox" id="market-verified" ${f.verified?'checked':''}>有平台审核认证</label>
      <label class="form-check market-check"><input type="checkbox" id="market-available" ${f.available?'checked':''}>有空余名额</label>
      <button class="btn market-submit" type="submit">筛选监督者</button>
    </form>
    <div class="market-results-head"><span id="market-count">正在匹配监督者…</span></div>
    <div id="market-results" class="market-grid"><div class="empty">加载中…</div></div><div id="market-more"></div>`;
  $('#market-sort').value=f.sort;
  $('#market-form').onsubmit=e=>{e.preventDefault();f={q:$('#market-q').value,skill:$('#market-skill').value,sort:$('#market-sort').value,verified:$('#market-verified').checked,available:$('#market-available').checked};st.marketFilter=f;page();};
  async function page(offset=0){
    const currentRequest=++requestSerial,submit=$('#market-form button[type="submit"]');
    if(!offset){submit.disabled=true;submit.textContent='正在筛选…';$('#market-results').innerHTML='<div class="empty market-loading">正在更新匹配结果…</div>';$('#market-more').innerHTML='';}
    try{const query=new URLSearchParams({q:f.q,skill:f.skill,sort:f.sort,verified:f.verified?'1':'0',available:f.available?'1':'0',offset});const r=await api('GET','/api/market?'+query);
      if(st.view!=='market'||!c.isConnected||st.marketGeneration!==generation||currentRequest!==requestSerial)return;
      if(!offset){$('#market-skill').innerHTML='<option value="">全部技能</option>'+r.skills.map(s=>`<option ${s===f.skill?'selected':''}>${esc(s)}</option>`).join('');$('#market-count').textContent=r.list.length?`找到 ${r.list.length} 位可查看的监督者`:'暂无匹配的监督者';$('#market-results').innerHTML='';}
      $('#market-results').insertAdjacentHTML('beforeend',r.list.map(p=>`<article class="card person-card"><div class="person-card-top">${avatarHTML(p)}<span class="pc-chip ${p.accepting&&p.stats.used<p.stats.capacity?'ok':'off'}">${p.accepting&&p.stats.used<p.stats.capacity?'可申请服务':'暂无服务名额'}</span></div><div class="person-card-title"><h2>${esc(p.displayName)}</h2><p>${esc(p.headline||'尚未填写一句话介绍')}</p></div>${profileTags(p)}${metricHTML(p.stats)}<div class="person-card-foot"><span>${esc(p.serviceStyle||'沟通方式可在协商时约定')}</span><button class="btn" data-person="${p.id}">查看主页</button></div></article>`).join('')||(!offset?'<div class="card empty">暂无匹配的监督者，试试调整筛选条件。</div>':''));
      $('#market-more').innerHTML=r.nextOffset!=null?'<button class="btn soft" id="market-load-more">加载更多</button>':'';
      if($('#market-load-more'))$('#market-load-more').onclick=()=>page(r.nextOffset);
      c.querySelectorAll('[data-person]').forEach(b=>b.onclick=()=>publicProfileLink(b.dataset.person));
    }catch(e){if(st.view!=='market'||!c.isConnected||st.marketGeneration!==generation||currentRequest!==requestSerial)return;const box=$('#market-results');if(box)box.innerHTML=`<div class="card empty">${esc(e.message)}</div>`;$('#market-count').textContent='暂时无法更新结果';}
    finally{if(currentRequest===requestSerial&&submit){submit.disabled=false;submit.textContent='筛选监督者';}}
  }
  page();
}
async function renderProfile(c,id=me.id){
  c.innerHTML='<div class="empty">正在加载主页…</div>';
  try{const r=await api('GET','/api/profiles/'+encodeURIComponent(id)),p=r.profile;
    if(st.view!=='profile'||!c.isConnected)return;
    const mine=id===me.id;
    const related=!!r.activeRelation;
    const requestId=r.requestId;
    const canRequest=p.role==='supervisor'&&me.role==='supervisee'&&p.serviceEnabled&&p.published&&p.accepting&&p.stats.used<p.stats.capacity;
    const profileReturns={certifications:'认证审核',users:'用户管理',notes:'通知',my:'我的',market:'平台监督团队',tasks:'计划与任务',requests:'目标协商',supervisees:'我监督的人'};
    const returnTo=profileReturns[st.profileReturn]?st.profileReturn:(mine?'my':'market');
    const returnLabel=profileReturns[returnTo];
    const isSup=p.role==='supervisor', score=p.stats?.rating==null?'暂无':`${p.stats.rating} / 5`, skills=(p.skills||[]).map(s=>`<span class="tag">${esc(s)}</span>`).join('')||'<span class="muted">暂未填写技能</span>', certs=(p.certifications||[]).map(x=>`<div class="profile-list"><b>✓ ${esc(certificationDirection(x))} · ${esc(x.title)}</b><span class="muted">${esc(x.skills||x.issuer)}</span></div>`).join('')||'<p class="muted">暂未获得平台认证</p>', reviews=(p.reviews||[]).map(x=>`<div class="profile-review"><b>${'★'.repeat(x.rating)}${'☆'.repeat(5-x.rating)}</b><p class="prewrap">${esc(x.content)}</p></div>`).join('')||'<p class="muted">暂未留下公开评价</p>';
    c.innerHTML=`<button class="page-back" id="profile-back">← 返回${returnLabel}</button><section class="card profile-hero">${avatarHTML(p)}<div class="eyebrow">${isSup?'监督服务主页':'个人主页'}${mine&&!p.publicVisible?' · 未向所有登录用户公开':''}</div><h1>${esc(p.displayName)}</h1><p class="profile-headline">${esc(p.headline||'还没有填写介绍')}</p>${isSup?`<div class="service-score"><span>${p.certifications?.length?'✓ 已认证':'○ 暂无认证'}</span><b>${score}</b><small>服务评分</small></div>`:''}</section><section class="card work-section"><h2>关于我</h2><p class="prewrap">${esc(p.bio||'暂无介绍')}</p><h2>${isSup?'技能与擅长领域':'我的技能与兴趣'}</h2><div class="profile-tags">${skills}</div></section>${isSup?`<section class="card work-section"><h2>服务方式与经历</h2><p class="prewrap">${esc(p.serviceStyle||'暂未填写')}</p></section><section class="card work-section"><h2>平台认证</h2>${certs}</section><section class="card work-section"><h2>用户评价</h2>${reviews}</section>`:`<section class="card work-section"><h2>我的节奏</h2><p class="prewrap">${esc(p.serviceStyle||'还没有填写')}</p></section>`}<div class="profile-actions"><button class="btn" id="profile-primary">${mine?'编辑我的主页':related?'查看当前目标':requestId?'继续目标协商':isSup&&me.role==='supervisee'?(canRequest?'发起目标协商':'暂不接收新服务'):'返回'+returnLabel}</button>${p.publicVisible?'<button class="btn soft" id="profile-share">复制主页链接</button>':''}</div>`;
    $('#profile-back').onclick=()=>{st.profileReturn=null;goView(returnTo);};
    $('#profile-primary').disabled=!mine&&!related&&!requestId&&p.role==='supervisor'&&me.role==='supervisee'&&!canRequest;
    $('#profile-primary').onclick=()=>mine?editProfile():related?goView('tasks'):requestId?openRequest(requestId):canRequest?startRequest(id):goView(returnTo);
    if($('#profile-share'))$('#profile-share').onclick=async()=>{try{await navigator.clipboard.writeText(location.origin+'/#profile/'+encodeURIComponent(id));toast('主页链接已复制（需登录查看）');}catch{toast('可复制浏览器地址分享');}};
  }catch(e){c.innerHTML=`<div class="card empty">${esc(e.message)}</div>`;}
}
async function endCooperationModal(personId) {
  try {
    const summary=await api('GET','/api/relations/'+encodeURIComponent(personId)+'/closing-summary');
    const pending=summary.pendingDays+summary.pendingTasks+summary.pendingReviews;
    openModal('结束这段监督关系？',`<p>合作结束后，计划与执行记录保留在“我的 → 历史”。</p>${pending?`<p>还有 ${summary.pendingDays} 天打卡、${summary.pendingTasks} 项任务待审核，${summary.pendingReviews} 个阶段尚未完成复盘确认。</p><p>结束后待审核任务会取消，尚未提交的阶段复盘不能再补交。建议先完成收尾。</p><button class="btn soft" id="relation-wrap-up" type="button">先去处理待办</button>`:'<p>当前没有待审核提交或已结束阶段的待确认复盘。</p>'}`,async()=>{
      await api('DELETE','/api/relations/'+encodeURIComponent(personId));closeModal();const view=st.view;await loadAll();st.view=view;renderApp();
    });
    $('#modal-ok').textContent='结束合作';$('#modal-cancel').textContent='继续合作';
    if($('#relation-wrap-up'))$('#relation-wrap-up').onclick=()=>{closeModal();goView('tasks');};
  }catch(e){toast(e.message);}
}
async function editProfile(){
  const current=modalReadGuard();
  try{
  const {profile:p}=await api('GET','/api/profile/me');
  if(!current())return;
  openModal('编辑个人主页',`<label>昵称<input id="profile-name" maxlength="7" value="${esc(p.displayName)}" placeholder="1—7 个汉字" inputmode="text"></label><label>性别<select id="profile-gender"><option value="unspecified" ${p.gender==='unspecified'?'selected':''}>暂不填写</option><option value="male" ${p.gender==='male'?'selected':''}>男</option><option value="female" ${p.gender==='female'?'selected':''}>女</option></select></label><label>一句话介绍<input id="profile-headline" maxlength="80" value="${esc(p.headline)}" placeholder="例如：陪你建立稳定的学习习惯"></label><label>技能 / 擅长领域（逗号分隔，最多12项）<input id="profile-skills" value="${esc(p.skills.join('，'))}" placeholder="英语，考研，时间管理"></label><label>个人介绍<textarea id="profile-bio" maxlength="1000">${esc(p.bio)}</textarea></label><label>${me.role==='supervisor'?'协作方式':'我的节奏'}<textarea id="profile-style" maxlength="300" placeholder="服务时间、反馈频率、适合的目标">${esc(p.serviceStyle)}</textarea></label><label class="form-check"><input type="checkbox" id="profile-public-visible" ${p.publicVisible?'checked':''}>公开主页给已登录用户</label>`,async()=>{
    const result=await api('PUT','/api/profile/me',{displayName:$('#profile-name').value,gender:$('#profile-gender').value,headline:$('#profile-headline').value,bio:$('#profile-bio').value,skills:$('#profile-skills').value.split(/[,，、]/).map(s=>s.trim()).filter(Boolean),serviceStyle:$('#profile-style').value,publicVisible:$('#profile-public-visible').checked});me.displayName=result.displayName;me.gender=result.gender;closeModal();renderView();toast('主页已更新');
  });
  }catch(error){if(current())toast(error.message);}
}
async function renderMy(c){
  if(me.role==='admin'){c.innerHTML=`<h1>管理员账户</h1><section class="card"><h2>${esc(me.displayName)}</h2><button class="btn" id="admin-my-home">平台总览</button><button class="btn soft" id="admin-my-logout">退出登录</button></section>`;$('#admin-my-home').onclick=()=>goView('overview');$('#admin-my-logout').onclick=doLogout;return;}

  const roleSection=me.role==='supervisor'
    ? `<section class="card work-section my-service-card"><div class="row spread"><h2>身份与能力认证</h2><button class="btn sm" id="my-cert">申请认证</button></div><div id="my-authorization"></div><div id="my-certs">加载中…</div></section>`
    : me.role==='supervisee' ? `<section class="card work-section my-service-card"><div class="row spread"><h2>服务小档案</h2><button class="btn sm" id="my-assessment">填写 / 更新</button></div><div id="my-assessment-summary">加载中…</div></section>` : '';
  const featured=me.role==='supervisee'
    ? `<button class="my-feature-card" id="my-life"><span class="my-card-icon">☀</span><span class="my-card-copy"><b>私人生活记录</b></span><span class="my-card-arrow">›</span></button>`
    : `<button class="my-feature-card" id="my-people"><span class="my-card-icon">◌</span><span class="my-card-copy"><b>我监督的人</b></span><span class="my-card-arrow">›</span></button>`;
  c.innerHTML=`<div class="my-page"><h1>我的</h1><section class="card my-identity"><div class="my-identity-main"><button class="avatar-edit-button" id="my-avatar" aria-label="更换头像">${avatarHTML(me,'my-avatar')}<span class="avatar-edit-hint">更换</span></button><div><div class="eyebrow">个人空间 · ${esc(roleLabel(me.role,me.identity))}</div><h2>${esc(me.displayName)}</h2></div></div><div class="my-identity-actions"><button class="btn" id="my-profile">查看个人主页</button><button class="btn soft" id="my-edit">编辑资料</button></div></section><section class="my-section"><div class="my-section-head"><span>日常与协作</span></div>${featured}<div class="my-route-grid"><button class="my-route-card" id="my-market"><span class="my-route-icon">◎</span><span><b>${me.role === 'supervisee' ? '寻找 Supervisor' : 'Supervisor 团队'}</b></span><i>›</i></button><button class="my-route-card" id="my-history"><span class="my-route-icon">◷</span><span><b>历史</b></span><i>›</i></button><button class="my-route-card" id="my-requests"><span class="my-route-icon">◎</span><span><b>目标协商</b></span><i>›</i></button><button class="my-route-card" id="my-settings"><span class="my-route-icon">✦</span><span><b>提醒设置</b></span><i>›</i></button></div></section>${roleSection}<button class="logout-button" id="my-logout">退出登录 <span>↗</span></button><p class="my-signature">Markly · 每一步，都有迹可循</p></div>`;
  $('#my-market').onclick=()=>goView('market');
  $('#my-avatar').onclick=editAvatar; $('#my-logout').onclick=doLogout;
  if(me.role==='supervisor')api('GET','/api/plan-access').then(r=>{if(c.isConnected&&st.view==='my'&&r.access.eligible&&!$('#my-plan-access')){c.querySelector('.my-route-grid').insertAdjacentHTML('beforeend','<button class="my-route-card" id="my-plan-access"><span class="my-route-icon">↗</span><span><b>计划接口调用</b></span><i>›</i></button>');$('#my-plan-access').onclick=()=>planAccessModal(me.id);}}).catch(()=>{});
  $('#my-profile').onclick=()=>publicProfileLink(me.id,'my');$('#my-edit').onclick=()=>editProfile();$('#my-requests').onclick=()=>goView('requests');$('#my-history').onclick=()=>goView('history');$('#my-settings').onclick=()=>goView('settings');
  if($('#my-life'))$('#my-life').onclick=()=>goView('life');if($('#my-people'))$('#my-people').onclick=()=>goView('supervisees');
  if($('#my-cert'))$('#my-cert').onclick=()=>goView('intake');
  if($('#my-assessment'))$('#my-assessment').onclick=()=>goView('intake');
  try{const [r,pp,assessmentResult]=await Promise.all([api('GET','/api/profile/me'),api('GET','/api/people'),me.role==='supervisee'?api('GET','/api/assessment/me'):Promise.resolve(null)]);if(st.view!=='my'||!c.isConnected)return;if($('#my-authorization'))$('#my-authorization').textContent=cooperationLabel(r.profile.cooperationState)+' · 当前可服务人数：'+(r.profile.stats?.capacity||0)+' · '+(r.profile.published?'已展示在团队':'未展示在团队');
    if($('#my-certs'))$('#my-certs').innerHTML=r.certifications.map(x=>`<div class="work-row"><div><b>${esc(x.title)}</b>${certificationApplication(x)}<p>${esc(x.issuer)}</p><p class="muted">${({pending:'审核中',verified:'认证已通过',rejected:'未通过 / 已撤销'})[x.status]}${x.review_note?' · '+esc(x.review_note):''}</p></div></div>`).join('')||'<p class="muted">还没有提交认证</p>';
    if($('#my-assessment-summary')){const a=assessmentResult.assessment;$('#my-assessment-summary').innerHTML=a?`<div class="work-row"><div><b>${esc(a.selfPosition||'等待补充自我定位')}</b><p>${esc(a.primaryGoal||'正在梳理想改变的方向')}</p><p>${esc(a.currentSituation)}</p><p class="muted">希望 ${fmtDate(a.desiredStartAt)} 开始 · 每周 ${a.availableMinutes} 分钟 · ${esc(a.preferredRhythm)}</p></div></div>`:'<p class="muted">尚未填写</p>';}
    const related=pp.people.filter(p=>['managed','supervisor'].includes(p.relationship));
    if(related.length){c.querySelector('.my-page').insertAdjacentHTML('beforeend',`<section class="card work-section"><h2>当前监督关系</h2>${related.map(p=>`<div class="work-row"><button class="linkbtn" data-profile-link="${p.id}" data-profile-return="my">${esc(p.displayName)}</button><span><button class="btn sm soft" data-profile-link="${p.id}" data-profile-return="my">查看主页</button><button class="btn sm soft" data-end-relation="${p.id}">结束合作</button></span></div>`).join('')}</section>`);c.querySelectorAll('[data-end-relation]').forEach(b=>b.onclick=()=>endCooperationModal(b.dataset.endRelation));}
  }catch(e){if($('#my-certs'))$('#my-certs').textContent=e.message;}
}
async function renderCertificationAdmin(c,offset=0){
  const status=st.certStatus??'pending',userId=st.certUserId||'';
  const generation=Symbol();c.certLoad=generation;c.innerHTML='<h1>身份与能力认证审核</h1><p>正在读取认证材料…</p>';
  try{
    const r=await api('GET','/api/admin/certifications?'+new URLSearchParams({status,userId,offset}));
    if(st.view!=='certifications'||!c.isConnected||c.certLoad!==generation)return;
    const labels={pending:'待审核',verified:'已认证',rejected:'未通过 / 已撤销'};
    c.innerHTML=`<h1>身份与能力认证审核</h1><div class="row">${['pending','verified','rejected',''].map(k=>`<button class="btn ${status===k?'':'soft'}" data-cert-filter="${k}">${labels[k]||'全部'}</button>`).join('')}<button class="btn soft" id="cert-refresh">刷新</button>${userId?'<button class="btn soft" id="cert-all-users">查看所有监督者</button>':''}</div>${r.list.map(x=>`<section class="card work-section"><h2>${esc(x.title)} · ${esc(x.display_name)}</h2>${certificationApplication(x)}<p>${esc(x.issuer)} · ${labels[x.status]}${x.user_status!==1?' · 账号已停用':''}</p><p class="muted">提交时间：${fmtTime(x.created_at)} · 最近审核：${fmtTime(x.reviewed_at)}</p><details><summary>查看私密核验材料</summary><p class="prewrap">${esc(x.evidence)}</p></details><p class="prewrap">${esc(x.review_note)}</p><div class="row"><button class="btn" data-cert-review="${x.id}">${x.status==='pending'?'核验材料':'复核 / 撤销'}</button><button class="btn soft" data-cert-history="${x.id}">审核历史</button><button class="btn soft" data-cert-user="${x.user_id}">查看主页</button><button class="btn soft" data-cert-cooperation="${x.user_id}">合作授权</button></div></section>`).join('')||'<div class="card empty">暂无该状态的认证材料</div>'}<div class="row"><button class="btn soft" id="cert-prev" ${offset?'':'disabled'}>上一页</button><button class="btn soft" id="cert-next" ${r.nextOffset===null?'disabled':''}>下一页</button></div>`;
    c.querySelectorAll('[data-cert-filter]').forEach(b=>b.onclick=()=>{st.certStatus=b.dataset.certFilter;renderCertificationAdmin(c);});
    $('#cert-refresh').onclick=()=>renderCertificationAdmin(c,offset);if($('#cert-all-users'))$('#cert-all-users').onclick=()=>{st.certUserId='';renderCertificationAdmin(c);};
    $('#cert-prev').onclick=()=>renderCertificationAdmin(c,Math.max(0,offset-50));$('#cert-next').onclick=()=>renderCertificationAdmin(c,r.nextOffset);
    c.querySelectorAll('[data-cert-user]').forEach(b=>b.onclick=()=>publicProfileLink(b.dataset.certUser,'certifications'));
    c.querySelectorAll('[data-cert-cooperation]').forEach(b=>b.onclick=async()=>{try{await loadAdmin();if(c.isConnected)adminCooperationModal(st.admin.users.find(u=>u.id===b.dataset.certCooperation));}catch(error){toast(error.message);}});
    c.querySelectorAll('[data-cert-history]').forEach(b=>b.onclick=async()=>{try{const {events}=await api('GET','/api/admin/certifications/'+b.dataset.certHistory+'/history');if(!c.isConnected)return;openModal('认证审核历史',events.map(e=>`<p><b>${esc(e.reviewerName||'管理员')} · ${labels[e.status]}</b> · ${fmtTime(e.created_at)}</p><p class="prewrap">${esc(e.note)}</p>`).join('')||'<p>暂无审核历史</p>',closeModal);}catch(error){toast(error.message);}});
    c.querySelectorAll('[data-cert-review]').forEach(b=>b.onclick=()=>{const item=r.list.find(x=>x.id===b.dataset.certReview);openModal('核验身份与能力',`<h4>${esc(item.title)} · ${esc(item.issuer)}</h4>${certificationApplication(item)}<p class="prewrap">${esc(item.evidence)}</p><label>审核结果<select id="cert-status"><option value="verified">材料核验通过</option><option value="rejected">未通过 / 撤销认证</option></select></label><label>核验依据或原因（本人可见）<textarea id="cert-review-note" maxlength="300"></textarea></label>`,async()=>{await api('PUT','/api/admin/certifications/'+item.id,{status:$('#cert-status').value,reviewNote:$('#cert-review-note').value,expectedStatus:item.status,expectedReviewedAt:item.reviewed_at});closeModal();renderCertificationAdmin(c,offset);toast('认证审核已保存');});});
  }catch(error){if(c.isConnected&&c.certLoad===generation)c.innerHTML=`<p>${esc(error.message)}</p><button class="btn" onclick="renderCertificationAdmin(document.getElementById('content'))">重新加载</button>`;}
}
async function startRequest(id){
  openModal('如何开始平台监督服务？','<button class="btn soft block" id="start-quick">快速开始</button>',async()=>{closeModal();goView('my');});
  $('#modal-ok').textContent='写下开始前记录';
  $('#start-quick').onclick=()=>quickStartRequest(id);
}
function quickStartRequest(id){
  const today=todayStrL();
  openModal('快速开始',`<label>这次想推进什么<textarea id="quick-goal" maxlength="500" placeholder="例如：用四周建立每天英语学习的节奏"></textarea></label><label>希望什么时候开始<input id="quick-start" type="date" value="${today}"></label>`,async()=>{const desiredStartAt=fromLocalInput($('#quick-start').value+'T00:00');const r=await api('POST','/api/requests',{personId:id,goal:$('#quick-goal').value,mode:'quick',desiredStartAt});closeModal();await openRequest(r.id);});
}
async function renderRequests(c){c.innerHTML='<h1>服务推进</h1><div class="empty">加载中…</div>';try{const r=await api('GET','/api/requests');if(st.view!=='requests'||!c.isConnected)return;c.innerHTML=`<div class="row spread"><div><button class="page-back" id="requests-back">← 返回我的</button><h1>目标协商</h1></div><button class="btn soft" id="requests-refresh">刷新</button></div><div class="card">${r.list.map(requestCard).join('')||'<div class="empty">暂无协商，可以从平台监督团队开始。</div>'}</div>`;$('#requests-back').onclick=()=>goView('my');$('#requests-refresh').onclick=()=>renderRequests(c);wireRequests(c);}catch(e){c.textContent=e.message;}}
async function openRequest(id){
  st.requestId=id;goView('request');
}
async function renderRequest(c,id){
  c.innerHTML='<div class="empty">加载协商…</div>';
  try{const {request:r,assessment,messages}=await api('GET','/api/requests/'+id);if(st.view!=='request'||st.requestId!==id||!c.isConnected)return;
    const discussing=r.status==='discussing',supervisor=me.id===r.supervisor_id;
    const assessmentSummary=assessment?`<section class="card work-section"><h2>开始前记录</h2><p><b>自我定位：</b>${esc(assessment.selfPosition)}</p>${assessment.primaryGoal?`<p><b>想改善的方向：</b>${esc(assessment.primaryGoal)}</p>`:''}<p class="prewrap"><b>现在的状态：</b>${esc(assessment.currentSituation)}</p><p><b>希望开始：</b>${fmtDate(assessment.desiredStartAt)} · 每周 ${assessment.availableMinutes} 分钟</p><p><b>希望的节奏：</b>${esc(assessment.preferredRhythm)}</p>${assessment.obstacles?`<p class="prewrap"><b>可能的阻碍：</b>${esc(assessment.obstacles)}</p>`:''}${assessment.supportPreferences?`<p class="prewrap"><b>希望获得的支持：</b>${esc(assessment.supportPreferences)}</p>`:''}</section>`:`<section class="card work-section"><h2>快速开始记录</h2><p><b>希望开始：</b>${fmtDate(r.desired_start_at)}</p></section>`;
    let stageAction=discussing?`<div class="row"><button class="btn soft" id="request-terms">记录协商要点</button>${supervisor?'<button class="btn" id="request-confirm">确认接手，制定计划</button>':''}<button class="linkbtn" id="request-close">关闭协商</button></div>`:r.status==='planning'?(supervisor?'<button class="btn" id="request-plan">制定目标与首阶段</button>':''):r.status==='plan_proposed'?`<button class="btn" id="request-open-plan">查看并${supervisor?'等待对方接受':'接受监督计划'}</button>`:'';
    if(['planning','plan_proposed'].includes(r.status))stageAction+='<button class="btn soft" id="request-close">取消本次协商</button>';
    const otherId=me.id===r.supervisor_id?r.supervisee_id:r.supervisor_id,otherName=me.id===r.supervisor_id?r.supervisee_name:r.supervisor_name;
    c.innerHTML=`<button class="linkbtn" id="request-back">← 全部合作</button><div class="row spread"><h1>一起推进下一步</h1><button class="btn sm soft" id="request-refresh">刷新</button></div><section class="card"><span class="pc-chip">${requestStatus(r)}</span><div class="row spread"><h2>${esc(r.goal)}</h2><button class="btn sm soft" data-profile-link="${otherId}" data-profile-return="requests">查看 ${esc(otherName)} 的主页</button></div><h3>协商记录</h3><p class="prewrap">${esc(r.terms||'')}</p>${stageAction}</section>${assessmentSummary}<section class="card work-section"><h2>沟通记录</h2><div class="message-list">${messages.map(m=>`<div class="message ${m.author_id===me.id?'mine':''}"><b>${m.author_id===me.id?'我':'对方'}</b><p class="prewrap">${esc(m.content)}</p><small>${fmtTime(m.created_at)}</small></div>`).join('')||'<p class="muted">还没有留言。</p>'}</div>${discussing?'<label>回复<textarea id="request-message" maxlength="1000" placeholder="告诉对方你的想法"></textarea></label><button class="btn" id="request-send">发送回复</button>':''}</section>`;
    $('#request-back').onclick=()=>goView('requests');$('#request-refresh').onclick=()=>renderRequest(c,id);
    const action=async(path,body)=>{await api('POST',`/api/requests/${id}/${path}`,body||{});await renderRequest(c,id);};
    if(discussing){$('#request-send').onclick=()=>action('messages',{content:$('#request-message').value}).catch(e=>toast(e.message));if($('#request-confirm'))$('#request-confirm').onclick=async()=>{try{await action('confirm');const view=st.view;await loadAll();st.view=view;renderApp();}catch(e){toast(e.message);}};
      $('#request-terms').onclick=()=>openModal('记录协商要点',`<textarea id="request-terms-input" maxlength="2000">${esc(r.terms)}</textarea>`,async()=>{await api('PUT',`/api/requests/${id}/terms`,{terms:$('#request-terms-input').value});closeModal();renderRequest(c,id);});
    }
    if($('#request-close'))$('#request-close').onclick=()=>openModal('关闭本次协商？','<p>尚未接受的计划将归档，协商记录保留；如需重新合作，可以再次发起。</p>',async()=>{await action('close');closeModal();await loadSection();});
    if($('#request-plan'))$('#request-plan').onclick=async()=>{const view=st.view;await loadAll();st.view=view;newGoalModal(r.supervisee_id,r.id,r.desired_start_at);};
    if($('#request-open-plan'))$('#request-open-plan').onclick=async()=>{await loadSection();await agreementModal(r.plan_id);};
  }catch(e){c.innerHTML=`<div class="card empty">${esc(e.message)}</div>`;}
}

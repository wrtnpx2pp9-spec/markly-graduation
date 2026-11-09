/* One workspace: route planning and a focused calendar week. */
'use strict';
let goalWorkspaceSession=0;
function openGoalWorkspace(assigneeId,requestId,desiredStartAt,imported){
  const originView=st.view,originScroll=window.scrollY;
  const editorSession=++goalWorkspaceSession,ownerSession=token;
  let ownedDialog=null;
  const current=()=>ownerSession===token&&editorSession===goalWorkspaceSession&&ownedDialog?.isConnected&&$modal.querySelector('.dialog')===ownedDialog;
  const saveState=text=>{if(current()){const node=ownedDialog.querySelector('#goal-save-state');if(node)node.textContent=text;}};
  const choices=requestId?[{id:assigneeId,displayName:personName(assigneeId)}]:people.filter(p=>p.relationship==='managed');
  if(!choices.length){toast('请先确认接手协商，再制定计划');return;}
  const clone=v=>JSON.parse(JSON.stringify(v));
  const slot=title=>({title:title||'',timeLabel:'',startTime:'',endTime:'',minutes:0});
  const makeStage=(start,n)=>({id:Math.random().toString(36).slice(2),title:'',start,end:goalShift(start,n-1),content:'',hour:20,weeks:{},days:{}});
  const key=`markly-goal-v2:${me.id}:${requestId||assigneeId||'managed'}`;
  let draft={personId:assigneeId||choices[0].id,title:'',description:'',stages:[makeStage(desiredStartAt?toLocalInput(desiredStartAt).slice(0,10):todayStrL(),7)]};
  try{const saved=JSON.parse(localStorage.getItem(key));if(saved?.stages?.length&&choices.some(p=>p.id===saved.personId))draft=saved;}catch{}
  if(imported){
    draft=imported.workspace;
    if(imported.kind==='manual')draft.draftMeta={id:imported.id,version:imported.version,reviewed:true};
    else draft.importMeta={id:imported.id,version:imported.version,source:imported.source,constraints:imported.constraints,reviewed:imported.reviewed,resolutions:draft.importResolutions||{}};
  }
  draft.weekPlans ||= {};
  const ui=draft.workspace||{mode:'route',weekKey:draft.tree?.week||'',stage:draft.tree?.stage||draft.stages[0].id,days:{},slots:{},scrolls:{}};
  const stageBy=id=>draft.stages.find(s=>s.id===id);
  const stageName=s=>s.title||`第 ${draft.stages.indexOf(s)+1} 阶段`;
  const day=(s,date)=>s.days[date]||{goal:s.content,rest:false,slots:[slot(s.content)]};
  function weekMeta(date){
    if(draft.weekPlans[date])return draft.weekPlans[date];
    const relevant=draft.stages.filter(s=>goalDates(s.start,s.end).some(d=>goalWeek(d)===date));
    const legacy=relevant.map(s=>s.weeks?.[date]).filter(Boolean);
    const result={goal:[...new Set(legacy.map(w=>w.goal).filter(Boolean))].join('；')||[...new Set(relevant.map(s=>s.content).filter(Boolean))].join('；'),minutes:Math.max(0,...legacy.map(w=>Number(w.minutes)||0))};
    return result;
  }
  function allDays(){const metas=new Map();return draft.stages.flatMap(s=>goalDates(s.start,s.end).map(date=>{
    const weekKey=goalWeek(date);if(!metas.has(weekKey))metas.set(weekKey,weekMeta(weekKey));
    const d=day(s,date),w=metas.get(weekKey);
    return {date,owner:s.id,stageTitle:stageName(s),rest:d.rest,content:d.goal||s.content,schedule:{weekGoal:w.goal,weekMinutes:w.minutes,dayGoal:d.goal,slots:d.slots},tasks:d.slots.map(goalSlotTitle)};
  })).sort((a,b)=>a.date.localeCompare(b.date));}
  const weeks=()=>goalWeeks(allDays());
  const ready=d=>d.rest||d.schedule.slots.length>0&&d.schedule.slots.every(t=>t.title.trim());
  const btn=(label,action,attrs='')=>`<button type="button" class="btn sm soft" data-plan-action="${action}" ${attrs}>${label}</button>`;
  function journey(){const days=allDays(),planned=days.filter(ready).length;return {hasGoal:!!draft.title.trim(),planned,total:days.length};}
  function journeyHTML(){return `<nav class="goal-mobile-journey" aria-label="手机计划编排步骤"><div><button type="button" data-plan-jump="basics">1 目标</button><button type="button" data-plan-jump="route">2 阶段</button><button type="button" data-plan-jump="week">3 每周</button></div><small id="goal-journey-state" role="status"></small></nav>`;}
  function updateJourney(){const info=journey(),state=$('#goal-journey-state');if(state)state.textContent=`${info.hasGoal?'目标已填写':'先填写目标'} · 已安排 ${info.planned}/${info.total} 天`; const active=ui.mode==='week'?'week':ui.mode==='route'?'route':'';$modal.querySelectorAll('[data-plan-jump]').forEach(b=>b.setAttribute('aria-current',String(b.dataset.planJump===active)));}
  function jumpTo(part){
    if(part==='week'){switchMode('week',ui.weekKey);return;}
    const target=part==='basics'?'goal-basics':'goal-stages';
    if(ui.mode!=='route'){switchMode('route');requestAnimationFrame(()=>document.getElementById(target)?.scrollIntoView({block:'start',behavior:'smooth'}));}
    else document.getElementById(target)?.scrollIntoView({block:'start',behavior:'smooth'});
  }
  let saveTimer,saving=Promise.resolve(),cloudError='',lastCloud='',closed=false,creatingCloudDraft=false;
  const cloudMeta=()=>draft.importMeta||draft.draftMeta||null;
  function localSave(){if(editorSession!==goalWorkspaceSession||ownerSession!==token)return;draft.workspace=ui;if(draft.importMeta)draft.importResolutions=draft.importMeta.resolutions;try{localStorage.setItem(key,JSON.stringify(draft));}catch{toast('本机备份失败，请确认服务器保存成功再关闭');}}
  function cloudBody(){const workspace=clone(draft);delete workspace.importMeta;delete workspace.draftMeta;return {workspace,bundle:payload(),reviewed:!!cloudMeta()?.reviewed};}
  function save(){localSave();const meta=cloudMeta();saveState(meta?(cloudError||'本机已备份 · 正在保存'):(creatingCloudDraft?'正在创建服务器草稿…':'本机已备份 · 正在创建服务器草稿'));if(meta&&!closed){clearTimeout(saveTimer);saveTimer=setTimeout(()=>flush().catch(()=>{}),650);}}
  async function flush(){clearTimeout(saveTimer);const meta=cloudMeta();if(!meta)return;
    saving=saving.catch(()=>{}).then(async()=>{if(ownerSession!==token)return;const data=cloudBody(),signature=JSON.stringify(data);if(signature===lastCloud){saveState('已保存到服务器 · 本机已备份');return;}try{const result=await api('PUT','/api/plan-drafts/'+meta.id,{...data,version:meta.version});meta.version=result.draft.version;meta.issues=result.draft.issues;lastCloud=signature;cloudError='';localSave();saveState('已保存到服务器 · 本机已备份');}catch(e){cloudError=e.message;localSave();saveState('服务器未保存 · '+e.message);throw e;}});return saving;}
  async function ensureCloudDraft(){
    if(cloudMeta()||creatingCloudDraft||closed)return;
    creatingCloudDraft=true;save();
    try{
      const result=await api('POST','/api/plan-drafts',{assigneeId:draft.personId,requestId:requestId||undefined,...cloudBody()});
      if(cloudMeta())return;
      draft.draftMeta={id:result.draft.id,version:result.draft.version,reviewed:true};
      localSave();save();await flush();
    }catch(e){cloudError='服务器草稿未创建 · '+e.message;localSave();saveState(cloudError);}
    finally{creatingCloudDraft=false;}
  }
  function switchMode(mode,weekKey){ui.mode=mode;if(weekKey)ui.weekKey=weekKey;save();render();}
  function slotSummary(t,i){return `<b>${esc(t.title||`时间段 ${i+1} · 待填写`)}</b><small>${esc(t.startTime?`${t.startTime}—${t.endTime}`:t.timeLabel||'时间自定')} · ${goalMinutes([t])} 分钟</small>`;}
  function daySummary(s,date){const d=day(s,date),missing=!d.rest&&(!d.slots.length||d.slots.some(t=>!t.title.trim()));return `<b>${date.slice(5)} · 周${'日一二三四五六'[new Date(date+'T00:00:00').getDay()]}</b><small>${esc(stageName(s))} · ${d.rest?'休息日':missing?'尚未安排':`${d.slots.length} 项安排 · ${goalMinutes(d.slots)} 分钟`}</small>`;}
  function dayEditor(s,date){const d=day(s,date);return `<div class="goal-tree-day-fields"><label>当天大致目标<input data-day-field="goal" maxlength="300" value="${esc(d.goal)}" placeholder="例如：复习词汇，练习听力"></label><label class="goal-rest-toggle"><input type="checkbox" data-day-field="rest" ${d.rest?'checked':''}>当天休息（保留安排）</label><div class="goal-template-tools">${btn('复用前一天','template','data-template="previous"')}${btn('轻量学习模板','template','data-template="light"')}</div><div data-template-confirm hidden></div>${d.rest?'<p>这一天无需打卡，不发送催办。</p>':`<div class="goal-time-list">${d.slots.map((t,i)=>`<details class="goal-tree-slot" data-slot="${i}" name="slots-${s.id}-${date}" ${ui.slots[date]===i?'open':''}><summary>${slotSummary(t,i)}</summary><div class="goal-tree-fields"><label>做什么<input data-slot-field="title" maxlength="150" value="${esc(t.title)}" placeholder="先写大概即可"></label><label>大概什么时候<input data-slot-field="timeLabel" maxlength="30" value="${esc(t.timeLabel)}" placeholder="例如：晚饭后；留空表示时间自定"></label><div class="form-grid"><label>开始时间（可选）<input type="time" data-slot-field="startTime" value="${esc(t.startTime)}"></label><label>结束时间（可选）<input type="time" data-slot-field="endTime" value="${esc(t.endTime)}"></label></div><label>预计分钟数（可选）<input type="number" min="0" max="1440" data-slot-field="minutes" value="${t.minutes||''}"></label>${btn('移除事项','delete-slot',d.slots.length===1?'disabled':'')}</div></details>`).join('')}</div>${btn('＋ 添加安排','add-slot')}`}<small data-day-total>当天已估 ${d.rest?0:goalMinutes(d.slots)} 分钟</small></div>`;}
  function stageHTML(s,i){return `<details class="goal-tree-stage" data-goal-stage="${s.id}" name="goal-stages" ${ui.stage===s.id?'open':''}><summary><span class="goal-stage-index">${i+1}</span><span><b>${esc(stageName(s))}</b><small>${s.start} — ${s.end} · ${goalDates(s.start,s.end).length} 天</small></span></summary><div class="goal-tree-fields"><label>阶段／周期名称<input data-field="title" maxlength="120" value="${esc(s.title)}"></label><div class="form-grid"><label>开始日期<input type="date" data-field="start" value="${s.start}"></label><label>结束日期<input type="date" data-field="end" value="${s.end}"></label></div><label>阶段大致安排<input data-field="content" maxlength="150" value="${esc(s.content)}" placeholder="填写后作为每日安排初稿，也可以暂时留空"></label><label>每日提醒时间（点）<input type="number" data-field="hour" min="0" max="23" value="${s.hour}"></label>${draft.stages.length>1?btn('删除阶段','remove-stage'):''}<div data-remove-confirm hidden></div></div></details>`;}
  function weekStats(w){const total=w.days.reduce((n,d)=>n+(d.rest?0:goalMinutes(d.schedule.slots)),0),meta=weekMeta(w.key);return `已安排 ${total} 分钟${meta.minutes?` / 预计 ${meta.minutes} 分钟`:''} · ${w.days.filter(ready).length}/${w.days.length} 天已有安排`;}
  function overviewHTML(){return `<details id="goal-basics" class="goal-basics" ${!draft.title?'open':''}><summary>目标与服务约定<small>${esc(draft.title||'先确定服务对象和目标')}</small></summary><div class="goal-tree-fields"><label>为谁制定<select id="goal-person">${choices.map(p=>`<option value="${p.id}" ${p.id===draft.personId?'selected':''}>${esc(p.displayName)}</option>`).join('')}</select></label><label>目标<input id="goal-title" maxlength="120" value="${esc(draft.title)}"></label><label>协作约定<textarea id="goal-desc" maxlength="1000">${esc(draft.description)}</textarea></label></div></details><div id="goal-stages" class="goal-route-head"><b>阶段路线</b><small>${draft.stages.length} 个阶段</small></div><div class="goal-tree-root">${draft.stages.map(stageHTML).join('')}</div><div class="goal-add-stage">${[3,5,7,15].map(n=>btn(`＋ ${n} 天`,'add-stage',`data-length="${n}"`)).join('')}</div><div id="goal-weeks" class="goal-route-head"><b>周计划</b><small>${weeks().length} 周</small></div><div id="goal-route-weeks">${routeWeeksHTML()}</div>`;}
  function routeWeeksHTML(){return weeks().map((w,i)=>{const meta=weekMeta(w.key);return `<details class="goal-route-week" data-week="${w.key}" name="route-weeks" ${ui.weekKey===w.key?'open':''}><summary><b>第 ${i+1} 周 · ${w.days[0].date.slice(5)}—${w.days.at(-1).date.slice(5)}</b><small data-week-summary>${weekStats(w)}</small></summary><div class="goal-tree-fields"><small>${[...new Set(w.days.map(d=>esc(d.stageTitle)))].join(' · ')}</small><label>本周目标<input data-week-field="goal" maxlength="300" value="${esc(meta.goal)}"></label><label>预计学习量（分钟，可选）<input data-week-field="minutes" type="number" min="0" max="10080" value="${meta.minutes||''}"></label>${btn('安排每天 →','open-week',`data-week-key="${w.key}"`)}</div></details>`;}).join('');}
  function currentWeek(){const list=weeks();return list.find(w=>w.key===ui.weekKey)||list[0];}
  function weekHTML(){const w=currentWeek();if(!w)return `<p>先在路线总览设置正确的阶段日期。</p>${btn('设置阶段','route')}`;ui.weekKey=w.key;const list=weeks(),index=list.findIndex(v=>v.key===w.key),meta=weekMeta(w.key);return `<section class="goal-week-work" data-week="${w.key}"><div class="goal-week-switch">${btn('‹','previous-week',`${index===0?'disabled':''} aria-label="上一周"`)}<label><span class="sr-only">选择周</span><select id="goal-week-picker">${list.map((v,i)=>`<option value="${v.key}" ${v.key===w.key?'selected':''}>第 ${i+1} 周 · ${v.days[0].date.slice(5)}—${v.days.at(-1).date.slice(5)}</option>`).join('')}</select></label>${btn('›','next-week',`${index===list.length-1?'disabled':''} aria-label="下一周"`)}</div><p class="goal-week-context">${[...new Set(w.days.map(d=>esc(d.stageTitle)))].join(' · ')}</p><details class="goal-week-brief"><summary><b>${esc(meta.goal||'填写本周目标')}</b><small>本周目标与学习量</small></summary><div class="goal-tree-fields"><label>本周目标<input data-week-field="goal" maxlength="300" value="${esc(meta.goal)}"></label><label>预计学习量（分钟，可选）<input data-week-field="minutes" type="number" min="0" max="10080" value="${meta.minutes||''}"></label></div></details><div class="goal-workload" data-week-summary>${weekStats(w)}</div><div class="goal-week-tools">${btn('复用前一周','copy-week',index===0?'disabled':'')}<small>保留已单独调整的日期</small></div><div class="goal-tree-root goal-focused-days">${w.days.map(d=>{const s=stageBy(d.owner),open=ui.days[w.key]===d.date;return `<details class="goal-tree-day" data-day="${d.date}" data-owner="${d.owner}" name="focused-days" ${open?'open':''}><summary>${daySummary(s,d.date)}</summary><div data-day-editor>${open?dayEditor(s,d.date):''}</div></details>`;}).join('')}</div><div class="goal-next-week">${index<list.length-1?btn('继续下一周 →','next-week'):btn('检查并预览','preview')}</div></section>`;}
  function updateSummaries(s){
    const root=$('#goal-composer');if(!root)return;
    if(s){root.querySelectorAll('[data-goal-stage]').forEach(el=>{if(el.dataset.goalStage===s.id)el.querySelector('summary b').textContent=stageName(s);});}
    root.querySelectorAll('[data-day]').forEach(el=>{const owner=stageBy(el.dataset.owner),d=day(owner,el.dataset.day);el.querySelector('summary small').textContent=`${stageName(owner)} · ${d.rest?'休息日':d.slots.some(t=>!t.title.trim())?'尚未安排':`${d.slots.length} 项安排 · ${goalMinutes(d.slots)} 分钟`}`;el.querySelectorAll('[data-slot]').forEach(slotEl=>{const i=Number(slotEl.dataset.slot),t=d.slots[i];if(t){slotEl.querySelector('summary b').textContent=t.title||`时间段 ${i+1} · 待填写`;slotEl.querySelector('summary small').textContent=`${t.startTime?`${t.startTime}—${t.endTime}`:t.timeLabel||'时间自定'} · ${goalMinutes([t])} 分钟`;}});const total=el.querySelector('[data-day-total]');if(total)total.textContent=`当天已估 ${d.rest?0:goalMinutes(d.slots)} 分钟`;});
    const list=weeks();root.querySelectorAll('[data-week]').forEach(el=>{const w=list.find(w=>w.key===el.dataset.week);if(w&&el.querySelector('[data-week-summary]'))el.querySelector('[data-week-summary]').textContent=weekStats(w);});
    if($('#goal-context-title'))$('#goal-context-title').textContent=`给${choices.find(p=>p.id===draft.personId)?.displayName||''} · ${draft.title||'未命名目标'}`;
  }
  function mountShell(){
    openModal('制定监督计划',`<div class="goal-workspace-header"><p id="goal-context-title"></p><small id="goal-save-state" role="status"></small><div class="goal-mode-switch" aria-label="计划工作区">${draft.importMeta?'<button type="button" data-plan-mode="review">导入核对</button>':''}<button type="button" data-plan-mode="route">路线总览</button><button type="button" data-plan-mode="week">本周编排</button></div>${journeyHTML()}</div><div id="goal-composer"></div>`,preview);
    ownedDialog=$modal.querySelector('.dialog');ownedDialog.classList.add('goal-dialog','goal-workspace');
    $modal.querySelectorAll('[data-plan-mode]').forEach(b=>b.onclick=()=>switchMode(b.dataset.planMode));
    $modal.querySelectorAll('[data-plan-jump]').forEach(b=>b.onclick=()=>jumpTo(b.dataset.planJump));
    $('#modal-ok').textContent='预览计划';$('#modal-cancel').textContent='保存草稿';$('#modal-cancel').onclick=async()=>{const target=ownedDialog;save();try{await flush();closed=true;if(current()&&ownedDialog===target)closeModal();}catch(e){if(current())toast(e.message);}};
  }
  function reviewHTML(){const meta=draft.importMeta,source=meta.source,unknown=source.lines.filter(l=>l.kind==='unresolved');return `<section class="plan-review-intro"><span class="plan-kicker">内容已整理 · 等待你核对</span><h2>${esc(draft.title||'给这份计划起个名字')}</h2><p>先检查来源和安排依据，再按周微调。对方收到的是你确认后的服务计划。</p><div class="plan-import-metrics"><span><b>${draft.stages.length}</b>阶段</span><span><b>${weeks().length}</b>周</span><span><b>${allDays().length}</b>日历天</span><span><b>${unknown.length}</b>待识别原文</span></div></section><section class="plan-review-card"><h3>安排依据</h3><p>${meta.constraints.start} 起 · ${meta.constraints.days} 天<br>每日最多 ${meta.constraints.dailyLimit} 分钟 · ${esc(meta.constraints.timezone)}</p>${source.notices.map(n=>`<p class="plan-review-note">${esc(n)}</p>`).join('')}</section>${unknown.length?`<section class="plan-review-card"><h3>这些原文需要你处理</h3><p>它们没有自动填入日程。可到周编排中补充，也可注明不作为执行安排。</p>${(ui.reviewAll?unknown:unknown.slice(0,12)).map(l=>`<div class="plan-source-line"><small>原文第 ${l.line} 行</small><p>${esc(l.text)}</p><select data-source-resolution="${l.line}" aria-label="第 ${l.line} 行处理结果"><option value="">选择处理结果</option><option value="included" ${meta.resolutions?.[l.line]==='included'?'selected':''}>已补充到安排</option><option value="reference" ${meta.resolutions?.[l.line]==='reference'?'selected':''}>仅作参考，不纳入日程</option></select></div>`).join('')}${unknown.length>12&&!ui.reviewAll?btn('显示其余待处理原文','show-sources'):''}</section>`:''}<details class="plan-review-card"><summary>对照完整原文 · ${esc(source.name)}</summary><div class="plan-source-text">${source.lines.map(l=>`<p><small>${l.line} · ${l.kind==='unresolved'?'待处理':l.kind==='suggested'?'整理建议':'规则识别'}</small>${esc(l.text)}</p>`).join('')}</div></details><label class="plan-review-confirm"><input type="checkbox" id="plan-source-reviewed" ${meta.reviewed?'checked':''}><span>已对照原文核对阶段、每日安排与推导规则，并处理未识别内容。</span></label>${btn('查看阶段和每周安排 →','route')}</section>`;}
  function render(){
    if(!$modal.querySelector('.goal-workspace-header'))mountShell();
    const old=$('#goal-composer'),root=document.createElement('div');root.id='goal-composer';root.className='goal-composer goal-file-tree';root.innerHTML=ui.mode==='review'&&draft.importMeta?reviewHTML():ui.mode==='week'?weekHTML():overviewHTML();old.replaceWith(root);
    if(cloudMeta()&&$('#goal-person'))$('#goal-person').disabled=true;
    $modal.querySelectorAll('[data-plan-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.planMode===ui.mode)));
    const scrollKey=ui.mode==='week'?`week:${ui.weekKey}`:'route';root.addEventListener('scroll',()=>{ui.scrolls[scrollKey]=root.scrollTop;});requestAnimationFrame(()=>{if(root.isConnected)root.scrollTop=ui.scrolls[scrollKey]||0;});
    function input(e){const el=e.target;
      if(el.dataset.sourceResolution){draft.importMeta.resolutions||={};draft.importMeta.resolutions[el.dataset.sourceResolution]=el.value;if(!el.value){draft.importMeta.reviewed=false;if($('#plan-source-reviewed'))$('#plan-source-reviewed').checked=false;}save();return;}
      if(el.id==='plan-source-reviewed'){const unresolved=draft.importMeta.source.lines.filter(l=>l.kind==='unresolved'&&!draft.importMeta.resolutions?.[l.line]);if(el.checked&&unresolved.length){el.checked=false;toast('请先处理上方未识别的原文');}draft.importMeta.reviewed=el.checked;save();return;}
      if(el.id==='goal-title')draft.title=el.value;else if(el.id==='goal-desc')draft.description=el.value;else if(el.id==='goal-person')draft.personId=el.value;
      const stageEl=el.closest('[data-goal-stage]'),dayEl=el.closest('[data-day]'),s=stageBy(stageEl?.dataset.goalStage||dayEl?.dataset.owner),weekEl=el.closest('[data-week]'),slotEl=el.closest('[data-slot]');
      if(el.dataset.weekField){const date=weekEl.dataset.week;draft.weekPlans[date]={...weekMeta(date),[el.dataset.weekField]:el.dataset.weekField==='minutes'?Number(el.value)||0:el.value};const brief=weekEl.querySelector('.goal-week-brief>summary b');if(brief)brief.textContent=draft.weekPlans[date].goal||'填写本周目标';}
      if(s){if(el.dataset.field)s[el.dataset.field]=el.dataset.field==='hour'?Number(el.value):el.value;
        if(el.dataset.dayField||el.dataset.slotField){const d=clone(day(s,dayEl.dataset.day));d.generated=false;if(el.dataset.dayField)d[el.dataset.dayField]=el.dataset.dayField==='rest'?el.checked:el.value;else d.slots[Number(slotEl.dataset.slot)][el.dataset.slotField]=el.dataset.slotField==='minutes'?Number(el.value)||0:el.value;s.days[dayEl.dataset.day]=d;}
        if(el.dataset.dayField==='rest'&&e.type==='change')dayEl.querySelector('[data-day-editor]').innerHTML=dayEditor(s,dayEl.dataset.day);
        if((el.dataset.field==='start'||el.dataset.field==='end')&&e.type==='change'){save();render();return;}
        if(el.dataset.field==='content')root.querySelectorAll('[data-week]').forEach(row=>{const field=row.querySelector('[data-week-field="goal"]');if(field&&!draft.weekPlans[row.dataset.week])field.value=weekMeta(row.dataset.week).goal;});
      }
      updateSummaries(s);updateJourney();save();
      if(el.id==='goal-week-picker'&&e.type==='change')switchMode('week',el.value);
    }
    root.addEventListener('input',input);root.addEventListener('change',input);
    root.addEventListener('toggle',e=>{const el=e.target;if(el.tagName!=='DETAILS'||!root.isConnected)return;
      if(el.dataset.goalStage){if(el.open)ui.stage=el.dataset.goalStage;else if(ui.stage===el.dataset.goalStage)ui.stage='';}
      if(el.dataset.week&&el.open)ui.weekKey=el.dataset.week;
      if(el.dataset.day){if(el.open){ui.days[ui.weekKey]=el.dataset.day;const s=stageBy(el.dataset.owner),editor=el.querySelector('[data-day-editor]');if(!editor.childElementCount||!s.days[el.dataset.day])editor.innerHTML=dayEditor(s,el.dataset.day);}else if(ui.days[ui.weekKey]===el.dataset.day)delete ui.days[ui.weekKey];}
      if(el.dataset.slot!==undefined&&el.open)ui.slots[el.closest('[data-day]').dataset.day]=Number(el.dataset.slot);save();
    },true);
    root.addEventListener('click',e=>{const b=e.target.closest('[data-plan-action]');if(!b)return;
      const stageEl=b.closest('[data-goal-stage]'),dayEl=b.closest('[data-day]'),s=stageBy(stageEl?.dataset.goalStage||dayEl?.dataset.owner),date=dayEl?.dataset.day;
      const refreshDay=()=>{dayEl.querySelector('[data-day-editor]').innerHTML=dayEditor(s,date);updateSummaries(s);save();};
      switch(b.dataset.planAction){
        case 'show-sources':ui.reviewAll=true;render();break;
        case 'route':switchMode('route');break;
        case 'open-week':switchMode('week',b.dataset.weekKey);break;
        case 'next-week':case 'previous-week':{const list=weeks(),i=list.findIndex(w=>w.key===ui.weekKey)+(b.dataset.planAction==='next-week'?1:-1);if(list[i])switchMode('week',list[i].key);break;}
        case 'preview':preview();break;
        case 'add-stage':{if(draft.stages.length>=12)return toast('最多12个阶段');const last=draft.stages.reduce((a,b)=>a.end>b.end?a:b),next=makeStage(goalShift(last.end,1),Number(b.dataset.length));draft.stages.push(next);ui.stage=next.id;save();render();break;}
        case 'remove-stage':{const box=stageEl.querySelector('[data-remove-confirm]');box.hidden=false;box.innerHTML=`<p>删除该阶段及其草稿内容？</p>${btn('确认删除','confirm-remove')}${btn('保留','cancel-remove')}`;break;}
        case 'cancel-remove':stageEl.querySelector('[data-remove-confirm]').hidden=true;break;
        case 'confirm-remove':draft.stages=draft.stages.filter(v=>v.id!==s.id);ui.stage=draft.stages[0].id;save();render();break;
        case 'add-slot':{const d=clone(day(s,date));if(d.slots.length>=12)return toast('每天最多12项');d.slots.push(slot(''));d.generated=false;s.days[date]=d;ui.slots[date]=d.slots.length-1;refreshDay();break;}
        case 'delete-slot':{const d=clone(day(s,date));if(d.slots.length<=1)return;d.slots.splice(Number(b.closest('[data-slot]').dataset.slot),1);d.generated=false;s.days[date]=d;ui.slots[date]=0;refreshDay();break;}
        case 'template':{const previous=allDays().find(d=>d.date===goalShift(date,-1));if(b.dataset.template==='previous'&&!previous)return toast('计划中没有可复用的前一天');const box=dayEl.querySelector('[data-template-confirm]');box.hidden=false;box.innerHTML=`<p>替换当天目标与时间段，其他日期不受影响。</p>${btn('确认复用','confirm-template',`data-template="${b.dataset.template}"`)}${btn('保留原安排','cancel-template')}`;break;}
        case 'cancel-template':dayEl.querySelector('[data-template-confirm]').hidden=true;break;
        case 'confirm-template':{const previous=allDays().find(d=>d.date===goalShift(date,-1));s.days[date]=b.dataset.template==='previous'?clone(day(stageBy(previous.owner),previous.date)):{goal:'复习与练习',rest:false,slots:[{...slot('复习'),timeLabel:'晚上',minutes:20},{...slot('练习'),timeLabel:'晚饭后',minutes:20}]};s.days[date].generated=false;ui.slots[date]=0;refreshDay();break;}
        case 'copy-week':{const entries=allDays(),w=currentWeek();let count=0;w.days.forEach(d=>{const source=entries.find(v=>v.date===goalShift(d.date,-7)),owner=stageBy(d.owner);if(source&&(!owner.days[d.date]||owner.days[d.date].generated)){owner.days[d.date]={...clone(day(stageBy(source.owner),source.date)),generated:false};count++;}});save();render();toast(count?`已复用 ${count} 天，保留已微调日期`:'没有可复用日期，或本周日期已调整');break;}
      }
    });updateSummaries();updateJourney();save();
  }
  function payload(){const entries=allDays();return {assigneeId:draft.personId,requestId:requestId||undefined,title:draft.title.trim(),description:draft.description.trim(),cycles:draft.stages.map((s,i)=>({title:stageName(s),startDate:s.start,endDate:s.end,dailyContent:s.content.trim()||s.title.trim()||'阶段安排',remindHour:s.hour,dailyItems:entries.filter(d=>d.owner===s.id).map(d=>d.rest?{date:d.date,rest:true}:{date:d.date,content:(d.content||d.schedule.slots.map(t=>t.title).filter(Boolean).join('；')||'待填写').slice(0,500),schedule:d.schedule})}))};}
  function issues(){const out=[],entries=allDays();if(!draft.title.trim())out.push({text:'请填写服务目标'});
    draft.stages.forEach(s=>{const dates=goalDates(s.start,s.end);if(!dates.length||dates.length>120)out.push({text:`${stageName(s)}：检查日期，每阶段1—120天`});if(dates.length&&dates.every(date=>day(s,date).rest))out.push({text:`${stageName(s)}：至少安排一个执行日`});});
    if(entries.length>365||new Set(entries.map(d=>d.date)).size!==entries.length)out.push({text:'日期不能重叠，计划合计最多365天'});
    entries.filter(d=>!d.rest).forEach(d=>{let text='';const slots=d.schedule.slots;
      if(!slots.length||slots.some(t=>!t.title.trim()))text='还有事项未填写';
      const timed=slots.filter(t=>t.startTime).sort((a,b)=>a.startTime.localeCompare(b.startTime));
      if(slots.some(t=>!!t.startTime!==!!t.endTime||t.startTime&&t.endTime<=t.startTime)||timed.some((t,i)=>i&&t.startTime<timed[i-1].endTime))text='起止时间不完整或有重叠';
      if(slots.some(t=>!Number.isInteger(Number(t.minutes))||Number(t.minutes)<0||Number(t.minutes)>1440))text='预计分钟数需为0—1440的整数';
      if(text)out.push({text:`${d.date}：${text}`,date:d.date});
    });return out;
  }
  async function preview(){const target=ownedDialog;save();await ensureCloudDraft();try{await flush();}catch(e){if(current())toast(e.message);return;}if(!current()||ownedDialog!==target)return;const body=payload(),problems=issues(),warnings=draft.importMeta?.issues?.filter(v=>v.severity==='warning')||[];if(draft.importMeta){if(!draft.importMeta.reviewed)problems.unshift({text:'请核对导入来源及推导安排',review:true});problems.push(...(draft.importMeta.issues||[]).filter(v=>v.severity==='error'));}
    openModal('检查并预览计划',`<div class="goal-preview"><h2>${esc(body.title||'未命名目标')}</h2>${problems.length?`<section class="goal-issues"><b>有 ${problems.length} 处待完善</b>${problems.slice(0,12).map((v,i)=>btn(esc(v.text),'fix',`data-issue="${i}"`)).join('')}${problems.length>12?'<small>先完成这些安排，再检查其余日期。</small>':''}</section>`:'<p class="goal-composer-tip">检查通过</p>'}${warnings.length?`<details class="plan-review-card"><summary>${warnings.length} 项学习量提示</summary>${warnings.slice(0,20).map(w=>`<p>${w.date||''} · ${esc(w.text)}</p>`).join('')}</details>`:''}<details class="goal-week"><summary>完整阶段路线</summary>${draft.stages.map(s=>`<p><b>${esc(stageName(s))}</b><br>${s.start} — ${s.end}</p>`).join('')}</details>${goalDaysPreview(allDays())}<p>${esc(body.description)}</p></div>`,async()=>{if(problems.length)throw Error('请先完善上方列出的安排');const target=ownedDialog;await flush();if(!current()||ownedDialog!==target)return;const meta=cloudMeta();await api('POST','/api/plan-bundles',{...body,...(meta?{draftId:meta.id,draftVersion:meta.version}:{})});closed=true;clearTimeout(saveTimer);if(current()&&ownedDialog===target){try{localStorage.removeItem(key);}catch{}closeModal();await loadSection();if(st.view===originView){renderView();window.scrollTo(0,originScroll);}}toast('已发送，等待对方接受');});
    ownedDialog=$modal.querySelector('.dialog');ownedDialog.classList.add('goal-dialog');wireGoalAccordion($modal);$('#modal-ok').textContent='发送计划';$('#modal-cancel').textContent='返回编辑';$('#modal-cancel').onclick=render;
    $modal.querySelectorAll('[data-issue]').forEach(b=>b.onclick=()=>{const p=problems[Number(b.dataset.issue)];if(p.review)return switchMode('review');if(p.date){const w=goalWeek(p.date);ui.days[w]=p.date;ui.slots[p.date]=0;ui.scrolls[`week:${w}`]=0;switchMode('week',w);}else switchMode('route');});
  }
  if(imported&&!draft.workspace)ui.mode='review';
  render();
  ensureCloudDraft();
}

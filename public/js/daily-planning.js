'use strict';
function rollingAgreementModal(p) {
  const stages=p.kind==='cycle'?[p]:st.plans.filter(c=>c.parentId===p.id);
  const mine=p.assigneeId===me.id&&p.status==='proposed';
  openModal('阶段约定',`<h2>${esc(p.title)}</h2>${p.description?`<p>${esc(p.description)}</p>`:''}${stages.map(s=>`<section class="plan-review-card"><b>${esc(s.title)}</b><p>${esc(s.calendarStart)} — ${esc(s.calendarEnd)}</p><p>${esc(s.description)}</p></section>`).join('')}${mine?'<button class="btn soft" id="rolling-decline">提出调整</button>':''}`,async()=>{
    if(mine)await api('POST',`/api/plans/${p.id}/agreement`,{decision:'accept'});
    closeModal();await loadSection();renderView();
  });$('#modal-ok').textContent=mine?'接受阶段约定':'关闭';
  if($('#rolling-decline'))$('#rolling-decline').onclick=()=>openModal('提出调整','<label>调整建议<textarea id="rolling-note" maxlength="500" placeholder="希望调整哪些安排？"></textarea></label>',async()=>{await api('POST',`/api/plans/${p.id}/agreement`,{decision:'decline',note:$('#rolling-note').value});closeModal();await loadSection();renderView();});
}
async function newGoalModal(assigneeId,requestId,desiredStartAt) {
  const choices=requestId?[{id:assigneeId,displayName:personName(assigneeId)}]:people.filter(p=>p.relationship==='managed');
  if(!choices.length)return toast('请先确认接手协商');
  const start=desiredStartAt?toLocalInput(desiredStartAt).slice(0,10):todayStrL();
  openModal('新建目标',`
    <label>服务对象<select id="rolling-person">${choices.map(p=>`<option value="${esc(p.id)}" ${p.id===assigneeId?'selected':''}>${esc(p.displayName)}</option>`).join('')}</select></label>
    <label>长期目标<input id="rolling-title" maxlength="120" placeholder="例如：三个月建立稳定英语学习习惯"></label>
    <label>总体约定<textarea id="rolling-description" maxlength="1000" placeholder="例如：每周复盘一次，具体安排提前2—3天协商"></textarea></label>
    <label>当前阶段名称<input id="rolling-stage" maxlength="120" value="第一阶段"></label>
    <div class="form-grid"><label>阶段开始<input type="date" id="rolling-start" value="${start}"></label><label>阶段结束<input type="date" id="rolling-end" value="${goalShift(start,27)}"></label></div>
    <label>阶段方向与节奏<textarea id="rolling-rhythm" maxlength="500" placeholder="例如：每周学习四天，每次约30分钟，内容由执行人提前提交"></textarea></label>
    <button type="button" class="btn soft" id="rolling-existing">导入或详细编排</button>`,async()=>{
      const body={planningMode:'rolling',assigneeId:$('#rolling-person').value,requestId:requestId||undefined,title:$('#rolling-title').value.trim(),description:$('#rolling-description').value.trim(),cycles:[{title:$('#rolling-stage').value.trim(),startDate:$('#rolling-start').value,endDate:$('#rolling-end').value,rhythm:$('#rolling-rhythm').value.trim()}]};
      await api('POST','/api/plan-bundles',body);closeModal();await loadSection();renderView();toast('已发送，等待对方接受');
    });
  $('#modal-ok').textContent='发送阶段约定';
  $('#rolling-existing').onclick=()=>fixedGoalModal($('#rolling-person').value,requestId,desiredStartAt);
}

async function openDailyPlanner(planId,expanded=false) {
  const current=modalReadGuard();
  try{
    const p=st.plans.find(p=>p.id===planId);
    if(!p)return toast('请先打开目标并刷新阶段');
    const [result,dayResult]=await Promise.all([api('GET',`/api/plans/${planId}/daily-proposals`),api('GET',`/api/plans/${planId}/days`)]);
    if(!current())return;
    const days=dayResult.days,proposals=result.proposals;
    const dates=goalDates(result.today,result.lastDate).filter(date=>date>=p.calendarStart&&date<=p.calendarEnd);
    const labels={draft:'我的草稿',submitted:'待对方确认',accepted:'已确认生效',declined:'已退回',withdrawn:'已撤回',closed:'随阶段结束关闭'};
    const tasks=data=>data?.rest?'双方休息':(data?.items||[]).map(i=>esc(i.title)).join('；')||'尚未安排';
    const shown=expanded?dates:dates.slice(0,3);
    openModal(p.title+' · 每日安排',`<div class="daily-planner-body">${p.description?`<p class="muted">${esc(p.description)}</p>`:''}
      ${result.writable?`<div class="row"><button class="btn soft" id="daily-window">${expanded?'只看近三天':'查看未来两周'}</button></div>${shown.map(date=>{const day=days.find(d=>d.dayDate===date);return `<section class="plan-review-card"><b>${esc(date)}</b><p>${day?day.checkinState==='cancelled'?'双方已确认休息':esc(day.content):'尚未安排'}</p><button class="btn sm" data-daily-edit="${date}">${day?'申请调整':'提出每日安排'}</button></section>`;}).join('')||'<p>暂无可安排日期</p>'}`:`<p>${p.status==='archived'?'阶段已归档，仅供查看':'当前仅供查看'}</p>`}
      <h3>草稿与调整记录</h3>${proposals.map(r=>`<section class="plan-review-card"><b>${esc(r.day_date)} · ${labels[r.status]||esc(r.status)}</b><p>发起人：${r.proposer_id===me.id?'我':'对方'} · ${esc(r.reason)}</p><p>原安排：${r.base?esc(r.base.day.content):'尚未安排'}</p><p>提案：${tasks(r.payload)}</p>${r.decision_note?`<p>反馈：${esc(r.decision_note)}</p>`:''}
        ${result.writable&&r.proposer_id===me.id&&r.status==='draft'?`<button class="btn sm soft" data-daily-draft="${r.id}">编辑草稿</button> <button class="btn sm" data-daily-action="submit" data-proposal="${r.id}">提交对方</button>`:''}
        ${result.writable&&r.proposer_id===me.id&&['draft','submitted'].includes(r.status)?` <button class="btn sm soft" data-daily-action="withdraw" data-proposal="${r.id}">撤回</button>`:''}
        ${result.writable&&r.proposer_id!==me.id&&r.status==='submitted'?`<button class="btn sm" data-daily-action="accept" data-proposal="${r.id}">确认生效</button> <button class="btn sm soft" data-daily-action="decline" data-proposal="${r.id}">提出调整</button>`:''}</section>`).join('')||'<p>暂无记录</p>'}</div>`,closeModal);
    $modal.querySelector('.dialog').classList.add('daily-planner-dialog');$('#modal-ok').textContent='关闭';$('#modal-cancel').hidden=true;
    if($('#daily-window'))$('#daily-window').onclick=()=>openDailyPlanner(planId,!expanded);
    $modal.querySelectorAll('[data-daily-edit]').forEach(b=>{
      const day=days.find(d=>d.dayDate===b.dataset.dailyEdit);
      if(['submitted','approved'].includes(day?.checkinState)){
        b.textContent=day.checkinState==='approved'?'已确认完成，不可调整':'打卡待审核，不可调整';
        b.disabled=true;
        return;
      }
      const pending=proposals.find(r=>r.day_date===b.dataset.dailyEdit&&['draft','submitted'].includes(r.status));
      b.textContent=pending?(pending.proposer_id===me.id&&pending.status==='draft'?'继续编辑':'等待对方处理'):'编辑每日内容';
      b.disabled=!!pending&&!(pending.proposer_id===me.id&&pending.status==='draft');
      b.onclick=()=>dailyEditor(p,days,b.dataset.dailyEdit,pending);
    });
    $modal.querySelectorAll('[data-daily-draft]').forEach(b=>b.onclick=()=>{const row=proposals.find(r=>r.id===b.dataset.dailyDraft);dailyEditor(p,days,row.day_date,row);});
    $modal.querySelectorAll('[data-daily-action]').forEach(b=>b.onclick=async()=>{
      const row=proposals.find(r=>r.id===b.dataset.proposal),action=b.dataset.dailyAction;
      const act=async note=>{await api('POST',`/api/plans/${planId}/daily-proposals/${row.id}/action`,{action,version:row.version,note});delete st._pd?.[planId];await loadSection();renderView();await openDailyPlanner(planId,expanded);};
      if(action==='decline')return openModal('提出调整','<label>调整建议<textarea id="daily-decision" maxlength="500" placeholder="希望调整哪些事项？"></textarea></label>',()=>act($('#daily-decision').value));
      const label=b.textContent;
      b.disabled=true;b.setAttribute('aria-busy','true');b.textContent=action==='submit'?'提交中…':action==='accept'?'确认中…':'撤回中…';
      try{await act();}catch(e){toast(e.message);b.disabled=false;}
      finally{if(b.isConnected){b.removeAttribute('aria-busy');b.textContent=label;}}
    });
  }catch(e){toast(e.message);}
}

function dailyEditor(p,days,date,draft) {
  const owner=me.id,key=`daily-editor:${owner}:${p.id}:${date}`,templateKey=`daily-template:${owner}:${p.id}`;
  const raw=()=>{try{return localStorage.getItem(key);}catch{return null;}};
  const read=value=>{try{const v=JSON.parse(value);return v&&typeof v.text==='string'&&typeof v.reason==='string'&&typeof v.rest==='boolean'?v:null;}catch{return null;}};
  const snapshot=(proposal,day)=>JSON.stringify({draft:proposal?{id:proposal.id,version:proposal.version}:null,existing:day||null});
  const content=(proposal,day)=>({text:(proposal?.payload.items||day?.items||[]).map(i=>i.title).join('\n'),rest:proposal?!!proposal.payload.rest:day?.checkinState==='cancelled',reason:proposal?.reason||''});
  let existing=days.find(d=>d.dayDate===date),source=draft?.payload.items||existing?.items||[];
  let stamp=snapshot(draft,existing),lastLocal=raw();
  const cached=read(lastLocal),previous=days.filter(d=>d.dayDate<date&&d.items?.length&&d.checkinState!=='cancelled').sort((a,b)=>b.dayDate.localeCompare(a.dayDate))[0];
  let proposalId=draft?.id;
  let template;try{template=JSON.parse(localStorage.getItem(templateKey));}catch{}
  const initial=cached||((draft||existing)?content(draft,existing):{text:template?.text||previous?.items.map(i=>i.title).join('\n')||'',rest:false,reason:''});
  openModal(date+' · 每日安排',`<p class="muted" id="daily-progress" role="status">${cached?'已恢复本机草稿':!draft&&!existing&&initial.text?'已沿用上次内容':'草稿仅自己可见'}</p>
    <section id="daily-conflict" class="plan-review-card" hidden aria-live="polite"><h3>每日安排需要核对</h3><p id="daily-conflict-status"></p><b>本机填写</b><pre id="daily-conflict-local" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><b>服务器版本</b><pre id="daily-conflict-server" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><div class="row"><button type="button" class="btn soft" id="daily-conflict-retry">重新读取服务器</button><button type="button" class="btn soft" id="daily-use-server">读取服务器版本</button><button type="button" class="btn" id="daily-keep-local">保留本机内容继续编辑</button></div></section>
    <section id="daily-replaced-local" class="plan-review-card" hidden><b>替换前的填写（关闭窗口后清除）</b><pre id="daily-replaced-content" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></section>
    <section id="daily-local-conflict" class="plan-review-card" hidden aria-live="polite"><p>另一标签页已修改草稿，请选择保留哪份填写。</p><pre id="daily-tab-content" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><button type="button" class="btn soft" id="daily-use-tab">读取另一标签填写</button> <button type="button" class="btn soft" id="daily-keep-tab">保留当前填写到本机</button></section>
    <label class="form-check"><input id="daily-rest" type="checkbox" ${initial.rest?'checked':''}>这一天改为休息</label>
    <label>具体事项（每行一项）<textarea id="daily-items" rows="6" placeholder="晚饭后 复习20个单词&#10;20:00 阅读10分钟">${esc(initial.text)}</textarea></label>
    ${(existing?.items||[]).some(item=>item.status==='done')?'<p class="muted" id="daily-completed-note">已完成事项不可删除或更改</p>':''}
    <label>安排说明（选填）<textarea id="daily-reason" maxlength="500" placeholder="安排依据或调整原因">${esc(initial.reason)}</textarea></label>
    <button type="button" class="btn" id="daily-save-submit">保存并提交对方</button>`,()=>save(false));
  $('#modal-ok').textContent='保存草稿';
  $('#modal-ok').setAttribute('class','btn soft');
  const dialog=$modal.querySelector('.dialog'),session=token;
  const node=id=>dialog.querySelector('#'+id),itemsField=node('daily-items'),reasonField=node('daily-reason'),restField=node('daily-rest'),progress=node('daily-progress');
  const saveButton=node('modal-ok'),submitButton=node('daily-save-submit'),panel=node('daily-conflict'),localPanel=node('daily-local-conflict');
  const actions=dialog.querySelector('.dlg-actions');
  if(actions?.appendChild){actions.classList.add('daily-editor-actions');actions.appendChild(submitButton);}
  const current=()=>token===session&&me?.id===owner&&dialog.isConnected&&$modal.querySelector('.dialog')===dialog;
  const values=()=>({text:itemsField.value,rest:restField.checked,reason:reasonField.value});
  const summary=v=>`休息：${v.rest?'是':'否'}\n事项：${v.text||'（无）'}\n说明：${v.reason||'（无）'}`;
  let busy=false,conflict=false,reading=false,blocked=false,localConflict=false,latest=null,rejected=false;
  function controls(){
    [reasonField,restField].forEach(el=>el.disabled=busy);itemsField.disabled=busy||restField.checked;
    [saveButton,submitButton].forEach(el=>el.disabled=busy||conflict||blocked||localConflict);
    if(panel){node('daily-conflict-retry').disabled=busy||reading;node('daily-use-server').disabled=busy||reading||!latest||localConflict;node('daily-keep-local').disabled=busy||reading||!latest?.editable||localConflict;}
  }
  function detectLocalChange(){
    if(raw()===lastLocal)return localConflict;
    localConflict=true;
    if(localPanel){localPanel.hidden=false;const other=read(raw());node('daily-tab-content').textContent=other?summary(other):'另一标签已保存或清除了缓存。';node('daily-use-tab').disabled=!other;}
    controls();return true;
  }
  function remember(){
    if(!current()||detectLocalChange())return;
    try{const value=JSON.stringify({stamp,...values()});localStorage.setItem(key,value);lastLocal=value;progress.textContent=conflict?'本机填写已保留，请核对版本':'本机草稿已保存 · 未提交';}
    catch{progress.textContent='无法保留本机草稿，请复制备份';}
    if(conflict&&panel)node('daily-conflict-local').textContent=summary(values());
  }
  function apply(v){itemsField.value=v.text;restField.checked=v.rest;reasonField.value=v.reason;controls();}
  async function recover(){
    if(!current()||reading)return;
    conflict=true;reading=true;latest=null;
    progress.textContent='版本已变化，本机填写已保留';
    if(panel){panel.hidden=false;node('daily-conflict-local').textContent=summary(values());node('daily-conflict-server').textContent='正在读取…';node('daily-conflict-status').textContent='请核对最新版本，选择后仍需保存。';}
    controls();
    try{
      const [result,dayResult]=await Promise.all([api('GET',`/api/plans/${p.id}/daily-proposals`),api('GET',`/api/plans/${p.id}/days`)]);
      if(!current())return;
      const day=dayResult.days.find(d=>d.dayDate===date),rows=result.proposals.filter(r=>r.day_date===date);
      // A terminal original proposal must never turn into a new proposal during recovery.
      const proposal=proposalId?rows.find(r=>r.id===proposalId):rows.find(r=>r.proposer_id===owner&&r.status==='draft');
      const pending=rows.find(r=>['draft','submitted'].includes(r.status));
      const editable=!!result.writable&&date>=result.today&&date<=result.lastDate&&!['submitted','approved'].includes(day?.checkinState)
        &&(proposalId?proposal?.status==='draft'&&proposal.proposer_id===owner:proposal?proposal.status==='draft':!pending&&!rejected);
      latest={proposal,day,editable,content:content(proposal,day)};
      if(panel){node('daily-conflict-server').textContent=summary(latest.content);node('daily-conflict-status').textContent=(editable?'选择后仍需保存。':'当前状态不可修改，请返回查看最新安排。')+'读取服务器版本将替换当前填写，原文暂存在本窗口。';}
    }catch(e){if(current()&&panel){node('daily-conflict-server').textContent='读取失败，本机填写已保留';node('daily-conflict-status').textContent=e.message+'；请重新读取服务器。';}}
    finally{reading=false;if(current())controls();}
  }
  function chooseServer(keepLocal){
    if(!current()||busy||reading||!latest||detectLocalChange()||(keepLocal&&!latest.editable))return;
    draft=latest.proposal;proposalId=draft?.id;existing=latest.day;source=existing?.items||[];stamp=snapshot(draft,existing);blocked=!latest.editable;
    if(!keepLocal){const backup=node('daily-replaced-local');if(backup){backup.hidden=false;node('daily-replaced-content').textContent=summary(values());}apply(latest.content);}
    conflict=false;panel.hidden=true;remember();controls();
    progress.textContent=blocked?'已读取最新内容 · 当前不可保存':keepLocal?'已保留本机填写 · 待保存':'已读取服务器版本 · 待保存';
  }
  if(panel){node('daily-conflict-retry').onclick=recover;node('daily-use-server').onclick=()=>chooseServer(false);node('daily-keep-local').onclick=()=>chooseServer(true);}
  if(localPanel){
    node('daily-keep-tab').onclick=()=>{if(!current()||busy)return;lastLocal=raw();localConflict=false;localPanel.hidden=true;remember();controls();};
    node('daily-use-tab').onclick=()=>{if(!current()||busy)return;const other=read(raw());if(!other)return detectLocalChange();lastLocal=raw();localConflict=false;localPanel.hidden=true;apply(other);if(other.stamp!==stamp){stamp=other.stamp;recover();}else{remember();controls();}};
  }
  if(typeof window!=='undefined'){
    if(dailyEditor.storageListener)window.removeEventListener('storage',dailyEditor.storageListener);
    const listener=event=>{if(!current()){window.removeEventListener('storage',listener);return;}if(event.key===key||event.key===null)detectLocalChange();};
    dailyEditor.storageListener=listener;window.addEventListener('storage',listener);
  }
  itemsField.oninput=remember;reasonField.oninput=remember;
  restField.onchange=()=>{itemsField.disabled=restField.checked;remember();};itemsField.disabled=restField.checked;
  async function save(submit) {
    if(!current()||busy||conflict||blocked||detectLocalChange())return;remember();busy=true;
    const savedLocal=raw();controls();
    const activeButton=submit?submitButton:saveButton;
    activeButton.setAttribute('aria-busy','true');activeButton.textContent=submit?'提交中…':'保存中…';
    dialog.setAttribute('aria-busy','true');progress.setAttribute('role','status');progress.textContent=submit?'正在保存并提交…':'正在保存草稿…';
    let stored=false;
    try{
      const rest=restField.checked,used=new Set();
      const items=rest?[]:itemsField.value.split('\n').map(s=>s.trim()).filter(Boolean).map(title=>{
        const old=source.find(i=>i.id&&i.title===title&&!used.has(i.id));if(old){used.add(old.id);return {id:old.id,title};}return {title};
      });
      const saved=await api('POST',`/api/plans/${p.id}/daily-proposals`,{date,payload:{rest,items},reason:reasonField.value,...(draft?{draftId:draft.id,version:draft.version}:{})});
      draft=saved.proposal;proposalId=draft.id;stored=true;
      if(session!==token||me?.id!==owner)return;
      try{
        if(raw()===savedLocal){localStorage.removeItem(key);lastLocal=null;}
        if(!rest)localStorage.setItem(templateKey,JSON.stringify({text:items.map(i=>i.title).join('\n')}));
      }catch{}
      if(submit)await api('POST',`/api/plans/${p.id}/daily-proposals/${saved.proposal.id}/action`,{action:'submit',version:saved.proposal.version});
      if(current()){progress.textContent=submit?'已提交给对方，等待确认。正在读取最新安排…':'草稿已保存，正在读取最新安排…';await openDailyPlanner(p.id);}
      else if(session===token)toast(date+(submit?' 的安排已提交':' 的草稿已保存'));
    }catch(e){
      if(current()){
        if(e.status===409){rejected=true;remember();await recover();}
        else progress.textContent=(stored?'草稿已保存；提交未完成，请刷新确认后再操作。':'未保存，请重试。')+e.message;
        toast(e.message);
      }
    }finally{busy=false;if(current()){controls();dialog.removeAttribute('aria-busy');activeButton.removeAttribute?.('aria-busy');saveButton.textContent='保存草稿';submitButton.textContent='保存并提交对方';}}
  }
  // The editor owns its busy state, including the recovery choices after HTTP 409.
  saveButton.onclick=()=>save(false);submitButton.onclick=()=>save(true);
  if(cached&&cached.stamp!==stamp)recover();
}

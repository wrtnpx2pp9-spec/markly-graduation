/* Markly · 通知组件 */
'use strict';

// ---------- 通知 ----------
function renderNotes(c) {
  const session=token,userId=me?.id;
  const current=()=>session===token&&userId===me?.id;
  const notes = st.notes;
  const kinds = {
    task_remind: ['⏰', '任务提醒'], supervise_remind: ['👀', '去监督'],
    task_overdue: ['⚠️', '任务超时'], supervise_overdue: ['🔔', '监督跟进'],
    task_overdue_followup: ['🚨', '超时催办'], supervise_overdue_followup: ['🚨', '超时跟进'],
    task_done: ['✅', '完成'],
    task_submitted: ['📩', '待确认'], task_review: ['✅', '审核结果'], plan_update: ['📋', '计划 / 打卡进展'],
    plan_remind: ['⏰', '今日打卡'], plan_supervise: ['👀', '去监督打卡'],
    plan_miss: ['⚠️', '漏卡'], plan_miss_sup: ['🔔', '跟进打卡'],
    default: ['📢', '通知'],
  };
  c.innerHTML = `
  <div class="row spread" style="margin-bottom:14px">
    <h1 style="margin:0">通知</h1>
    <div class="row">
      <button class="btn sm soft" id="notif-perm">开启桌面通知</button>
      <button class="btn sm soft" id="notif-read">全部已读</button>
    </div>
  </div>
  <div class="card notes-feed">
    ${notes.length ? notes.map((n) => {
      const [nn, lbl] = kinds[n.kind] || kinds.default;
      return `<article class="note ${n.isRead ? '' : 'unread'}" data-notification="${esc(n.id)}">
        <div class="note-icon">${nn}</div>
        <div class="nbody">
          <div class="note-head"><div class="notetitle">${esc(n.title)}</div>${n.isRead ? '' : '<span class="note-state">新</span>'}</div>
          <div class="note-content">${esc(n.content)}</div>
          <div class="note-meta"><span>${lbl}</span><time>${fmtTime(n.createdAt)}</time></div>
          ${!n.isRead?`<button class="linkbtn" data-note-read="${esc(n.id)}" aria-label="将 ${esc(n.title)} 标为已读">标为已读</button>`:''}
          ${n.linkType ? `<button class="linkbtn" data-note-type="${esc(n.linkType)}" data-note-id="${esc(n.linkId)}">查看并处理 →</button>` : ''}
        </div></article>`;
    }).join('') : '<div class="empty">暂无通知</div>'}
  </div>${st.notesNextOffset!=null?'<button class="btn soft" id="notes-more">加载更早消息</button>':''}`;

  if($('#notes-more'))$('#notes-more').onclick=async()=>{
    if(!current())return;
    const button=$('#notes-more');button.disabled=true;button.textContent='加载中…';
    try{await loadNotes(st.notesNextOffset);if(current()&&c.isConnected&&st.view==='notes')renderNotes(c);}
    catch(e){if(current())toast(e.message);button.disabled=false;button.textContent='加载更早消息';}
  };
  c.querySelectorAll('[data-note-read]').forEach(button=>button.onclick=async()=>{
    if(button.disabled||!current())return;
    button.disabled=true;notesReadRevision++;
    try{
      await api('PUT','/api/notifications/'+encodeURIComponent(button.dataset.noteRead)+'/read');
      if(!current())return;
      const note=st.notes.find(row=>row.id===button.dataset.noteRead);
      if(note&&!note.isRead){note.isRead=true;unread=Math.max(0,unread-1);updateBadge();}
      const row=button.closest('.note');row.classList.remove('unread');row.querySelector('.note-state')?.remove();button.remove();
    }catch(e){if(current())toast(e.message);button.disabled=false;}
    finally{if(current())notesReadRevision++;}
  });

  let readRefreshPending=false;
  $('#notif-read').onclick = async () => {
    const button=$('#notif-read');
    if(button.disabled||!current())return;
    const retryOnly=readRefreshPending;
    const submittedIds=new Set(st.notes.map(note=>note.id));
    notesReadRevision++;
    try {
      button.disabled=true;button.textContent=retryOnly?'读取中…':'处理中…';
      if(!retryOnly){
        await api('POST', '/api/notifications/read');
        if(!current())return;
        let changed=0;
        st.notes=st.notes.map(note=>{
          if(!submittedIds.has(note.id)||note.isRead)return note;
          changed++;
          return {...note,isRead:true};
        });
        unread=Math.max(st.notes.filter(note=>!note.isRead).length,unread-changed);updateBadge();
        c.querySelectorAll('.note.unread').forEach(note=>{
          if(!submittedIds.has(note.dataset.notification))return;
          note.classList.remove('unread');note.querySelector('.note-state')?.remove();note.querySelector('[data-note-read]')?.remove();
        });
      }
      try{
        await loadNotes(0,{preserveOlder:true});
        if(!current())return;
        readRefreshPending=false;
        if(c.isConnected&&st.view==='notes')renderNotes(c);
        toast(retryOnly?'未读状态已刷新':unread?'已标记之前的通知，新消息仍待阅读':'已全部标记为已读');
      }catch(e){
        if(!current())return;
        readRefreshPending=true;
        toast('通知已标记为已读，未读状态暂时无法刷新；请重试读取状态。');
      }
    } catch (e) { if(current())toast(e.message); }
    finally { if(current())notesReadRevision++;button.disabled=false;button.textContent=readRefreshPending?'重试读取状态':'全部已读'; }
  };
  $('#notif-perm').onclick = () => {
    if (!('Notification' in window)) { toast('当前浏览器不支持桌面通知'); return; }
    Notification.requestPermission().then((p) => { if(current())toast(p === 'granted' ? '桌面通知已开启' : '未授权'); });
  };
  c.querySelectorAll('[data-note-type]').forEach((b) => {
    b.onclick = async () => {
      if (b.disabled) return;
      b.disabled = true;
      try {
      const id=b.dataset.noteId,type=b.dataset.noteType;
      if(type==='day')await openDay(id);
      else if(type==='task')await openTask(id);
      else if(type==='request')await openRequest(id);
      else if(type==='profile')publicProfileLink(id, 'notes');
      else if(type==='plan')await agreementModal(id);
      else toast('这条通知暂无可打开的页面');
      } catch (error) { toast(error.message); }
      finally { b.disabled = false; }
    };
  });
}

/* Markly · 生活记录组件 */
'use strict';

// ---------- 生活记录 ----------
function renderLife(c) {
  const draftKey='life-draft:'+me.id;
  let draft={};try{draft=JSON.parse(sessionStorage.getItem(draftKey))||{};}catch{}
  const remember=()=>{try{sessionStorage.setItem(draftKey,JSON.stringify({date:$('#lf-date').value,mood:$('#lf-mood').value,content:$('#lf-content').value}));}catch{}};
  const grouped = {}; // date -> logs
  st.logs.forEach((l) => { (grouped[l.date] = grouped[l.date] || []).push(l); });
  const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));
  c.innerHTML = `
  <div class="row spread" style="margin-bottom:14px">
    <div><button class="page-back" id="life-back">← 返回我的</button><h1 style="margin:0">私人生活记录</h1></div>
  </div>
  <div class="card">
    <h2>记录今天</h2>
    <label for="lf-date">日期</label><input id="lf-date" type="date" value="${esc(draft.date||todayStr())}" />
    <label for="lf-mood">心情（选填）</label><input id="lf-mood" maxlength="50" placeholder="😊 / 😌 / 😤 / 😴 / 💪" value="${esc(draft.mood??'😊')}" />
    <label for="lf-content">记录内容</label><textarea id="lf-content" maxlength="10000" placeholder="今天做了什么、有什么收获、值得记录的事……">${esc(draft.content||'')}</textarea>
    <button class="btn block" id="lf-add" style="margin-top:14px">保存记录</button>
  </div>

  <div style="height:16px"></div>
  ${dates.length ? dates.map((d) => `
    <div class="card" style="margin-bottom:12px">
      <div class="loghead"><span class="logdate">${esc(d)}</span></div>
      ${grouped[d].map((l) => `
        <div class="logitem">
          <div>${l.mood ? `<span class="logmood">${esc(l.mood)}</span>` : ''}</div>
          <div class="logcontent">${esc(l.content)}</div>
          <button class="linkbtn danger" data-action="delLog" data-id="${l.id}">删除</button>
        </div>`).join('')}
    </div>`).join('') : '<div class="empty">还没有生活记录，记录第一条吧</div>'}${st.lifeNextOffset!=null?'<button class="btn soft" id="life-more">加载更早记录</button>':''}`;

  for(const id of ['lf-date','lf-mood','lf-content']){c.querySelector('#'+id).oninput=remember;c.querySelector('#'+id).onchange=remember;}
  if($('#life-more'))$('#life-more').onclick=async()=>{const button=$('#life-more');button.disabled=true;button.textContent='加载中…';try{await loadLife(st.lifeNextOffset);if(c.isConnected&&st.view==='life')renderLife(c);}catch(e){toast(e.message);button.disabled=false;button.textContent='加载更早记录';}};
  $('#lf-add').onclick = async () => {
    const button=c.querySelector('#lf-add'),editor=c.querySelector('#lf-content'),session=token;
    if(button.disabled)return;
    const content = editor.value.trim();
    if (!content) { toast('内容不能为空'); return; }
    const dateInput=c.querySelector('#lf-date'),moodInput=c.querySelector('#lf-mood');
    const submitted={date:dateInput.value,mood:moodInput.value,content:editor.value};
    const matchesSubmitted=(draft)=>draft.date===submitted.date&&draft.mood===submitted.mood&&draft.content===submitted.content;
    button.disabled=true;
    try {
      const {log}=await api('POST', '/api/life', { date: submitted.date, content, mood: submitted.mood.trim() });
      if(session!==token)return;
      try{const latest=JSON.parse(sessionStorage.getItem(draftKey)||'{}');if(matchesSubmitted(latest))sessionStorage.removeItem(draftKey);}catch{}
      if(editor.isConnected&&matchesSubmitted({date:dateInput.value,mood:moodInput.value,content:editor.value}))editor.value='';
      st.logs=[log,...st.logs.filter(row=>row.id!==log.id)];
      let message='已保存';
      try{await loadLife();}catch{message='记录已保存，列表暂时无法刷新；请稍后重新加载，无需重复提交。';}
      if(session!==token)return;
      if(editor.isConnected&&document.getElementById('lf-content')===editor&&st.view==='life')renderView();
      toast(message);
    } catch (e) { toast(e.message); }
    finally{button.disabled=false;}
  };
  $('#life-back').onclick = () => goView('my');
  c.querySelectorAll('[data-action="delLog"]').forEach((b) => {
    b.onclick = async () => {
      if(b.disabled)return;
      if (!confirm('删除这条记录？')) return;
      b.disabled=true;const session=token;
      try {
        await api('DELETE', `/api/life/${b.dataset.id}`);
        if(session!==token)return;
        st.logs=st.logs.filter(row=>row.id!==b.dataset.id);
        let message='已删除';
        try{await loadLife();}catch{message='记录已删除，列表暂时无法刷新；请稍后重新加载。';}
        if(session!==token)return;
        if(c.isConnected&&st.view==='life')renderView();toast(message);
      } catch (e) { toast(e.message); }
      finally{b.disabled=false;}
    };
  });
}

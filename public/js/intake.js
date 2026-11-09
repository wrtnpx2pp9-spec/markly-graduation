/* Post-login certification and personal intake share the application form style. */
'use strict';
async function renderIntake(c) {
  const generation=(c._intakeGeneration||0)+1;c._intakeGeneration=generation;
  const session=token,userId=me.id,role=me.role;
  const currentSession=()=>session===token&&userId===me?.id&&role===me?.role;
  const currentPage=()=>currentSession()&&c.isConnected&&st.view==='intake'&&c._intakeGeneration===generation;
  const supervisor=me.role==='supervisor';
  c.innerHTML='<div class="registration-page"><div class="registration-sheet">正在读取资料…</div></div>';
  let a=null;
  try {
    if(!supervisor) a=(await api('GET','/api/assessment/me')).assessment;
    if(!currentPage())return;
    const title=supervisor?'身份与能力认证':'个人档案';
    const start=a?.desiredStartAt?toLocalInput(a.desiredStartAt).slice(0,10):todayStr();
    const field=(label,id,value,max,placeholder='',required=true)=>`<label class="registration-field">${label}<textarea id="${id}" maxlength="${max}" ${required?'required':''} placeholder="${placeholder}" rows="3">${esc(value||'')}</textarea></label>`;
    c.innerHTML=`<div class="registration-page intake-page"><section class="registration-sheet"><button class="linkbtn intake-back" id="intake-back">← 返回我的</button><header class="registration-heading"><h1>${title}</h1></header><form id="intake-form">
      ${supervisor?`<section class="registration-section"><div class="registration-section-heading"><span>01</span><div><h2>认证方向</h2></div></div><label class="registration-field">本次认证身份<select id="cert-direction" required><option value="mentor" ${me.identity==='mentor'?'selected':''}>Mentor · 导师</option><option value="supervisor" ${me.identity!=='mentor'?'selected':''}>Supervisor · 监督者</option></select></label><p class="registration-review-note" id="cert-direction-hint"></p></section>
      <section class="registration-section"><div class="registration-section-heading"><span>02</span><div><h2>技能与经验</h2></div></div><label class="registration-field">能力名称<input id="cert-title" required maxlength="80" placeholder="例如：英语口语指导"></label>${field('技能 / 擅长领域','cert-skills','',300,'例如：英语口语、设计入门、备考规划')}${field('<span id="cert-strengths-label">擅长什么，有哪些经验</span>','cert-strengths','',1500,'')}
      <label class="registration-field">相关机构（可选）<input id="cert-issuer" maxlength="100"></label>${field('核验材料','cert-evidence','',2000,'可核实的作品、服务经历，或证书编号及核验方式。')}</section>
      <section class="registration-section"><div class="registration-section-heading"><span>03</span><div><h2>空闲时间</h2></div></div>${field('通常什么时候有空','cert-availability','',500,'例如：工作日 19:00–21:00（中国时间）')}<label class="registration-field">每周投入（分钟）<input id="cert-weekly-minutes" type="number" required min="1" max="10080" step="1" placeholder="例如：180"></label>${field('<span id="cert-style-label">指导或反馈方式</span>','cert-service-style','',500,'')}</section><div class="registration-review-note"><b>审核结果在“我的”查看</b><p>通过后公开认证身份与技能。空闲时间、核验材料仅本人及管理员可见。合作授权另行审核。</p></div>`:
      `<section class="registration-section"><div class="registration-section-heading"><span>01</span><div><h2>当前情况</h2></div></div>${field('职业 / 所处阶段','assessment-position',a?.selfPosition,300,'例如：正在准备转行的设计师')}${field('学习或生活状态','assessment-current',a?.currentSituation,1500,'目前的情况与困难')}</section><section class="registration-section"><div class="registration-section-heading"><span>02</span><div><h2>目标与反馈节奏</h2></div></div>${field('希望推进的目标（可选）','assessment-goal',a?.primaryGoal,500,'例如：提高英语口语能力',false)}<div class="registration-fields"><label class="registration-field">希望开始时间<input id="assessment-start" type="date" required value="${start}"></label><label class="registration-field">每周投入（分钟）<input id="assessment-minutes" type="number" min="0" max="10080" step="1" required value="${a?.availableMinutes??''}" placeholder="例如：180"></label></div>${field('安排与反馈偏好','assessment-rhythm',a?.preferredRhythm,300,'例如：每周五天，每晚一次简短反馈')}${field('可能遇到的阻碍（可选）','assessment-obstacles',a?.obstacles,1000,'例如：加班、作息不规律',false)}${field('希望获得的支持（可选）','assessment-support',a?.supportPreferences,1000,'例如：进度提醒、方法建议',false)}</section><div class="registration-review-note"><p>档案不公开，发起协商时供双方查看。</p></div>`}
      <footer class="registration-submit"><p class="muted" id="intake-status" role="status" hidden></p><p class="err" id="intake-error" role="alert"></p><button class="btn block registration-submit-button" id="intake-submit" type="submit">${supervisor?'提交认证材料':'保存个人档案'} <span aria-hidden="true">↗</span></button></footer></form></section></div>`;
    const draftKey='markly:intake:'+me.id+':'+me.role;
    const draftFields=[...c.querySelectorAll('#intake-form input,#intake-form textarea,#intake-form select')].filter(el=>el.id);
    try{const saved=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(saved)draftFields.forEach(el=>{if(Object.hasOwn(saved,el.id))el.value=saved[el.id];});}catch{}
    const readDraft=()=>Object.fromEntries(draftFields.map(el=>[el.id,el.value]));
    const saveDraft=()=>{if(currentPage())try{sessionStorage.setItem(draftKey,JSON.stringify(readDraft()));}catch{}};
    $('#intake-form').addEventListener('input',saveDraft);$('#intake-form').addEventListener('change',saveDraft);
    $('#intake-back').onclick=()=>goView('my');
    if(supervisor){const sync=()=>{const mentor=$('#cert-direction').value==='mentor';$('#cert-direction-hint').textContent=mentor?'导师：经验分享与方法指导。':'监督者：进度跟进与行动反馈。';$('#cert-strengths-label').textContent=mentor?'你比较擅长什么？有什么可以教给学员？':'你擅长跟进哪些目标？有什么监督经验？';$('#cert-strengths').placeholder=mentor?'擅长领域、相关经验与教学方法':'目标类型、跟进方法与监督经验';$('#cert-style-label').textContent=mentor?'准备怎样指导？每次指导多长时间？':'准备怎样监督？多久查看进度、多久反馈？';$('#cert-service-style').placeholder=mentor?'例如：每周一次 45 分钟交流，结合练习答疑。':'例如：每天核对进度，次日反馈，每周复盘。';};$('#cert-direction').onchange=sync;sync();}

    $('#intake-form').onsubmit=async e=>{
      e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]');
      const currentForm=()=>currentPage()&&form.isConnected&&c.querySelector('#intake-form')===form;
      if(button.disabled||!currentForm())return;
      const submittedDraft=readDraft(),matchesSubmitted=draft=>draft&&Object.keys(submittedDraft).every(key=>draft[key]===submittedDraft[key]);
      form.querySelector('#intake-error').textContent='';
      const status=form.querySelector('#intake-status');status.textContent='';status.hidden=true;
      button.disabled=true;const read=id=>form.querySelector('#'+id).value;
      try{
        if(supervisor)await api('POST','/api/certifications',{title:read('cert-title'),issuer:read('cert-issuer'),evidence:read('cert-evidence'),direction:read('cert-direction'),skills:read('cert-skills'),strengths:read('cert-strengths'),availability:read('cert-availability'),weeklyMinutes:Number(read('cert-weekly-minutes')),serviceStyle:read('cert-service-style')});
        else await api('PUT','/api/assessment/me',{selfPosition:read('assessment-position'),primaryGoal:read('assessment-goal'),currentSituation:read('assessment-current'),desiredStartAt:fromLocalInput(read('assessment-start')+'T00:00'),availableMinutes:Number(read('assessment-minutes')),preferredRhythm:read('assessment-rhythm'),obstacles:read('assessment-obstacles'),supportPreferences:read('assessment-support')});
        if(!currentSession())return;
        try{const latest=JSON.parse(sessionStorage.getItem(draftKey)||'null');if(matchesSubmitted(latest))sessionStorage.removeItem(draftKey);}catch{}
        if(currentForm()){
          if(matchesSubmitted(readDraft())){toast(supervisor?'已提交，等待审核':'个人档案已保存');goView('my');}
          else{const message=supervisor?'认证材料已提交，新的填写仍保留在表单中，尚未提交。':'个人档案已保存，新的填写仍保留在表单中，尚未保存。';status.hidden=false;status.textContent=message;toast(message);}
        }
      }catch(error){if(currentForm())form.querySelector('#intake-error').textContent=error.message;}
      finally{button.disabled=false;}
    };
  }catch(error){if(currentPage()){c.innerHTML=`<div class="registration-page"><section class="registration-sheet"><p>${esc(error.message)}</p><button class="btn" id="intake-retry">重新加载</button><button class="linkbtn" id="intake-back">返回我的</button></section></div>`;$('#intake-retry').onclick=()=>renderIntake(c);$('#intake-back').onclick=()=>goView('my');}}
}

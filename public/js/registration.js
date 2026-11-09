/* 基础申请注册：审核通过后才创建可登录账号。 */
'use strict';
function renderRegistration() {
  document.body.classList.remove('has-tabbar');document.body.dataset.role='guest';
  $app.innerHTML=`<div class="registration-page"><main class="registration-sheet"><form id="registration-form">
    <section class="registration-identities" aria-label="身份选择">${identityCardsHTML('role')}
      <details class="registration-definitions" id="registration-role-help"><summary>身份说明</summary><div>
      <p><b>Mentor · 导师</b><br>分享经验，提供方法指导。</p>
      <p><b>Mentee · 学员</b><br>向导师学习，提升能力。</p>
      <p><b>Supervisor · 监督者</b><br>跟进计划，反馈执行进度。</p>
      <p><b>Supervisee · 被监督者</b><br>设定目标，接受行动督促。</p>
      </div></details>
    </section>
    <section class="registration-section" aria-labelledby="registration-account-title"><div class="registration-section-heading"><span>01</span><div><h2 id="registration-account-title">登录信息</h2></div></div>
      <label class="registration-field">登录账号<input name="username" required minlength="3" maxlength="64" pattern="[a-zA-Z0-9_-]+" autocomplete="username" placeholder="为自己取一个登录账号"><small>3–64 位字母、数字、下划线或短横线</small></label>
      <div class="registration-fields"><label class="registration-field">登录密码<input name="password" required type="password" minlength="8" maxlength="256" autocomplete="new-password" placeholder="至少 8 位"></label><label class="registration-field">确认密码<input name="confirmPassword" required type="password" minlength="8" maxlength="256" autocomplete="new-password" placeholder="再次输入密码"></label></div>
    </section>
    <section class="registration-section" aria-labelledby="registration-about-title"><div class="registration-section-heading"><span>02</span><div><h2 id="registration-about-title">基本资料</h2></div></div>
      <label class="registration-field">昵称<input name="displayName" required maxlength="7" placeholder="希望我们怎么称呼你"><small>1–7 个汉字</small></label>
      <div class="registration-fields"><label class="registration-field">年龄<input name="age" type="number" required min="1" max="120" step="1" inputmode="numeric" placeholder="你的周岁"></label><label class="registration-field">性别<select name="gender" required><option value="" selected disabled>请选择</option><option value="male">男</option><option value="female">女</option><option value="unspecified">暂不透露</option></select></label></div>
      <label class="registration-field">联系方式<input name="contact" required maxlength="120" placeholder="手机号、邮箱或微信，任选一种"></label>
    </section>
    <footer class="registration-submit"><div class="registration-review-note"><b>提交后等待平台审核</b><p>导师、监督者开通后需完成认证与合作审核。</p></div>
      <details class="registration-privacy"><summary>资料使用与隐私</summary><p>账号用于登录，年龄用于审核，性别用于个人资料。联系方式仅管理员可见，用于审核和联系。请勿填写无关敏感信息。</p></details>
      <label class="registration-consent"><input name="consent" type="checkbox" required><span>我已了解并同意上述资料收集用途</span></label><p class="err" id="registration-error" role="alert"></p>
      <button class="btn block registration-submit-button" type="submit">提交申请 <span aria-hidden="true">↗</span></button><p class="registration-submit-hint">提交后请保存查询凭证。</p>
    </footer></form><nav class="registration-footer" aria-label="申请辅助入口"><button class="linkbtn" id="registration-back">已有账号？返回登录</button><button class="linkbtn" id="registration-query">查询申请进度 →</button></nav></main></div>`;
  $('#registration-back').onclick=renderLogin;$('#registration-query').onclick=()=>renderRegistrationStatus();
  wireIdentityCards($('#registration-form'),'role');
  $('#registration-form').onsubmit=async e=>{
    e.preventDefault();const form=e.currentTarget,button=form.querySelector('[type="submit"]');if(button.disabled)return;
    const data=Object.fromEntries(new FormData(form));$('#registration-error').textContent='';
    if(data.password!==data.confirmPassword){$('#registration-error').textContent='两次密码不一致';return;}
    delete data.confirmPassword;data.age=Number(data.age);data.consent=form.elements.consent.checked;button.disabled=true;
    try{const result=await api('POST','/api/auth/register',data);renderRegistrationStatus(result.receiptToken,true);}
    catch(error){if(form.isConnected)$('#registration-error').textContent=error.message;}
    finally{button.disabled=false;}
  };
}
function renderRegistrationStatus(receiptToken='',submitted=false){
  $app.innerHTML=`<div class="authwrap"><section class="authcard card"><h1>${submitted?'申请已提交':'查询申请进度'}</h1><p>${submitted?'请保存查询凭证。审核通过后使用申请账号登录。':'输入查询凭证查看审核结果。'}</p><form id="registration-status-form"><label>查询凭证<input id="registration-receipt" required maxlength="64" value="${esc(receiptToken)}" autocomplete="off"></label><button class="btn block">查询审核结果</button></form><div id="registration-status-result" role="status"></div><button class="linkbtn" id="registration-login">返回登录</button><button class="linkbtn" id="registration-new">填写申请</button></section></div>`;
  $('#registration-login').onclick=renderLogin;$('#registration-new').onclick=renderRegistration;
  $('#registration-status-form').onsubmit=async e=>{e.preventDefault();const button=e.currentTarget.querySelector('button'),box=$('#registration-status-result');if(button.disabled)return;button.disabled=true;try{const {application:a}=await api('POST','/api/auth/registration-status',{receiptToken:$('#registration-receipt').value.trim()});box.innerHTML=`<h2>${({pending:'等待平台审核',approved:'已通过，可以登录',rejected:'未通过，请按说明重新申请'})[a.status]}</h2><p>账号：${esc(a.username)}</p>${a.reviewNote?`<p>${esc(a.reviewNote)}</p>`:''}`;}catch(error){box.textContent=error.message;}finally{button.disabled=false;}};
}
async function renderRegistrations(c,offset=0){
  const status=st.registrationStatus||'pending';c.innerHTML='<h1>注册申请</h1><p>正在读取申请…</p>';
  try{const r=await api('GET',`/api/admin/registrations?status=${status}&offset=${offset}`);if(!c.isConnected||st.view!=='registrations')return;
    c.innerHTML=`<h1>注册申请</h1><div class="row">${['pending','approved','rejected'].map(k=>`<button class="btn ${status===k?'':'soft'}" data-registration-status="${k}">${({pending:'待审核',approved:'已开通',rejected:'未通过'})[k]}</button>`).join('')}<button class="btn soft" id="registration-refresh">刷新</button></div>${r.list.map(a=>`<section class="card work-section"><h2>${esc(a.displayName)} · ${esc(roleLabel(a.role,a.identity))}</h2><p>@${esc(a.username)} · 提交于 ${fmtTime(a.createdAt)}</p><p><b>申请时年龄：</b>${a.age==null?'未填写（历史申请）':esc(a.age)+'岁'} · <b>性别：</b>${({male:'男',female:'女',unspecified:'暂不透露 / 未填写'})[a.gender]||'未填写'}</p><p><b>联系方式：</b>${esc(a.contact)}</p>${a.background||a.expectation?`<h3>补充资料（历史申请）</h3><p class="prewrap">${esc(a.background)}</p><p class="prewrap">${esc(a.expectation)}</p>`:''}<p>${esc(a.reviewNote)}</p>${a.status==='pending'?`<button class="btn" data-registration-review="${a.id}">审核开通</button>`:a.userId?'<button class="btn soft" data-registration-users>前往用户管理</button>':''}</section>`).join('')||'<div class="card empty">暂无该状态的申请</div>'}<div class="row"><button class="btn soft" id="registration-prev" ${offset?'':'disabled'}>上一页</button><button class="btn soft" id="registration-next" ${r.nextOffset===null?'disabled':''}>下一页</button></div>`;
    c.querySelectorAll('[data-registration-status]').forEach(b=>b.onclick=()=>{st.registrationStatus=b.dataset.registrationStatus;renderRegistrations(c);});
    $('#registration-refresh').onclick=()=>renderRegistrations(c,offset);$('#registration-prev').onclick=()=>renderRegistrations(c,Math.max(0,offset-50));$('#registration-next').onclick=()=>renderRegistrations(c,r.nextOffset);
    c.querySelectorAll('[data-registration-users]').forEach(b=>b.onclick=()=>goView('users'));
    c.querySelectorAll('[data-registration-review]').forEach(b=>b.onclick=()=>openModal('审核注册申请',`<label>结果<select id="registration-decision"><option value="approved">通过并开通账号</option><option value="rejected">不通过</option></select></label><label>审核说明（申请人可查询）<textarea id="registration-note" maxlength="500" required></textarea></label>`,async()=>{await api('PUT','/api/admin/registrations/'+b.dataset.registrationReview,{status:$('#registration-decision').value,reviewNote:$('#registration-note').value});closeModal();renderRegistrations(c,offset);toast('审核结果已保存');}));
  }catch(error){if(c.isConnected)c.innerHTML=`<p>${esc(error.message)}</p><button class="btn" onclick="renderRegistrations(document.getElementById('content'))">重新加载</button>`;}
}

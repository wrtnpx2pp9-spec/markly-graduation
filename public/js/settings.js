/* Markly · 设置组件 */
'use strict';

// ---------- 设置 ----------
function renderSettings(c) {
  c.innerHTML = `
  <button class="page-back" id="settings-back">← 返回我的</button>
  <h1>提醒设置</h1>

  <div class="card" style="margin-bottom:16px">
    <h2>账号</h2>
    <div class="row">
      <span class="roletag">${esc(roleLabel(me.role,me.identity))}</span>
      <span class="uname">${esc(me.displayName)}</span>
      <span class="muted">@${esc(me.username)}</span>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px" id="wx-bind-card">
    <div class="empty">微信提醒状态加载中…</div>
  </div>

  <div class="card">
    <h2>外部通知转发</h2>
    <label class="form-check"><input type="checkbox" id="cfg-enabled" ${st.cfg.enabled ? 'checked' : ''} /> 启用转发</label>
    <label>Webhook 地址</label>
    <input id="cfg-url" value="${esc(st.cfg.webhookUrl || '')}" placeholder="https://你的程序/notify，可留空" />
    <label>本地程序（选填）</label>
    <input id="cfg-cmd" value="${esc(st.cfg.command || '')}" placeholder="C:\\notifier\\send.exe，可留空" />
    <div class="dlg-actions" style="margin-top:16px">
      <button class="btn sm" id="cfg-save">保存</button>
    </div>
  </div>`;

  async function saveCfg() {
    const cfg = {
      enabled: $('#cfg-enabled').checked,
      webhookUrl: $('#cfg-url').value.trim(),
      command: $('#cfg-cmd').value.trim(),
    };
    await api('PUT', '/api/notifyconfig', cfg);
    st.cfg = cfg;
    return cfg;
  }
  $('#cfg-save').onclick = async () => {
    try { await saveCfg(); toast('已保存'); } catch (e) { toast(e.message); }
  };
  if(me.role!=='admin')$('#cfg-save')?.closest('.card')?.remove();
  $('#settings-back').onclick = () => goView('my');
  loadWxBindCard();
}

// ---------- 微信提醒（iLink）：把自己的微信绑定到本账号 ----------
let wxBindLoadSerial=0;
async function loadWxBindCard() {
  const box = $('#wx-bind-card');
  if (!box) return null;
  const serial=++wxBindLoadSerial,session=token;
  const current=()=>serial===wxBindLoadSerial&&session===token&&box.isConnected&&$('#wx-bind-card')===box;
  let d;
  try { d = await api('GET', '/api/wechat/bind'); }
  catch (e) {
    if(!current())return null;
    box.innerHTML = '<h2>微信提醒</h2><div class="err">' + esc(e.message) + '</div><button class="btn sm soft" id="wx-retry">重试读取状态</button>';
    box.querySelector('#wx-retry').onclick=()=>loadWxBindCard();
    return false;
  }
  if(!current())return null;
  const bound = d.bound;
  const mock = !!d.mock;
  const instance = d.instance || {};
  const modeTag = mock ? '<span class="roletag" style="margin-left:8px">本地模拟</span>' : '';

  let body;
  if (bound && instance.connectionState === 'authenticated') {
    const dg = (d.deliveries || []).slice(0, 6);
    body = `
      <p class="muted" style="font-size:13px">微信账号 <b>${esc(d.binding.wxidMasked || '')}</b></p>
      ${d.enabled ? '' : '<div class="err" style="margin:6px 0">微信推送暂未启用，请联系管理员。</div>'}
      <div class="dlg-actions" style="margin-top:10px">
        <button class="btn sm" id="wx-test">发送测试消息</button>
        <button class="btn sm soft" id="wx-unbind">解除绑定</button>
      </div>
      ${dg.length ? `<div style="margin-top:10px;font-size:12px"><div class="muted">最近收发</div>${dg.map((l) => `
        <div style="padding:3px 0;border-bottom:1px dashed #eee"><span style="opacity:.75">${l.direction === 'in' ? '📥' : '📤'}</span> ${esc(l.text)}
          ${l.status === 'sent' ? '' : `<span class="tag off">${esc(l.status)}</span>`}
          <span style="opacity:.5;float:right">${fmtTime(l.createdAt)}</span></div>`).join('')}</div>` : ''}`;
  } else {
    body = `
      <p class="muted" style="font-size:13px">用微信扫码后，向该账号发送数字 <b>1</b> 完成绑定。</p>
      ${instance.hasQrcode && instance.qrcodeSvg ? `<div style="text-align:center">${instance.qrcodeSvg}<div class="muted">二维码约 ${Math.ceil((instance.qrcodeExpiresInSec || 0) / 60)} 分钟内有效</div></div>` : ''}
      ${instance.connectionState === 'awaiting_message' ? '<div class="ok">扫码已确认。现在请在微信中向该机器人发送数字 1。</div>' : ''}
      <div class="dlg-actions" style="margin-top:10px">
        <button class="btn sm" id="wx-start">${instance.hasQrcode ? '重新生成二维码' : '生成绑定二维码'}</button>
        ${mock && instance.hasQrcode ? '<button class="btn sm soft" id="wx-mock-confirm">模拟扫码确认</button>' : ''}
        ${mock && instance.connectionState === 'awaiting_message' ? '<button class="btn sm" id="wx-sim-one">模拟发送 1</button>' : ''}
        <button class="btn sm soft" id="wx-refresh">刷新状态</button>
      </div>`;
  }
  box.innerHTML = `<h2>微信提醒 ${modeTag}${bound ? '<span class="tag on" style="margin-left:6px">已绑定</span>' : ''}</h2>${body}`;

  let busy=false;
  const run=async(button,method,path,body,success='',refresh=true)=>{
    if(busy||button.disabled||!current())return;
    busy=true;
    const buttons=[...box.querySelectorAll('button')],label=button.textContent;
    buttons.forEach(control=>{control.disabled=true;});button.textContent='处理中…';
    try{
      const result=await api(method,path,body);
      if(!current())return;
      const loaded=refresh?await loadWxBindCard():true;
      if(session!==token||!box.isConnected||$('#wx-bind-card')!==box)return;
      if(loaded===false)toast((success||'操作已完成')+'，状态暂时无法刷新；请重试读取状态。');
      else if(loaded===true&&(success||!refresh))toast(success||result.message||'已发送');
    }catch(e){if(current())toast(e.message);}
    finally{busy=false;buttons.forEach(control=>{control.disabled=false;});button.textContent=label;}
  };
  const start = box.querySelector('#wx-start');
  if(start)start.onclick=()=>run(start,'POST','/api/wechat/bind/start',{force:true});
  const mockConfirm = box.querySelector('#wx-mock-confirm');
  if(mockConfirm)mockConfirm.onclick=()=>run(mockConfirm,'POST','/api/wechat/bind/mock/confirm',{});
  const simOne = box.querySelector('#wx-sim-one');
  if(simOne)simOne.onclick=()=>run(simOne,'POST','/api/wechat/bind/simulate',{text:'1'},'已完成独立微信绑定');
  const ref = box.querySelector('#wx-refresh');
  if(ref)ref.onclick=()=>run(ref,'POST','/api/wechat/bind/refresh',{});
  const test = box.querySelector('#wx-test');
  if(test)test.onclick=()=>run(test,'POST','/api/wechat/bind/test',undefined,'',false);
  const unbind = box.querySelector('#wx-unbind');
  if (unbind) unbind.onclick = async () => {
    if(busy||unbind.disabled||!current())return;
    if (!confirm('解除微信绑定后，本账号的提醒将不再推送到微信。确认解除？')) return;
    await run(unbind,'DELETE','/api/wechat/bind',undefined,'已解除绑定');
  };
  return true;
}

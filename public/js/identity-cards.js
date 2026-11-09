/* Shared, keyboard-accessible identity cards. Illustrations are local SVG line art. */
'use strict';
const IDENTITY_CARDS = [
  {key:'mentor',name:'Mentor',label:'导师',caption:'伸手引领 · 共同成长',detail:'分享经验、讲解方法，帮助学员建立方向与独立判断。',art:'M43 22 C46 32 32 37 28 27 C24 17 39 12 43 22 Z M37 34 Q43 45 38 59 M38 40 L25 48 L22 58 M41 40 Q48 43 56 50 M55 48 Q60 47 61 51 Q60 55 56 53 M38 59 L27 77 L18 78 M38 59 L47 76 L53 77 M83 48 C91 49 92 61 83 63 C73 65 70 53 78 49 Q80 48 83 48 Z M80 64 Q77 73 73 80 M78 66 L68 62 L59 53 M78 68 L91 74 L97 68 M73 80 L64 94 L57 95 M74 81 L86 92 L94 93 M12 82 L54 82 L54 99 L100 99'},
  {key:'mentee',name:'Mentee',label:'学员',caption:'抬头求知 · 向前一步',detail:'主动提问、尝试方法，在实践与复盘中逐渐独立解决问题。',art:'M74 44 C79 54 66 62 60 53 C54 43 68 34 74 44 Z M60 47 L57 45 M66 60 Q63 70 61 77 M64 62 L49 57 L37 43 M35 42 L33 38 L29 41 L32 46 M66 65 L80 74 L85 68 M61 77 L52 92 L45 94 M61 78 L75 91 L83 92 M9 25 L22 33 L32 41 M20 32 L27 31 M39 99 L88 98'},
  {key:'supervisor',name:'Supervisor',label:'监督者',caption:'守住约定 · 跟进落实',detail:'依据共同约定提醒行动、核对进度，推动偏差调整与计划落实。',art:'M47 24 C48 35 32 37 30 26 C28 14 45 13 47 24 Z M39 36 Q37 51 41 65 M38 43 L24 55 L28 66 M40 42 L58 47 L70 36 M68 38 L77 24 M71 39 L80 25 M79 25 Q98 31 89 50 Q77 68 92 77 Q98 80 96 85 M41 65 L29 88 L22 90 M42 65 L56 86 L64 88 M22 95 L67 94'},
  {key:'supervisee',name:'Supervisee',label:'被监督者',caption:'迈出一步 · 坚持行动',detail:'参与制定目标、如实记录进展，借助外部督促保持行动。',art:'M91 50 C97 60 83 69 77 59 C71 50 85 42 91 50 Z M77 59 Q61 58 47 47 Q35 40 27 45 Q21 49 27 56 L40 62 M28 55 L38 71 L29 88 L22 90 M41 58 L53 73 L51 88 L59 90 M72 59 L68 75 L79 83 M69 61 L58 74 L64 81 M27 48 L40 56 M19 95 L83 94'}
];
function identityCardsHTML(name, selected='supervisee') {
  return `<fieldset class="identity-picker"><legend>选择你的身份</legend><div class="identity-card-grid">${IDENTITY_CARDS.map((item,i)=>`<label class="identity-option"><input type="radio" name="${esc(name)}" value="${item.key}" ${selected===item.key?'checked':''} required><span class="identity-paper"><span class="identity-number" aria-hidden="true">0${i+1}</span><span class="identity-tick" aria-hidden="true">✓</span><svg class="identity-sketch" viewBox="0 0 110 105" fill="none" aria-hidden="true"><path class="pencil-echo" d="${item.art}" transform="translate(1.1 .7)"/><path class="pencil-main" pathLength="1" d="${item.art}"/><path class="pencil-shade" d="M26 95 L35 92 M34 96 L44 92 M45 96 L55 92 M55 96 L65 92 M65 95 L75 92"/></svg><strong>${item.name}</strong><span class="identity-cn">${item.label}</span></span></label>`).join('')}</div></fieldset>`;
}
function wireIdentityCards(container, name, onChange) {
  container.querySelectorAll(`input[name="${name}"]`).forEach(input=>input.addEventListener('change',()=>{
    if(onChange)onChange(input.value);
  }));
}

/* Shared date picker; native date values and input/change events remain intact. */
(()=>{
 let panel=null,field=null,month=null;
 const iso=d=>[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
 function close(focus=false){panel?.remove();panel=null;if(field){field.setAttribute('aria-expanded','false');if(focus&&field.isConnected)field.focus();}field=null;}
 function choose(value){const input=field;close();if(!input?.isConnected)return;input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));if(input.isConnected)input.focus();}
 function draw(){
 const y=month.getFullYear(),m=month.getMonth(),count=new Date(y,m+1,0).getDate(),offset=(new Date(y,m,1).getDay()+6)%7;
 panel.innerHTML='<div class="date-head"><button type="button" data-month="-1" aria-label="上个月">‹</button><b>'+y+' 年 '+(m+1)+' 月</b><button type="button" data-month="1" aria-label="下个月">›</button></div><div class="date-grid">'+['一','二','三','四','五','六','日'].map(d=>'<span>'+d+'</span>').join('')+Array(offset).fill('<span></span>').join('')+Array.from({length:count},(_,i)=>{const value=iso(new Date(y,m,i+1)),disabled=(field.min&&value<field.min)||(field.max&&value>field.max);return '<button type="button" data-date="'+value+'" aria-label="'+value+'" aria-pressed="'+(field.value===value)+'" '+(disabled?'disabled':'')+'>'+(i+1)+'</button>';}).join('')+'</div><div class="date-foot"><button type="button" data-clear>清空</button><button type="button" data-today>今天</button><button type="button" data-close>关闭</button></div>';
 panel.querySelectorAll('[data-month]').forEach(b=>b.onclick=()=>{month=new Date(y,m+Number(b.dataset.month),1);draw();panel.querySelector('[data-month="'+b.dataset.month+'"]').focus();});
 panel.querySelectorAll('[data-date]').forEach(b=>b.onclick=()=>choose(b.dataset.date));
 panel.querySelector('[data-clear]').onclick=()=>choose('');
 const today=todayStr(),todayButton=panel.querySelector('[data-today]');todayButton.disabled=!!((field.min&&today<field.min)||(field.max&&today>field.max));todayButton.onclick=()=>choose(today);
 panel.querySelector('[data-close]').onclick=()=>close(true);
 }
 function open(input){close();field=input;month=new Date((input.value||todayStr())+'T12:00:00');month=new Date(month.getFullYear(),month.getMonth(),1);panel=document.createElement('section');panel.className='clear-date-picker';panel.setAttribute('role','dialog');panel.setAttribute('aria-label','选择日期');input.setAttribute('aria-expanded','true');(input.closest('.dialog')||document.body).append(panel);draw();const r=input.getBoundingClientRect(),w=panel.offsetWidth,h=panel.offsetHeight;panel.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';panel.style.top=Math.max(8,Math.min(r.bottom+6,innerHeight-h-8))+'px';panel.querySelector('[aria-pressed="true"], [data-date]:not(:disabled)')?.focus();}
 document.addEventListener('click',e=>{const input=e.target.closest('input[type="date"]');if(input&&!input.disabled&&!input.readOnly){e.preventDefault();open(input);}else if(panel&&!panel.contains(e.target))close();},true);
 document.addEventListener('keydown',e=>{if(panel&&e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close(true);}else if(e.target.matches('input[type="date"]')&&e.altKey&&e.key==='ArrowDown'){e.preventDefault();open(e.target);}},true);
 window.addEventListener('resize',()=>close());
})();

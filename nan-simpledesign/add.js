
;(()=>{const closeMenu=()=>{nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.textContent='選單 ＋';document.documentElement.classList.remove('menu-open')};
menu.addEventListener('click',()=>document.documentElement.classList.toggle('menu-open',nav.classList.contains('open')));
nav.querySelector('.nav-close')?.addEventListener('click',closeMenu);
nav.addEventListener('click',e=>{if(e.target.closest('a'))document.documentElement.classList.remove('menu-open')});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&nav.classList.contains('open'))closeMenu()});
window.addEventListener('resize',()=>{if(innerWidth>600&&nav.classList.contains('open'))closeMenu()});})();

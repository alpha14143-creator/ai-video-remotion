const menu=document.querySelector('.menu'),nav=document.querySelector('#nav');
menu.addEventListener('click',()=>{const open=menu.getAttribute('aria-expanded')!=='true';menu.setAttribute('aria-expanded',String(open));nav.classList.toggle('open',open);menu.textContent=open?'關閉 ✕':'選單 ＋';});
nav.addEventListener('click',e=>{if(e.target.closest('a')){nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.textContent='選單 ＋'}});
const projects={entry:{title:'留白之間',image:'assets/entry.webp',description:'以白木紋、圓弧線條與石紋地坪，呈現玄關收納的空間想像。櫃體下方保留掃地機器人的位置，讓日常使用與整體視覺一起被考慮。本圖為 3D 渲染提案，非完工實景；實際材質、尺寸與設備需求依個案確認。'},plan:{title:'生活的全貌',image:'assets/plan.webp',description:'透過雙層住宅的立體配置渲染，理解房間、公共空間與樓層動線之間的關係。把平面資訊轉成更直觀的空間畫面，協助需求討論。本圖為 3D 渲染提案，非完工實景；正式圖面與配置依個案尺寸及條件確認。'}};
const dialog=document.querySelector('#project-dialog');
document.querySelectorAll('[data-project]').forEach(button=>button.addEventListener('click',()=>{const p=projects[button.dataset.project];document.querySelector('#project-image').src=p.image;document.querySelector('#project-image').alt=p.title+' 3D 渲染提案';document.querySelector('#project-title').textContent=p.title;document.querySelector('#project-description').textContent=p.description;dialog.showModal();}));
document.querySelector('.close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
document.querySelector('#project-contact').addEventListener('click',()=>{setInquiryProjectReference(currentProject?.title||document.querySelector('#project-title').textContent);dialog.close();});
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function loadContent(){try{const r=await fetch('/api/content');if(!r.ok)throw Error();const c=await r.json();renderServices(c.services);renderProcess(c.process);renderHero(c.hero);renderContact(c.contact);renderHeader(c.branding,c.navigation);document.querySelector('#home-title').innerText=c.homeTitle;document.querySelector('.work-grid').innerHTML=c.projects.map((p,i)=>`<button class="work" data-id="${esc(p.id)}"><div class="work-image"><img src="${esc(p.thumbnail||p.image)}" alt="${esc(p.title)}" loading="lazy" decoding="async"><span class="round-arrow">↗</span></div><div class="work-meta"><h3>${esc(p.title)}</h3><span>${String(i+1).padStart(2,'0')}</span></div><p>${esc(p.style||p.category)}</p></button>`).join('');document.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{const p=c.projects.find(p=>p.id===b.dataset.id);openProject(p)});document.querySelector('#articles').innerHTML=c.articles.map((a,i)=>`<article><p class="eyebrow">0${i+1} / ${esc(a.tag)}</p><h3>${esc(a.title)}</h3><p>${esc(a.body)}</p></article>`).join('')}catch{document.querySelector('#articles').textContent='內容暫時無法載入，請稍後重新整理。'}}loadContent();
document.querySelector('#inquiry-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button'),status=document.querySelector('#form-status');button.disabled=true;status.textContent='正在送出…';try{const get=id=>document.getElementById(id).value.trim();const r=await fetch('/api/inquiries',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:get('client-name'),contact:get('client-contact'),service:get('service'),location:get('location'),area:get('area'),needs:get('needs')})});if(!r.ok)throw Error();status.textContent='已收到你的諮詢需求！我們會依留下的聯絡方式與你聯繫。';e.target.reset()}catch{status.textContent='送出未完成，請再試一次，或使用頁面上的聯絡方式。'}finally{button.disabled=false}});
document.querySelector('#year').textContent=new Date().getFullYear();

function safeExternalUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:''}catch{return ''}}
function safeQrImage(value){return typeof value==='string'&&/^\/(assets|media)\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(value)?value:''}
function renderContact(settings){const c=settings||{instagramUrl:'https://www.instagram.com/nan_simpledesign/'};for(const [id,key] of [['social-instagram','instagramUrl'],['social-facebook','facebookUrl']]){const a=document.getElementById(id),url=safeExternalUrl(c[key]);a.hidden=!url;if(url)a.href=url;else a.removeAttribute('href')}
const url=safeExternalUrl(c.lineUrl),qr=safeQrImage(c.lineQrImage),wrap=document.getElementById('line-contact'),qrLink=document.getElementById('line-qr-link'),linked=document.getElementById('line-qr'),plain=document.getElementById('line-qr-static'),add=document.getElementById('line-add');wrap.hidden=!(url||qr);qrLink.hidden=!(url&&qr);linked.hidden=!(url&&qr);plain.hidden=!(qr&&!url);add.hidden=!url;document.getElementById('line-scan').hidden=!qr;if(url){qrLink.href=url;add.href=url}if(qr){linked.src=qr;plain.src=qr}}

function menuUrl(value){if(typeof value==='string'&&/^#[a-zA-Z0-9_-]*$/.test(value))return value;return safeExternalUrl(value)}
function renderHeader(branding,navigation){const logo=document.getElementById('header-logo'),brand=document.getElementById('header-brand'),url=safeQrImage(branding?.logoImage),width=Number(branding?.logoWidth)||160;logo.hidden=!url;brand.classList.toggle('has-logo',!!url);if(url){logo.src=url;logo.style.width=Math.max(80,Math.min(600,width))+'px'}else logo.removeAttribute('src');
document.getElementById('site-header').classList.toggle('large-logo',!!url&&width>300);if(!Array.isArray(navigation))return;
const items=navigation.filter(n=>n.label&&(n.kind==='topic'||menuUrl(n.url)));document.getElementById('site-header').classList.toggle('extended-menu',items.length>8);(nav.querySelector('.nav-links')||nav).innerHTML=items.map(n=>{const href=n.kind==='topic'?'#topic-'+n.id:menuUrl(n.url);return `<a href="${esc(href)}"${n.emphasis?' class="nav-contact"':''}${n.newTab&&n.kind!=='topic'&&!href.startsWith('#')?' target="_blank" rel="noopener noreferrer"':''}>${esc(n.label)}</a>`}).join('');
document.getElementById('custom-topics').innerHTML=items.filter(n=>n.kind==='topic').map(n=>`<section id="topic-${esc(n.id)}" class="section custom-topic"><p class="eyebrow">NAN SIMPLE DESIGN / 主題專案</p><h2>${esc(n.label)}</h2>${safeQrImage(n.image)?`<img src="${esc(n.image)}" alt="${esc(n.label)}" loading="lazy">`:''}<p class="topic-body">${esc(n.body)}</p><a class="text-link" href="#contact">討論這個主題 ↗</a></section>`).join('');
if(location.hash.startsWith('#topic-'))requestAnimationFrame(()=>document.getElementById(location.hash.slice(1))?.scrollIntoView());}

let currentProject=null,currentPhoto=0,touchStart=null;
function projectPhotos(p){return [...new Set([p.image,...(Array.isArray(p.images)?p.images:[])])].filter(safeQrImage)}
function openProject(p){
 currentProject=p;currentPhoto=0;const photos=projectPhotos(p);
 document.querySelector('#project-title').textContent=p.title;
 document.querySelector('#project-description').textContent=p.description||'';
 document.querySelector('#project-description').hidden=!p.description;
 let details=document.getElementById('project-details');
 if(!details){details=document.createElement('dl');details.id='project-details';document.querySelector('#project-description').before(details)}
 details.innerHTML=[['spaceInfo','空間基本資料'],['caseType','案件類型'],['residents','居住成員'],['style','風格'],['budget','裝修大約金額']].filter(([k])=>typeof p[k]==='string'&&p[k].trim()).map(([k,label])=>'<div><dt>'+label+'</dt><dd>'+esc(p[k])+'</dd></div>').join('');
 details.hidden=!details.children.length;

 dialog.querySelector('.eyebrow').textContent=p.category||'空間作品';
 let controls=document.getElementById('gallery-controls');
 if(!controls){controls=document.createElement('div');controls.id='gallery-controls';controls.innerHTML='<button id="gallery-prev" aria-label="上一張照片">← 上一張</button><span id="gallery-count" aria-live="polite"></span><button id="gallery-next" aria-label="下一張照片">下一張 →</button>';document.querySelector('#project-image').after(controls);const thumbs=document.createElement('div');thumbs.id='gallery-thumbs';thumbs.setAttribute('aria-label','選擇作品照片');controls.after(thumbs);document.getElementById('gallery-prev').onclick=()=>showPhoto(currentPhoto-1);document.getElementById('gallery-next').onclick=()=>showPhoto(currentPhoto+1)}
 controls.hidden=photos.length<2;
 const strip=document.getElementById('gallery-thumbs');
 strip.innerHTML=photos.map((src,i)=>{const original=(p.images||[]).indexOf(src),thumb=p.thumbnails?.[original]||src;return '<button data-photo="'+i+'" aria-label="觀看第 '+(i+1)+' 張照片"><img src="'+esc(thumb)+'" alt="" loading="lazy" decoding="async"></button>'}).join('');
 strip.hidden=photos.length<2;strip.querySelectorAll('button').forEach(b=>b.onclick=()=>showPhoto(Number(b.dataset.photo)));
 showPhoto(0);dialog.showModal();dialog.scrollTop=0;strip.scrollLeft=0;
}
function showPhoto(i){if(!currentProject)return;const photos=projectPhotos(currentProject);currentPhoto=(i+photos.length)%photos.length;const image=document.querySelector('#project-image');image.src=photos[currentPhoto];image.alt=currentProject.title+'｜第 '+(currentPhoto+1)+' 張，共 '+photos.length+' 張';document.getElementById('gallery-count').textContent=(currentPhoto+1)+' / '+photos.length;document.querySelectorAll('[data-photo]').forEach(b=>b.setAttribute('aria-current',String(Number(b.dataset.photo)===currentPhoto)));if(!document.getElementById('photo-lightbox')?.open)document.querySelector('[data-photo="'+currentPhoto+'"]')?.scrollIntoView({block:'nearest',inline:'nearest'});}
dialog.addEventListener('keydown',e=>{if(!currentProject||!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();showPhoto(currentPhoto+(e.key==='ArrowRight'?1:-1))});
document.querySelector('#project-image').addEventListener('touchstart',e=>{touchStart=[e.changedTouches[0].clientX,e.changedTouches[0].clientY]},{passive:true});
document.querySelector('#project-image').addEventListener('touchend',e=>{if(!touchStart)return;const dx=e.changedTouches[0].clientX-touchStart[0],dy=e.changedTouches[0].clientY-touchStart[1];if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.5)showPhoto(currentPhoto+(dx<0?1:-1));touchStart=null},{passive:true});

function renderHero(settings){const h=settings||{"visible": true, "image": "/assets/entry.webp", "title": "留白之間", "caption": "玄關收納 · 3D 渲染", "alt": "白木紋收納櫃搭配圓弧門片、石紋地坪的玄關空間渲染"},figure=document.querySelector('.hero-image');figure.hidden=h.visible===false;if(figure.hidden)return;const img=figure.querySelector('img');img.src=safeQrImage(h.image)||'/assets/entry.webp';img.alt=h.alt||h.title||'日常所空間設計';const labels=figure.querySelectorAll('figcaption span');labels[0].textContent=h.title?'01 / '+h.title:'';labels[1].textContent=h.caption||'';figure.querySelector('figcaption').hidden=!(h.title||h.caption);}


let inquiryReferenceLine='';
function setInquiryProjectReference(title){
 const field=document.getElementById('needs'),line='參考專案：'+String(title||'').replace(/[\r\n]+/g,' ').trim();
 if(!title)return;
 let body=field.value;
 if(inquiryReferenceLine&&body===inquiryReferenceLine)body='';
 else if(inquiryReferenceLine&&body.startsWith(inquiryReferenceLine+'\n\n'))body=body.slice(inquiryReferenceLine.length+2);
 inquiryReferenceLine=line;
 field.value=line+(body?'\n\n'+body:'');
 validateInquiryLength();
}
function validateInquiryLength(){const field=document.getElementById('needs');field.setCustomValidity(field.value.length>field.maxLength?'包含參考專案後，需求文字超過 2000 字，請稍微縮短內容。':'');}
document.getElementById('needs').addEventListener('input',validateInquiryLength);
document.getElementById('inquiry-form').addEventListener('reset',()=>{inquiryReferenceLine='';document.getElementById('needs').setCustomValidity('');});

const backToTop=document.getElementById('back-to-top');
function updateBackToTop(){backToTop.hidden=window.scrollY<300;}
window.addEventListener('scroll',updateBackToTop,{passive:true});
window.addEventListener('pageshow',updateBackToTop);
backToTop.addEventListener('click',()=>{document.getElementById('header-brand').focus({preventScroll:true});window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
updateBackToTop();


const photoLightbox=document.getElementById('photo-lightbox'),lightboxImage=document.getElementById('lightbox-image'),lightboxStage=document.getElementById('lightbox-stage'),projectMainImage=document.getElementById('project-image');
let lightboxScale=1;
projectMainImage.tabIndex=0;projectMainImage.setAttribute('role','button');projectMainImage.setAttribute('aria-label','放大檢視專案照片');projectMainImage.title='點擊照片放大檢視';
function fitLightboxImage(){stopLightboxDrag();if(!lightboxImage.naturalWidth)return;const w=Math.max(1,lightboxStage.clientWidth-32),h=Math.max(1,lightboxStage.clientHeight-32),fit=Math.min(w/lightboxImage.naturalWidth,h/lightboxImage.naturalHeight,1);lightboxImage.style.width=Math.round(lightboxImage.naturalWidth*fit*lightboxScale)+'px';lightboxImage.style.height=Math.round(lightboxImage.naturalHeight*fit*lightboxScale)+'px';document.getElementById('lightbox-zoom').textContent=Math.round(lightboxScale*100)+'%';document.getElementById('lightbox-minus').disabled=lightboxScale<=1;document.getElementById('lightbox-plus').disabled=lightboxScale>=3;}
function loadLightboxPhoto(){lightboxScale=1;const photos=projectPhotos(currentProject);lightboxImage.src=photos[currentPhoto];lightboxImage.alt=currentProject.title+'｜第 '+(currentPhoto+1)+' 張';document.getElementById('lightbox-name').textContent=currentProject.title;document.getElementById('lightbox-count').textContent=(currentPhoto+1)+' / '+photos.length;for(const id of ['lightbox-prev','lightbox-next'])document.getElementById(id).disabled=photos.length<2;fitLightboxImage();lightboxStage.scrollTo(0,0);}
function openPhotoLightbox(){if(!currentProject)return;photoLightbox.showModal();loadLightboxPhoto();}
function changeLightboxPhoto(step){if(!currentProject)return;showPhoto(currentPhoto+step);loadLightboxPhoto();}
function zoomLightbox(step){lightboxScale=Math.max(1,Math.min(3,lightboxScale+step));fitLightboxImage();}
projectMainImage.addEventListener('click',openPhotoLightbox);
projectMainImage.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPhotoLightbox();}});
lightboxImage.addEventListener('load',()=>{fitLightboxImage();lightboxStage.scrollTo(0,0);});
document.getElementById('lightbox-close').onclick=()=>photoLightbox.close();
document.getElementById('lightbox-prev').onclick=()=>changeLightboxPhoto(-1);
document.getElementById('lightbox-next').onclick=()=>changeLightboxPhoto(1);
document.getElementById('lightbox-minus').onclick=()=>zoomLightbox(-.5);
document.getElementById('lightbox-plus').onclick=()=>zoomLightbox(.5);
document.getElementById('lightbox-reset').onclick=()=>{lightboxScale=1;fitLightboxImage();lightboxStage.scrollTo(0,0);};
photoLightbox.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();e.stopPropagation();changeLightboxPhoto(e.key==='ArrowRight'?1:-1);}});
photoLightbox.addEventListener('close',()=>{if(dialog.open)projectMainImage.focus({preventScroll:true});});
window.addEventListener('resize',()=>{if(photoLightbox.open)fitLightboxImage();});


let lightboxDrag=null;
function stopLightboxDrag(){
 const drag=lightboxDrag;lightboxDrag=null;lightboxStage.classList.remove('is-dragging');
 if(drag&&lightboxStage.hasPointerCapture(drag.id))lightboxStage.releasePointerCapture(drag.id);
}
function beginLightboxDrag(e){
 if(e.pointerType!=='mouse'||e.button!==0||!photoLightbox.open)return;
 if(lightboxStage.scrollWidth<=lightboxStage.clientWidth&&lightboxStage.scrollHeight<=lightboxStage.clientHeight)return;
 e.preventDefault();
 lightboxDrag={id:e.pointerId,x:e.clientX,y:e.clientY,left:lightboxStage.scrollLeft,top:lightboxStage.scrollTop};
 lightboxStage.setPointerCapture(e.pointerId);lightboxStage.classList.add('is-dragging');
}
function moveLightboxDrag(e){
 if(!lightboxDrag||e.pointerId!==lightboxDrag.id)return;
 if(!(e.buttons&1)){stopLightboxDrag();return;}
 e.preventDefault();
 lightboxStage.scrollLeft=lightboxDrag.left-(e.clientX-lightboxDrag.x);
 lightboxStage.scrollTop=lightboxDrag.top-(e.clientY-lightboxDrag.y);
}
lightboxStage.addEventListener('pointerdown',beginLightboxDrag);
lightboxStage.addEventListener('pointermove',moveLightboxDrag);
for(const name of ['pointerup','pointercancel','lostpointercapture'])lightboxStage.addEventListener(name,stopLightboxDrag);
window.addEventListener('blur',stopLightboxDrag);
photoLightbox.addEventListener('close',stopLightboxDrag);

const processDefaults={"eyebrow": "HOW WE WORK", "title": "從第一次聊聊，到清楚交付。", "steps": [{"label": "01 / LISTEN", "title": "了解你的生活", "body": "從你的日常習慣、家庭成員與收納需求聊起，了解對家的想像，讓空間規劃貼近真實的生活。"}, {"label": "02 / PLAN", "title": "丈量與平面配置", "body": "實地丈量並確認空間條件，依照生活需求安排動線、家具與收納配置，一起找到舒適順手的格局。"}, {"label": "03 / DESIGN", "title": "做設計", "body": "以確認的平面配置為基礎，討論風格、材質、色彩與燈光，透過圖面與 3D 示意逐步確認空間細節。"}, {"label": "04 / BUDGET", "title": "預算分配", "body": "依整體預算與使用需求，整理各項工程及設備費用，討論優先順序與取捨，讓每一筆投入都有清楚方向。"}, {"label": "05 / BUILD", "title": "施工與現場", "body": "依確認的設計與工程範圍安排施工時程，協調工種與現場細節，並確認施作品質，逐步將設計落實為生活空間。"}]};

function renderProcess(value){const c=value||processDefaults,section=document.querySelector('.process');section.querySelector('.eyebrow').textContent=c.eyebrow;section.querySelector('h2').textContent=c.title;section.querySelector('.steps').innerHTML=c.steps.map(s=>'<article><span>'+esc(s.label)+'</span><h3>'+esc(s.title)+'</h3><p>'+esc(s.body)+'</p></article>').join('')}

const servicesDefaults={"eyebrow": "WHAT WE DO", "title": "一起，把想法落在圖上。", "intro": "給正在想像新家的你，\n也給需要製圖夥伴的設計團隊。", "items": [{"number": "01", "title": "空間設計規劃", "body": "從生活習慣出發，討論平面配置、動線與收納需求，安排適合你的設計方向與預算優先順序。", "tag": "住宅・商空"}, {"number": "02", "title": "3D 建模與渲染", "body": "把平面想法轉成可理解的立體畫面，在決定之前，看見比例、材質與燈光的關係。", "tag": "空間視覺提案"}, {"number": "03", "title": "施工流程", "body": "依確認的設計與工程範圍，安排施工順序、時程與現場配合事項。", "tag": "施工安排・流程配合"}, {"number": "04", "title": "施工圖與遠端代繪", "body": "平面配置、施工圖、大樣圖。可配合既有 CAD 圖層、圖框及繪圖習慣，接受單案或長期合作。", "tag": "設計團隊・遠端合作"}], "note": "代繪合作請提供現場丈量尺寸、基本案場資料與設計需求。可開立發票。"};

function renderServices(value){const c=value||servicesDefaults,section=document.querySelector('#services');section.querySelector('.eyebrow').textContent=c.eyebrow;section.querySelector('h2').textContent=c.title;const intro=section.querySelector('.section-heading>p');intro.textContent=c.intro;intro.style.whiteSpace='pre-line';section.querySelector('.service-note').textContent=c.note;section.querySelectorAll('.service-row').forEach(el=>el.remove());section.querySelector('.service-note').insertAdjacentHTML('beforebegin',c.items.map(s=>'<div class="service-row"><span>'+esc(s.number)+'</span><h3>'+esc(s.title)+'</h3><p>'+esc(s.body)+'</p><span class="tag">'+esc(s.tag)+'</span></div>').join(''))}

;(()=>{const closeMenu=()=>{nav.classList.remove('open');menu.setAttribute('aria-expanded','false');menu.textContent='選單 ＋';document.documentElement.classList.remove('menu-open')};
menu.addEventListener('click',()=>document.documentElement.classList.toggle('menu-open',nav.classList.contains('open')));
nav.querySelector('.nav-close')?.addEventListener('click',closeMenu);
nav.addEventListener('click',e=>{if(e.target.closest('a'))document.documentElement.classList.remove('menu-open')});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&nav.classList.contains('open'))closeMenu()});
window.addEventListener('resize',()=>{if(innerWidth>600&&nav.classList.contains('open'))closeMenu()});})();

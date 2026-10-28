// ============ Operator gate ============
let operator = localStorage.getItem('operator') || '';
const opGate = document.getElementById('opGate');
const opLabel = document.getElementById('opLabel');
const opLabel2 = document.getElementById('opLabel2');
function showOperator(){
  if(opLabel)  opLabel.textContent  = operator ? '('+operator+')' : '';
  if(opLabel2) opLabel2.textContent = operator||'';
}
if(operator && opGate){ opGate.style.display='none'; showOperator(); }
if(document.getElementById('opStart')){
  document.getElementById('opStart').onclick = ()=>{
    const v = document.getElementById('opName').value.trim();
    if(!v){ document.getElementById('opHint').textContent='Name required.'; return; }
    operator = v; localStorage.setItem('operator', operator);
    opGate.style.display='none'; showOperator();
  };
}
if(document.getElementById('changeOp')){
  document.getElementById('changeOp').onclick = e=>{
    e.preventDefault(); localStorage.removeItem('operator'); operator=''; location.reload();
  };
}

// Ask browser to keep our (metadata) data under memory pressure
if(navigator.storage && navigator.storage.persist) navigator.storage.persist();

// ============ Tabs ============
document.querySelectorAll('#tabs button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('#tabs button,.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='progress') renderProgress();
    if(b.dataset.tab==='gallery')  renderGallery();
  };
});

// ============ State (metadata only; no image blobs) ============
let records=[], counters={};
let currentQR=null, lastBlob=null, lastExt='jpg';
let stream=null, track=null, torchOn=false, scanning=false;

// ============ IndexedDB (metadata only) ============
let db;
const dbReq = indexedDB.open('qrlogger',3);
dbReq.onupgradeneeded = e=>{
  const d = e.target.result;
  if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
};
dbReq.onsuccess = e=>{ db=e.target.result; loadState(); };
function store(n,m='readonly'){ return db.transaction(n,m).objectStore(n); }
function kvGet(k){ return new Promise(r=>{ store('kv').get(k).onsuccess=e=>r(e.target.result); }); }
function kvPut(k,v){ store('kv','readwrite').put(v,k); }
async function loadState(){
  records  = (await kvGet('records'))||[];
  counters = (await kvGet('counters'))||{};
}
function persist(){ kvPut('records',records); kvPut('counters',counters); }

// ============ Elements ============
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d',{willReadFrequently:true});
const status = document.getElementById('status');
const qrText = document.getElementById('qrText');
const saveBtn = document.getElementById('saveBtn');
const torchBtn = document.getElementById('torchBtn');
const takePhotoBtn = document.getElementById('takePhotoBtn');
const photoInput = document.getElementById('photoInput');
const photoPreview = document.getElementById('photoPreview');
const startBtn = document.getElementById('startBtn');

// ============ Live QR scanner (small canvas, QR only) ============
async function startScanner(){
  if(scanning) return;
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ ideal:'environment' } }, audio:false
    });
    video.srcObject = stream;
    await video.play();
    track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torchBtn.disabled = !caps.torch;
    scanning = true;
    startBtn.textContent = 'Scanner running';
    startBtn.disabled = true;
    requestAnimationFrame(scanLoop);
    status.textContent = 'Point at QR code.';
  }catch(e){
    status.textContent = 'Camera error: '+e.message;
  }
}
function stopScanner(){
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  scanning = false;
  startBtn.textContent = 'Start QR scanner';
  startBtn.disabled = false;
  torchBtn.disabled = true;
}
startBtn.onclick = startScanner;
window.addEventListener('load', ()=>setTimeout(startScanner, 300));

torchBtn.onclick = async ()=>{
  if(!track) return;
  torchOn = !torchOn;
  try{ await track.applyConstraints({ advanced:[{ torch:torchOn }] }); }catch{}
};

function scanLoop(){
  if(!scanning) return;
  if(video.readyState===4 && video.videoWidth){
    const maxEdge = 640;
    const s = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    canvas.width  = Math.round(video.videoWidth  * s);
    canvas.height = Math.round(video.videoHeight * s);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    try{
      const img = ctx.getImageData(0,0,canvas.width,canvas.height);
      const code = jsQR(img.data, img.width, img.height, { inversionAttempts:'dontInvert' });
      if(code && code.data) setQR(code.data);
    }catch(e){}
  }
  requestAnimationFrame(scanLoop);
}

// ============ Take photo via native camera ============
takePhotoBtn.onclick = ()=>{
  stopScanner();
  photoInput.click();
};
photoInput.onchange = async e=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  if(!f.type.startsWith('image/')){
    status.textContent = `Got ${f.type||'unknown'}. Please use a camera app that saves JPG/PNG.`;
    return;
  }
  lastBlob = f;
  lastExt = (f.type==='image/png') ? 'png' : 'jpg';
  if(photoPreview.dataset.prev) URL.revokeObjectURL(photoPreview.dataset.prev);
  const prevUrl = URL.createObjectURL(f);
  photoPreview.src = prevUrl;
  photoPreview.dataset.prev = prevUrl;

  photoPreview.style.display = 'block';
  status.textContent = `Photo captured (${Math.round(f.size/1024)} KB). Fill form and Save.`;
  saveBtn.disabled = !currentQR;
};
document.getElementById('clearQrBtn').onclick = ()=>{
  currentQR = null; qrText.textContent='(none)'; takePhotoBtn.disabled=true; saveBtn.disabled=true;
};

// ============ Manual QR ============
document.getElementById('manualQrBtn').onclick = ()=>{
  const v = prompt('Enter QR ID:', currentQR||'');
  if(v){ setQR(v.trim()); if(lastBlob) saveBtn.disabled=false; }
};
function setQR(v){
  currentQR = v;
  qrText.textContent = v;
  takePhotoBtn.disabled = false;
  if(lastBlob) saveBtn.disabled = false;
}

// ============ Save: write JPG to Downloads, keep only metadata ============
saveBtn.onclick = ()=>{
  if(!currentQR || !lastBlob){ status.textContent='Need QR + image.'; return; }
  counters[currentQR] = (counters[currentQR]||0) + 1;
  const filename = `${currentQR}_${counters[currentQR]}.${lastExt}`;

  // Trigger browser download of the photo
  const url = URL.createObjectURL(lastBlob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 1500);

  // Store metadata row only
  const chk = id => document.getElementById(id).checked;
  records.push({
    filename, qr: currentQR, operator,
    phone: document.getElementById('phone').value,
    scanApp: document.getElementById('scanApp').value,
    rotation_severity: document.getElementById('rotation_severity').value,
    crease_severity:  document.getElementById('crease_severity').value,
    blur_severity:    document.getElementById('blur_severity').value,
    has_rotation:          chk('has_rotation'),
    has_shear:             chk('has_shear'),
    has_crease:            chk('has_crease'),
    has_ink_annotation:    chk('has_ink_annotation'),
    has_shadow:            chk('has_shadow'),
    has_partial_occlusion: chk('has_partial_occlusion'),
    has_motion_blur:       chk('has_motion_blur'),
    format: lastExt,
    notes: document.getElementById('notes').value,
    timestamp: new Date().toISOString()
  });
  persist();

  status.textContent = `Saved ${filename}. Total: ${records.length}.`;
  lastBlob = null;
  saveBtn.disabled = true;
  photoPreview.style.display = 'none';
  if(photoPreview.dataset.prev){ URL.revokeObjectURL(photoPreview.dataset.prev); delete photoPreview.dataset.prev; }
  takePhotoBtn.disabled = true;
  photoInput.value = '';
  startScanner();
};

// ============ Gallery (metadata only, no thumbnails) ============
const grid = document.getElementById('grid');
const filter = document.getElementById('filter');
function renderGallery(){
  const f = (filter.value||'').toLowerCase();
  grid.innerHTML = '';
  for(const r of records){
    if(f && !r.qr.toLowerCase().includes(f)) continue;
    const card = document.createElement('div'); card.className='card';
    card.innerHTML = `
      <div class="meta" style="padding:8px">
        <b>${r.filename}</b><br/>
        ${r.operator||''} / ${r.phone}<br/>
        blur:${r.blur_severity} crease:${r.crease_severity} rot:${r.rotation_severity}
      </div>
      <button data-f="${r.filename}">Delete record</button>`;
    card.querySelector('button').onclick = ()=>deleteRecord(r.filename);
    grid.appendChild(card);
  }
}
filter.oninput = renderGallery;
function deleteRecord(fn){
  if(!confirm('Delete record '+fn+'? (The JPG already in Downloads will NOT be removed.)')) return;
  records = records.filter(r=>r.filename!==fn);
  // Rebuild counters so next shot of this QR reuses the freed slot
  counters = {};
  for(const r of records){
    const m = /^(.*)_(\d+)\.(jpg|jpeg|png)$/i.exec(r.filename||'');
    if(m) counters[m[1]] = Math.max(counters[m[1]]||0, +m[2]);
  }
  persist();
  renderGallery();
}

// ============ Progress + badges ============
const BADGES = [
  {id:'first',   label:'First capture',       test:s=>s.total>=1},
  {id:'ten',     label:'10 captures',         test:s=>s.total>=10},
  {id:'fifty',   label:'50 captures',         test:s=>s.total>=50},
  {id:'hundred', label:'100 captures',        test:s=>s.total>=100},
  {id:'ids5',    label:'5 unique IDs',        test:s=>s.ids>=5},
  {id:'ids25',   label:'25 unique IDs',       test:s=>s.ids>=25},
  {id:'triple',  label:'3 photos of same ID', test:s=>s.maxPerId>=3},
  {id:'streak3', label:'3-day streak',        test:s=>s.streak>=3},
];
function renderProgress(){
  const total = records.length;
  const perId = {}; records.forEach(r => perId[r.qr]=(perId[r.qr]||0)+1);
  const ids = Object.keys(perId).length;
  const maxPerId = Math.max(0, ...Object.values(perId));
  const days = new Set(records.map(r=>r.timestamp.slice(0,10)));
  let streak = 0; const d = new Date();
  while(days.has(d.toISOString().slice(0,10))){ streak++; d.setDate(d.getDate()-1); }
  const s = {total, ids, maxPerId, streak};

  document.getElementById('stats').innerHTML = `
    <div class="stat"><b>${total}</b>Total photos</div>
    <div class="stat"><b>${ids}</b>Unique IDs</div>
    <div class="stat"><b>${maxPerId}</b>Max per ID</div>
    <div class="stat"><b>${streak}</b>Day streak</div>`;
  document.getElementById('badges').innerHTML = BADGES.map(b =>
    `<span class="badge ${b.test(s)?'earned':''}">${b.test(s)?'\u2605 ':''}${b.label}</span>`
  ).join('');
  const tb = document.querySelector('#idTable tbody'); tb.innerHTML='';
  Object.entries(perId).sort().forEach(([id,n])=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${id}</td><td>${n}</td>`;
    tb.appendChild(tr);
  });
}

// ============ Import / Export (metadata only) / Wipe ============
document.getElementById('importBtn').onclick = ()=>document.getElementById('importFile').click();
document.getElementById('importFile').onchange = async e=>{
  const buf = await e.target.files[0].arrayBuffer();
  const wb = XLSX.read(buf);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  rows.forEach(r=>{
    records.push(r);
    const m = /^(.*)_(\d+)\.(jpg|jpeg|png)$/i.exec(r.filename||'');
    if(m) counters[m[1]] = Math.max(counters[m[1]]||0, +m[2]);
  });
  persist(); renderProgress();
  alert(`Imported ${rows.length} rows.`);
};

document.getElementById('exportBtn').onclick = ()=>{
  if(records.length===0){ alert('Nothing to export.'); return; }
  const ws = XLSX.utils.json_to_sheet(records);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Log');
  const blob = new Blob([XLSX.write(wb,{type:'array',bookType:'xlsx'})]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const opTag = (operator||'op').replace(/[^A-Za-z0-9_-]+/g,'_');
  a.download = `qrlogger_${opTag}_${stamp}.xlsx`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 1500);
};

document.getElementById('wipeBtn').onclick = ()=>{
  if(!confirm('Erase ALL local metadata? (JPGs in Downloads are untouched.)')) return;
  records = []; counters = {};
  kvPut('records', records); kvPut('counters', counters);
  renderProgress(); renderGallery();
  alert('Local metadata wiped.');
};

document.getElementById('purgeImgsBtn').onclick = ()=>{
  if(!confirm('Delete all image blobs stored in the browser? (The JPGs saved to Downloads are not affected.)')) return;
  // Open the DB fresh to make sure we see the img store if it exists
  const req = indexedDB.open('qrlogger');
  req.onsuccess = e=>{
    const d = e.target.result;
    if(d.objectStoreNames.contains('img')){
      const tx = d.transaction('img','readwrite');
      tx.objectStore('img').clear();
      tx.oncomplete = ()=> alert('Image blobs purged.');
    } else {
      alert('No image blob store found - nothing to purge.');
    }
  };
};

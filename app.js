// ============ Operator gate ============
let operator = localStorage.getItem('operator') || '';
const opGate = document.getElementById('opGate');
const opLabel = document.getElementById('opLabel');
const opLabel2 = document.getElementById('opLabel2');
function showOperator(){ opLabel.textContent = operator ? '('+operator+')' : ''; opLabel2.textContent = operator||''; }
if(operator){ opGate.style.display='none'; showOperator(); }
document.getElementById('opStart').onclick = ()=>{
  const v = document.getElementById('opName').value.trim();
  if(!v){ document.getElementById('opHint').textContent='Name required.'; return; }
  operator = v; localStorage.setItem('operator', operator);
  opGate.style.display='none'; showOperator();
};
document.getElementById('changeOp').onclick = e=>{
  e.preventDefault(); localStorage.removeItem('operator'); operator=''; location.reload();
};

// ============ Tabs ============
document.querySelectorAll('#tabs button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('#tabs button,.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='gallery') renderGallery();
    if(b.dataset.tab==='progress') renderProgress();
  };
});

// ============ State ============
let records=[], counters={}, images={};
let currentQR=null, lastBlob=null, lastExt='jpg';
let stream=null, track=null, torchOn=false, scanning=false;

// Ask browser not to evict our data under memory pressure
if(navigator.storage && navigator.storage.persist) navigator.storage.persist();



// ============ IndexedDB ============
let db;
const dbReq = indexedDB.open('qrlogger',2);
dbReq.onupgradeneeded = e=>{
  const d = e.target.result;
  if(!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
  if(!d.objectStoreNames.contains('img')) d.createObjectStore('img');
};
dbReq.onsuccess = e=>{ db=e.target.result; loadState(); };
function store(n,m='readonly'){ return db.transaction(n,m).objectStore(n); }
function kvGet(k){ return new Promise(r=>{ store('kv').get(k).onsuccess=e=>r(e.target.result); }); }
function kvPut(k,v){ store('kv','readwrite').put(v,k); }
function imgPut(k,v){ store('img','readwrite').put(v,k); }
function imgGet(k){ return new Promise(r=>{ store('img').get(k).onsuccess=e=>r(e.target.result); }); }
function imgDel(k){ store('img','readwrite').delete(k); }
async function loadState(){
  records = (await kvGet('records'))||[];
  counters = (await kvGet('counters'))||{};
}
function persist(){ kvPut('records',records); kvPut('counters',counters); }

// ============ Mode toggle ============
const liveBox = document.getElementById('liveBox');
const nativeBox = document.getElementById('nativeBox');
document.querySelectorAll('input[name=mode]').forEach(r=>{
  r.onchange = ()=>{
    const live = document.querySelector('input[name=mode]:checked').value==='live';
    liveBox.hidden = !live; nativeBox.hidden = live;
    if(!live && stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; scanning=false; }
  };
});

// ============ Live camera ============
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d',{willReadFrequently:true});
const status = document.getElementById('status');
const qrText = document.getElementById('qrText');
const saveBtn = document.getElementById('saveBtn');
const snapBtn = document.getElementById('snapBtn');
const torchBtn = document.getElementById('torchBtn');

document.getElementById('startBtn').onclick = async ()=>{
  try{
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ ideal:'environment' },
              width:{ ideal:1920 }, height:{ ideal:1080 } },
      audio:false
    });
    video.srcObject = stream;
    await video.play();
    track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torchBtn.disabled = !caps.torch;
    snapBtn.disabled = false;
    scanning = true;
    requestAnimationFrame(scanLoop);
    status.textContent = 'Camera ready.';
  }catch(e){
    status.textContent = 'Camera error: '+e.message+' (make sure the site is HTTPS and permission is allowed).';
  }
};

torchBtn.onclick = async ()=>{
  if(!track) return;
  torchOn = !torchOn;
  try{ await track.applyConstraints({ advanced:[{ torch:torchOn }] }); }catch{}
};

function scanLoop(){
  if(!scanning) return;
  if(video.readyState === 4 && video.videoWidth){
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video,0,0);
    try{
      const img = ctx.getImageData(0,0,canvas.width,canvas.height);
      const code = jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'});
      if(code && code.data) setQR(code.data);
    }catch(e){ /* ignore occasional frame errors */ }
  }
  requestAnimationFrame(scanLoop);
}

snapBtn.onclick = async ()=>{
  if(!video.videoWidth){ status.textContent='Camera not ready yet.'; return; }
  const maxEdge = 3600;
  const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
  canvas.width  = Math.round(video.videoWidth  * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  lastExt = 'jpg';
  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.90));
  if(!blob){ status.textContent='Capture failed. Try again.'; return; }
  lastBlob = blob;
  status.textContent = `Frame captured (${Math.round(blob.size/1024)} KB). Fill form and Save.`;
  saveBtn.disabled = !currentQR;
};


// ============ Native camera ============
nativeInput.onchange = async e=>{
  const f = e.target.files && e.target.files[0];
  if(!f) return;
  if(!f.type.startsWith('image/')){
    status.textContent = `Received ${f.type || 'unknown file'}. Please pick a camera app that returns JPG/PNG.`;
    return;
  }
  try{
    // Peek at dimensions cheaply
    const probe = await createImageBitmap(f, { imageOrientation:'from-image' });
    const srcW = probe.width, srcH = probe.height;
    probe.close && probe.close();

    // --- QR decode on a 1400-px copy (RAM-friendly) ---
    const qrEdge = 1400;
    const sQ = Math.min(1, qrEdge / Math.max(srcW, srcH));
    const bmpQ = await createImageBitmap(f, {
      imageOrientation:'from-image',
      resizeWidth:  Math.round(srcW*sQ),
      resizeHeight: Math.round(srcH*sQ),
      resizeQuality:'high'
    });
    const cQ = document.createElement('canvas'); cQ.width=bmpQ.width; cQ.height=bmpQ.height;
    const cxQ = cQ.getContext('2d',{willReadFrequently:true});
    cxQ.drawImage(bmpQ,0,0);
    const dataQ = cxQ.getImageData(0,0,bmpQ.width,bmpQ.height);
    const code = jsQR(dataQ.data, bmpQ.width, bmpQ.height, { inversionAttempts:'attemptBoth' });
    bmpQ.close && bmpQ.close();
    if(code && code.data) setQR(code.data);

    // --- Storage copy at target resolution (also RAM-friendly) ---
    const maxEdge = 2400, quality = 0.85;
    const sS = Math.min(1, maxEdge / Math.max(srcW, srcH));
    const bmpS = await createImageBitmap(f, {
      imageOrientation:'from-image',
      resizeWidth:  Math.round(srcW*sS),
      resizeHeight: Math.round(srcH*sS),
      resizeQuality:'high'
    });
    const cS = document.createElement('canvas'); cS.width=bmpS.width; cS.height=bmpS.height;
    cS.getContext('2d').drawImage(bmpS,0,0);
    lastBlob = await new Promise(res => cS.toBlob(res, 'image/jpeg', quality));
    lastExt = 'jpg';
    bmpS.close && bmpS.close();

    nativePreview.src = URL.createObjectURL(lastBlob);
    const origKB = Math.round(f.size/1024), newKB = Math.round(lastBlob.size/1024);
    status.textContent = code
      ? `Loaded ${origKB} KB -> ${newKB} KB, QR decoded.`
      : `Loaded ${origKB} KB -> ${newKB} KB. No QR detected - enter manually.`;
  }catch(err){
    status.textContent = 'Could not process image: '+err.message;
  }
  saveBtn.disabled = !currentQR;
};



// ============ Manual QR ============
document.getElementById('manualQrBtn').onclick = ()=>{
  const v = prompt('Enter QR ID:', currentQR||'');
  if(v){ setQR(v.trim()); saveBtn.disabled = !lastBlob; }
};
function setQR(v){ currentQR = v; qrText.textContent = v; if(lastBlob) saveBtn.disabled = false; }

// ============ Save record ============
saveBtn.onclick = async ()=>{
  if(navigator.storage && navigator.storage.estimate){
    const est = await navigator.storage.estimate();
    const pct = est.usage / est.quota;
    if(pct > 0.85){
      if(!confirm(`Storage is ${Math.round(pct*100)}% full. Export now recommended. Save anyway?`)) return;
    }
  }  
    if(!currentQR || !lastBlob){ status.textContent='Need QR + image.'; return; }
  counters[currentQR] = (counters[currentQR]||0) + 1;
  const filename = `${currentQR}_${counters[currentQR]}.${lastExt}`;
  images[filename] = lastBlob;
  imgPut(filename, lastBlob);

  const chk = id => document.getElementById(id).checked;
  records.push({
    filename,
    qr: currentQR,
    operator,
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
  nativeInput.value = '';
};

// ============ Gallery ============
const grid = document.getElementById('grid');
const filter = document.getElementById('filter');
async function renderGallery(){
  const f = (filter.value||'').toLowerCase();
  grid.innerHTML = '';
  for(const r of records){
    if(f && !r.qr.toLowerCase().includes(f)) continue;
    const blob = images[r.filename] || await imgGet(r.filename);
    if(blob) images[r.filename] = blob;
    const url = blob ? URL.createObjectURL(blob) : '';
    const card = document.createElement('div'); card.className='card';
    card.innerHTML = `<img src="${url}" loading="lazy"/>
      <div class="meta"><b>${r.filename}</b><br/>${r.phone} / blur:${r.blur_severity} / crease:${r.crease_severity}</div>
      <button data-f="${r.filename}">Delete</button>`;
    card.querySelector('button').onclick = ()=>deleteRecord(r.filename);
    grid.appendChild(card);
  }
}
filter.oninput = renderGallery;
function deleteRecord(fn){
  if(!confirm('Delete '+fn+'?')) return;
  records = records.filter(r=>r.filename!==fn);
  delete images[fn]; imgDel(fn);
  persist(); renderGallery();
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

// ============ Import / Export / Wipe ============
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

document.getElementById('exportBtn').onclick = async ()=>{
  const ws = XLSX.utils.json_to_sheet(records);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Log');
  const xlsxBlob = new Blob([XLSX.write(wb,{type:'array',bookType:'xlsx'})]);
  const zip = new JSZip();
  zip.file('log.xlsx', xlsxBlob);
  for(const r of records){
    const blob = images[r.filename] || await imgGet(r.filename);
    if(blob) zip.file('images/'+r.filename, blob);
  }
  const out = await zip.generateAsync({type:'blob'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(out);
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const opTag = (operator||'op').replace(/[^A-Za-z0-9_-]+/g,'_');
  a.download = `qrlogger_${opTag}_${stamp}.zip`;
  a.click();
};

document.getElementById('wipeBtn').onclick = ()=>{
  if(!confirm('Erase ALL local records and images?')) return;
  records = []; counters = {}; images = {};
  kvPut('records', records); kvPut('counters', counters);
  db.transaction('img','readwrite').objectStore('img').clear();
  renderProgress(); renderGallery();
  alert('Local data wiped.');
};


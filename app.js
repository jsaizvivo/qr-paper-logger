// -------- Tabs --------
document.querySelectorAll('#tabs button').forEach(b=>{
  b.onclick=()=>{
    document.querySelectorAll('#tabs button,.tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
    if(b.dataset.tab==='gallery')renderGallery();
    if(b.dataset.tab==='progress')renderProgress();
  };
});

// -------- State --------
let records=[], counters={}, images={}; // images cache: filename -> Blob
let currentQR=null, lastBlob=null, lastExt='jpg';
let stream=null, track=null, torchOn=false;

// -------- IndexedDB --------
let db;
const dbReq=indexedDB.open('qrlogger',2);
dbReq.onupgradeneeded=e=>{
  const d=e.target.result;
  if(!d.objectStoreNames.contains('kv'))d.createObjectStore('kv');
  if(!d.objectStoreNames.contains('img'))d.createObjectStore('img');
};
dbReq.onsuccess=e=>{db=e.target.result;loadState();};

function store(name,mode='readonly'){return db.transaction(name,mode).objectStore(name);}
function kvGet(k){return new Promise(r=>{store('kv').get(k).onsuccess=e=>r(e.target.result);});}
function kvPut(k,v){store('kv','readwrite').put(v,k);}
function imgPut(k,v){store('img','readwrite').put(v,k);}
function imgGet(k){return new Promise(r=>{store('img').get(k).onsuccess=e=>r(e.target.result);});}
function imgDel(k){store('img','readwrite').delete(k);}

async function loadState(){
  records = (await kvGet('records'))||[];
  counters= (await kvGet('counters'))||{};
}
function persist(){kvPut('records',records);kvPut('counters',counters);}

// -------- Camera mode toggle --------
document.querySelectorAll('input[name=mode]').forEach(r=>{
  r.onchange=()=>{
    const live=document.querySelector('input[name=mode]:checked').value==='live';
    liveBox.hidden=!live; nativeBox.hidden=live;
    if(!live && stream){stream.getTracks().forEach(t=>t.stop());stream=null;}
  };
});

// -------- Live camera --------
const video=document.getElementById('video'),canvas=document.getElementById('canvas');
const ctx=canvas.getContext('2d',{willReadFrequently:true});

startBtn.onclick=async()=>{
  try{
    stream=await navigator.mediaDevices.getUserMedia({
      video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}
    });
    video.srcObject=stream;
    track=stream.getVideoTracks()[0];
    const caps=track.getCapabilities?.()||{};
    torchBtn.disabled=!caps.torch;
    snapBtn.disabled=false;
    requestAnimationFrame(scanLoop);
  }catch(e){status.textContent='Camera error: '+e.message;}
};

torchBtn.onclick=async()=>{
  if(!track)return;
  torchOn=!torchOn;
  try{await track.applyConstraints({advanced:[{torch:torchOn}]});}catch{}
};

function scanLoop(){
  if(video.readyState===4){
    canvas.width=video.videoWidth;canvas.height=video.videoHeight;
    ctx.drawImage(video,0,0);
    const img=ctx.getImageData(0,0,canvas.width,canvas.height);
    const code=jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'});
    if(code && code.data){setQR(code.data);}
  }
  if(stream)requestAnimationFrame(scanLoop);
}

snapBtn.onclick=()=>{
  lastExt=format.value;
  const type=lastExt==='png'?'image/png':'image/jpeg';
  canvas.toBlob(b=>{lastBlob=b;status.textContent='Frame captured. Fill form and Save.';saveBtn.disabled=!currentQR;},type,0.92);
};

// -------- Native camera mode --------
nativeInput.onchange=async e=>{
  const f=e.target.files[0];if(!f)return;
  lastBlob=f;
  lastExt=(f.type==='image/png')?'png':'jpg';
  nativePreview.src=URL.createObjectURL(f);
  // try to decode QR from the still
  const bmp=await createImageBitmap(f);
  const c=document.createElement('canvas');c.width=bmp.width;c.height=bmp.height;
  const cx=c.getContext('2d');cx.drawImage(bmp,0,0);
  const data=cx.getImageData(0,0,c.width,c.height);
  const code=jsQR(data.data,c.width,c.height);
  if(code && code.data){setQR(code.data);}
  else{status.textContent='No QR detected in photo. Enter QR manually.';}
  saveBtn.disabled=!currentQR;
};

// -------- Manual QR entry --------
manualQrBtn.onclick=()=>{
  const v=prompt('Enter QR ID:',currentQR||'');
  if(v){setQR(v.trim());saveBtn.disabled=!lastBlob;}
};
function setQR(v){currentQR=v;qrText.textContent=v;if(lastBlob)saveBtn.disabled=false;}

// -------- Save record --------
saveBtn.onclick=async()=>{
  if(!currentQR||!lastBlob){status.textContent='Need QR + image.';return;}
  counters[currentQR]=(counters[currentQR]||0)+1;
  const filename=`${currentQR}_${counters[currentQR]}.${lastExt}`;
  images[filename]=lastBlob;
  imgPut(filename,lastBlob);
  records.push({
    filename, qr:currentQR,
    phone:phone.value, scanApp:scanApp.value,
    crease:crease.value, ink:ink.value,
    rotation:Number(rotation.value), format:lastExt,
    notes:notes.value, timestamp:new Date().toISOString()
  });
  persist();
  status.textContent=`Saved ${filename}. Total records: ${records.length}.`;
  lastBlob=null; saveBtn.disabled=true;
};

// -------- Gallery --------
async function renderGallery(){
  const f=(filter.value||'').toLowerCase();
  grid.innerHTML='';
  for(const r of records){
    if(f && !r.qr.toLowerCase().includes(f))continue;
    const blob = images[r.filename] || await imgGet(r.filename);
    if(blob)images[r.filename]=blob;
    const url = blob?URL.createObjectURL(blob):'';
    const card=document.createElement('div');card.className='card';
    card.innerHTML=`<img src="${url}" loading="lazy"/>
      <div class="meta"><b>${r.filename}</b><br/>${r.phone} / ${r.ink} / ${r.crease}</div>
      <button data-f="${r.filename}">Delete</button>`;
    card.querySelector('button').onclick=()=>deleteRecord(r.filename);
    grid.appendChild(card);
  }
}
filter.oninput=renderGallery;

function deleteRecord(fn){
  if(!confirm('Delete '+fn+'?'))return;
  records=records.filter(r=>r.filename!==fn);
  delete images[fn];imgDel(fn);
  persist();renderGallery();
}

// -------- Progress + gamification --------
const BADGES=[
  {id:'first',    label:'First capture',       test:s=>s.total>=1},
  {id:'ten',      label:'10 captures',         test:s=>s.total>=10},
  {id:'fifty',    label:'50 captures',         test:s=>s.total>=50},
  {id:'hundred',  label:'100 captures',        test:s=>s.total>=100},
  {id:'ids5',     label:'5 unique IDs',        test:s=>s.ids>=5},
  {id:'ids25',    label:'25 unique IDs',       test:s=>s.ids>=25},
  {id:'triple',   label:'3 photos of same ID', test:s=>s.maxPerId>=3},
  {id:'variety',  label:'Both phones used',    test:s=>s.phones>=2},
  {id:'streak3',  label:'3-day streak',        test:s=>s.streak>=3},
];

function renderProgress(){
  const total=records.length;
  const perId={};records.forEach(r=>perId[r.qr]=(perId[r.qr]||0)+1);
  const ids=Object.keys(perId).length;
  const maxPerId=Math.max(0,...Object.values(perId));
  const phones=new Set(records.map(r=>r.phone)).size;

  // streak: count distinct consecutive days ending today
  const days=new Set(records.map(r=>r.timestamp.slice(0,10)));
  let streak=0;const d=new Date();
  while(days.has(d.toISOString().slice(0,10))){streak++;d.setDate(d.getDate()-1);}

  const s={total,ids,maxPerId,phones,streak};
  stats.innerHTML=`
    <div class="stat"><b>${total}</b>Total photos</div>
    <div class="stat"><b>${ids}</b>Unique IDs</div>
    <div class="stat"><b>${maxPerId}</b>Max per ID</div>
    <div class="stat"><b>${streak}</b>Day streak</div>`;
  badges.innerHTML=BADGES.map(b=>
    `<span class="badge ${b.test(s)?'earned':''}">${b.test(s)?'\u2605 ':''}${b.label}</span>`
  ).join('');
  const tb=idTable.querySelector('tbody');tb.innerHTML='';
  Object.entries(perId).sort().forEach(([id,n])=>{
    const tr=document.createElement('tr');tr.innerHTML=`<td>${id}</td><td>${n}</td>`;tb.appendChild(tr);
  });
}

// -------- Import / Export / Wipe --------
importBtn.onclick=()=>importFile.click();
importFile.onchange=async e=>{
  const buf=await e.target.files[0].arrayBuffer();
  const wb=XLSX.read(buf);
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  rows.forEach(r=>{
    records.push(r);
    const m=/^(.*)_(\d+)\.(jpg|jpeg|png)$/i.exec(r.filename||'');
    if(m)counters[m[1]]=Math.max(counters[m[1]]||0,+m[2]);
  });
  persist();renderProgress();
  alert(`Imported ${rows.length} rows.`);
};

exportBtn.onclick=async()=>{
  const ws=XLSX.utils.json_to_sheet(records);
  const wb=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb,ws,'Log');
  const xlsxBlob=new Blob([XLSX.write(wb,{type:'array',bookType:'xlsx'})]);
  const zip=new JSZip();
  zip.file('log.xlsx',xlsxBlob);
  for(const r of records){
    const blob = images[r.filename] || await imgGet(r.filename);
    if(blob) zip.file('images/'+r.filename, blob);
  }
  const out=await zip.generateAsync({type:'blob'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(out);
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  a.download=`qrlogger_${stamp}.zip`;
  a.click();
};

wipeBtn.onclick=async()=>{
  if(!confirm('Erase ALL local records and images?'))return;
  records=[];counters={};images={};
  kvPut('records',records);kvPut('counters',counters);
  // clear image store
  const tx=db.transaction('img','readwrite');tx.objectStore('img').clear();
  renderProgress();renderGallery();
  alert('Local data wiped.');
};

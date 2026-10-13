const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- 저장소 (프로젝트 = 사진 여러 장 + 분석 결과, 사진 원본은 썸네일만 보관) ----------
const KEY = 'gs_projects_v1';
let projects = [];
try { projects = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { projects = []; }
// 새로고침으로 중단된 항목 정리
projects.forEach(p => p.items.forEach(i => { if (i.status === 'wait' || i.status === 'run') { i.status = 'error'; i.error = '중단됨 — 다시 추가해 주세요'; } }));
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(projects)); }
    catch { alert('저장 공간이 부족해요. 오래된 프로젝트를 삭제해 주세요.'); }
  }, 300);
}

// 확인 화면용 사진 미리보기는 IndexedDB에 보관 (localStorage 용량 보호)
const idb = new Promise(res => {
  try {
    const r = indexedDB.open('gs_imgs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => res(r.result); r.onerror = () => res(null);
  } catch { res(null); }
});
const idbDo = async (mode, fn) => {
  const db = await idb; if (!db) return null;
  return new Promise(res => { const t = db.transaction('img', mode); const rq = fn(t.objectStore('img')); t.oncomplete = () => res(rq && rq.result); t.onerror = () => res(null); });
};
const putImg = (id, blob) => idbDo('readwrite', s => s.put(blob, id));
const getImg = id => idbDo('readonly', s => s.get(id));
const delImg = id => idbDo('readwrite', s => s.delete(id));

let cur = null;      // 현재 프로젝트
let mode = 'merged'; // 합치기 / 사진별
const jobs = [];     // 처리 대기열 {proj,item,canvas}
let running = false;

// ---------- 화면 전환 ----------
function showHome() {
  cur = null;
  $('#homeView').hidden = false; $('#projView').hidden = true;
  $('#projList').innerHTML = projects.length ? projects.map(p => {
    const done = p.items.filter(i => i.status === 'done').length;
    return `<div class="proj-card" data-open="${p.id}"><div><b>${esc(p.name)}</b><div class="note">사진 ${p.items.length}장 · 정리 완료 ${done}장 · ${new Date(p.created).toLocaleDateString('ko-KR')}</div></div><span>›</span></div>`;
  }).join('') : '<p class="hint">아직 프로젝트가 없어요.</p>';
}
function openProject(id) {
  cur = projects.find(p => p.id === id); if (!cur) return;
  $('#homeView').hidden = true; $('#projView').hidden = false;
  $('#projName').value = cur.name;
  renderProject();
}

function newProject() {
  const d = new Date();
  const p = { id: uid(), name: `프로젝트 ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, created: Date.now(), items: [] };
  projects.unshift(p); save(); openProject(p.id);
}

// ---------- 사진 추가 + 일괄 처리 ----------
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = async () => {
      const k = Math.min(1, 2200 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d');
      g.filter = 'grayscale(1) contrast(1.35)';
      g.drawImage(img, 0, 0, c.width, c.height);
      // 썸네일
      const t = document.createElement('canvas'), tk = 320 / Math.max(img.width, img.height);
      t.width = Math.max(1, Math.round(img.width * tk)); t.height = Math.max(1, Math.round(img.height * tk));
      t.getContext('2d').drawImage(img, 0, 0, t.width, t.height);
      // 확인 화면용 미리보기(원본 색상, 900px)
      const pk = Math.min(1, 1400 / Math.max(img.width, img.height));
      const pv = document.createElement('canvas');
      pv.width = Math.round(img.width * pk); pv.height = Math.round(img.height * pk);
      pv.getContext('2d').drawImage(img, 0, 0, pv.width, pv.height);
      const preview = await new Promise(r => pv.toBlob(r, 'image/jpeg', 0.8));
      URL.revokeObjectURL(url);
      resolve({ canvas: c, thumb: t.toDataURL('image/jpeg', 0.6), preview });
    };
    img.onerror = () => reject(new Error('사진을 열 수 없어요'));
    img.src = url;
  });
}

function addFiles(files) {
  if (!cur || !files.length) return;
  const proj = cur;
  [...files].forEach(f => {
    const item = { id: uid(), name: `사진 ${proj.items.length + 1}`, thumb: '', status: 'wait', progress: 0, sections: [], repeats: [] };
    proj.items.push(item);
    jobs.push({ proj, item, file: f });
  });
  save(); renderProject(); runQueue();
}

// words: 분석에 쓰는 글자 / weak: 흐리거나 인식 신뢰도가 낮은 부분(같은 줄에서 이어진 것끼리 박스로 합침)
function wordsFrom(data) {
  let ws = data.words;
  if (!ws && data.blocks) ws = data.blocks.flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
  ws = (ws || []).map(w => ({ text: w.text, conf: w.confidence, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  const words = ws.filter(w => w.conf > 30);
  const bad = ws.filter(w => w.conf < 65 && /[\p{L}\p{N}]/u.test(w.text)).sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.x0 - b.x0);
  const weak = [];
  for (const w of bad) {
    const h = w.y1 - w.y0, last = weak[weak.length - 1];
    if (last && Math.abs((last.y0 + last.y1) / 2 - (w.y0 + w.y1) / 2) < h * 0.6 && w.x0 - last.x1 < h * 1.5) {
      last.x1 = Math.max(last.x1, w.x1); last.y0 = Math.min(last.y0, w.y0); last.y1 = Math.max(last.y1, w.y1);
    } else weak.push({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 });
  }
  return { words, weak: weak.slice(0, 80) };
}

// 사진 자체의 선명도를 격자로 검사: 글자(대비)는 있는데 경계가 뭉개진 구간 = 흐림.
// 인식 신뢰도만으로는 "아예 못 읽은" 흐린 부분을 놓치므로 이미지에서 직접 찾는다.
function blurBoxes(canvas) {
  const w = canvas.width, h = canvas.height;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const T = Math.max(12, Math.round(Math.max(w, h) / 55));
  const gx = Math.ceil(w / T), gy = Math.ceil(h / T);
  const rng = new Float32Array(gx * gy), grad = new Float32Array(gx * gy);
  for (let ty = 0; ty < gy; ty++) for (let tx = 0; tx < gx; tx++) {
    let mn = 255, mx = 0, g = 0;
    const x1 = Math.min(w - 1, (tx + 1) * T), y1 = Math.min(h - 1, (ty + 1) * T);
    for (let y = ty * T; y < y1; y++) for (let x = tx * T; x < x1; x++) {
      const v = px[(y * w + x) * 4];
      if (v < mn) mn = v; if (v > mx) mx = v;
      const dx = Math.abs(v - px[(y * w + x + 1) * 4]), dy = Math.abs(v - px[((y + 1) * w + x) * 4]);
      if (dx > g) g = dx; if (dy > g) g = dy;
    }
    rng[ty * gx + tx] = mx - mn; grad[ty * gx + tx] = g;
  }
  const ink = [...grad.keys()].filter(i => rng[i] > 80);
  if (ink.length < 4) return [];
  const sorted = ink.map(i => grad[i]).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const flag = new Uint8Array(gx * gy);
  ink.forEach(i => { if (grad[i] < med * 0.45 || grad[i] < 55) flag[i] = 1; });
  // 이웃한 칸 묶기
  const seen = new Uint8Array(gx * gy), out = [];
  for (let s = 0; s < flag.length; s++) {
    if (!flag[s] || seen[s]) continue;
    const st = [s]; seen[s] = 1; let x0 = gx, y0 = gy, x1 = 0, y1 = 0, n = 0;
    while (st.length) {
      const i = st.pop(), x = i % gx, y = (i / gx) | 0; n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
        if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
        const j = ny * gx + nx; if (flag[j] && !seen[j]) { seen[j] = 1; st.push(j); }
      }
    }
    if (n >= 2) out.push({ x0: x0 * T, y0: y0 * T, x1: Math.min(w, (x1 + 1) * T), y1: Math.min(h, (y1 + 1) * T) });
  }
  return out;
}

async function runQueue() {
  if (running) return;
  running = true;
  let worker = null, curItem = null;
  try {
    while (jobs.length) {
      const job = jobs.shift(), item = job.item;
      curItem = item; item.status = 'run'; item.progress = 0.02; refresh();
      try {
        const { canvas, thumb, preview } = await loadImage(job.file);
        item.thumb = thumb; item.w = canvas.width; item.h = canvas.height;
        putImg(item.id, preview); refresh();
        if (typeof Tesseract === 'undefined') throw new Error('글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
        if (!worker) worker = await Tesseract.createWorker('kor+eng', 1, {
          logger: m => { if (m.status === 'recognizing text' && curItem) { curItem.progress = 0.1 + m.progress * 0.85; refreshProgress(); } }
        });
        const { data } = await worker.recognize(canvas);
        const { words, weak } = wordsFrom(data);
        if (!words.length) throw new Error('글자를 찾지 못했어요');
        const res = GSAnalyze.analyze(words);
        item.weak = [...blurBoxes(canvas), ...weak].slice(0, 80);
        item.sections = res.sections; item.repeats = res.repeats; item.status = 'done';
      } catch (e) { item.status = 'error'; item.error = e.message || String(e); }
      curItem = null; item.progress = 1; save(); refresh();
    }
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    running = false; refresh();
  }
}
function refresh() { if (cur) renderProject(); }
function refreshProgress() {
  const el = document.querySelector('.item.run .fill');
  if (el && cur) { const it = cur.items.find(i => i.status === 'run'); if (it) el.style.width = Math.round(it.progress * 100) + '%'; }
}

// ---------- 같은 패턴 합치기 ----------
// 글자 인식 오차를 감안해 제목이 비슷하면(편집거리 기준) 같은 패턴으로 봄
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const simText = (a, b) => {
  a = a.replace(/\s/g, ''); b = b.replace(/\s/g, '');
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  return 1 - lev(a, b) / Math.max(a.length, b.length);
};
const numCols = s => s.headers.map((_, c) => s.rows.filter(r => GSAnalyze.isNum(r[c] || '')).length * 2 > s.rows.length);
function samePattern(g, s) {
  if (g.headers.length - 1 !== s.headers.length) return false;
  const nc = numCols(s);
  let fuzzy = 0;
  for (let c = 0; c < s.headers.length; c++) {
    const sim = simText(g.headers[c + 1], s.headers[c]);
    if (sim < 0.5 || nc[c] !== g.num[c]) return false;
    if (sim < 1) fuzzy++;
  }
  return fuzzy <= Math.ceil(s.headers.length / 2);
}
function mergeSections(items) {
  const groups = [];
  items.filter(i => i.status === 'done').forEach(it => it.sections.forEach(s => {
    let g = groups.find(x => (s.type === 'text') === (x.type === 'text') && (s.type === 'text' || samePattern(x, s)));
    if (!g) groups.push(g = { type: s.type === 'text' ? 'text' : 'table', headers: ['사진', ...s.headers], num: numCols(s), rows: [], photos: new Set(), kind: s.type, fuzzy: false });
    else if (s.type !== 'text' && s.headers.some((h, c) => h !== g.headers[c + 1])) g.fuzzy = true;
    s.rows.forEach(r => g.rows.push([it.name, ...r]));
    g.photos.add(it.name);
  }));
  let n = 0;
  return groups.sort((a, b) => (a.type === 'text') - (b.type === 'text') || b.rows.length - a.rows.length).map(g => ({
    type: g.kind,
    title: g.type === 'text' ? '일반 글자' : `패턴 ${++n}: ${g.headers.slice(1, 4).join('·')}`,
    headers: g.headers, rows: g.rows,
    note: g.type === 'text' ? `${g.photos.size}장의 반복 없는 글자` : `${g.photos.size}장에서 같은 패턴 발견 · 총 ${g.rows.length}줄${g.fuzzy ? ' · 비슷한 제목도 함께 묶었어요' : ''}`
  }));
}
function perPhoto(items) {
  return items.filter(i => i.status === 'done').flatMap(it => it.sections.map(s => ({ ...s, photo: it.name, title: s.title })));
}
const exportSections = () => (mode === 'merged' ? mergeSections(cur.items) : perPhoto(cur.items).map(s => ({ ...s, title: `${s.photo} ${s.title}` })));

// ---------- 렌더 ----------
const STATUS = { wait: '대기 중', run: '글자 읽는 중…', done: '완료', error: '실패' };
function renderProject() {
  const items = cur.items;
  // 갤러리: 사진을 크게 보여주고, 누르면 확대·인식 구간 확인 화면으로
  $('#items').innerHTML = items.length ? `<div class="gal">${items.map(it => `
    <div class="gitem ${it.status}">
      <div class="gcard" ${it.thumb ? `data-view="${it.id}"` : ''}>
        ${it.thumb ? `<img src="${it.thumb}" alt="" data-view="${it.id}">` : ''}
        <button class="gdel" data-delitem="${it.id}" title="사진 삭제">✕</button>
        ${it.status === 'done' ? `<span class="gbadge ok">✓ 구간 ${it.sections.length}</span>` : ''}
        ${it.status === 'error' ? `<span class="gbadge bad">실패</span>` : ''}
        ${it.status === 'run' || it.status === 'wait' ? `<div class="gscan"><span>${it.status === 'run' ? '읽는 중' : '대기 중'}</span>${it.status === 'run' ? `<div class="bar"><div class="fill" style="width:${Math.round(it.progress * 100)}%"></div></div>` : ''}</div>` : ''}
      </div>
      <input class="iname" data-iname="${it.id}" value="${esc(it.name)}">
      ${it.status === 'error' ? `<div class="note err">${esc(it.error || '')}</div>` : ''}
    </div>`).join('')}</div>` : '<p class="hint">사진을 추가해 보세요. 여러 장을 한 번에 고를 수 있어요.</p>';

  const pending = items.filter(i => i.status === 'wait' || i.status === 'run').length;
  const q = $('#queueInfo');
  q.hidden = !pending; if (pending) q.textContent = `사진 ${pending}장 처리 중이에요… 끝난 사진부터 결과에 반영돼요.`;

  const done = items.filter(i => i.status === 'done');
  $('#resultBox').hidden = !done.length;
  if (!done.length) return;
  document.querySelectorAll('.segbtn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

  if (mode === 'merged') {
    const rep = {};
    done.forEach(i => i.repeats.forEach(r => rep[r.text] = (rep[r.text] || 0) + r.count));
    const rs = Object.entries(rep).sort((a, b) => b[1] - a[1]).slice(0, 10);
    $('#repeats').innerHTML = rs.length ? '<b>반복되는 글자</b> ' + rs.map(([t, c]) => `<span class="chip">${esc(t)} ×${c}</span>`).join('') : '';
    $('#sections').innerHTML = mergeSections(cur.items).map(cardHtml(false)).join('') || '<p class="hint">정리할 구간을 찾지 못했어요.</p>';
  } else {
    $('#repeats').innerHTML = '';
    $('#sections').innerHTML = done.map(it => `<h4 class="ph-title">${esc(it.name)}</h4>` + it.sections.map((s, si) => cardHtml(true)(s, si, it.id)).join('')).join('');
  }
}
const cardHtml = editable => (s, si, iid) => `
  <article class="card ${s.type}">
    <div class="card-head">
      ${editable ? `<input class="title" data-i="${iid}" data-s="${si}" value="${esc(s.title)}"><button class="x" data-i="${iid}" data-del="${si}" title="이 구간 삭제">✕</button>` : `<div class="title">${esc(s.title)}</div>`}
    </div>
    <div class="note">${esc(s.note)}</div>
    <div class="tbl-wrap"><table>
      <thead><tr>${s.headers.map((h, c) => `<th ${editable ? `contenteditable data-i="${iid}" data-s="${si}" data-h="${c}"` : ''}>${esc(h)}</th>`).join('')}</tr></thead>
      <tbody>${s.rows.map((r, ri) => `<tr>${r.map((v, c) => `<td ${editable ? `contenteditable data-i="${iid}" data-s="${si}" data-r="${ri}" data-c="${c}"` : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
  </article>`;

// ---------- 이벤트 ----------
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'projName') { cur.name = t.value; save(); return; }
  if (t.dataset.iname) { cur.items.find(i => i.id === t.dataset.iname).name = t.value; save(); return; }
  if (!t.dataset.i) return;
  const s = cur.items.find(i => i.id === t.dataset.i).sections[t.dataset.s];
  if (t.classList.contains('title')) s.title = t.value;
  else if (t.dataset.h != null) s.headers[t.dataset.h] = t.textContent;
  else if (t.dataset.r != null) s.rows[t.dataset.r][t.dataset.c] = t.textContent;
  save();
});
document.addEventListener('change', e => {
  if (e.target.dataset.iname && mode === 'merged') renderProject(); // 사진 이름이 합친 표의 '사진' 열에 반영
});
document.addEventListener('click', e => {
  const t = e.target, d = t.dataset;
  if (d.del != null) { cur.items.find(i => i.id === d.i).sections.splice(+d.del, 1); save(); renderProject(); }
  if (d.view) openViewer(d.view);
  if (d.delitem) { delImg(d.delitem); cur.items =cur.items.filter(i => i.id !== d.delitem); for (let k = jobs.length - 1; k >= 0; k--) if (jobs[k].item.id === d.delitem) jobs.splice(k, 1); save(); renderProject(); }
  if (d.mode) { mode = d.mode; renderProject(); }
  const card = t.closest('[data-open]'); if (card) openProject(card.dataset.open);
});
$('#newProjBtn').onclick = newProject;
$('#backBtn').onclick = () => { save(); showHome(); };
$('#delProjBtn').onclick = () => {
  if (!confirm(`'${cur.name}' 프로젝트를 삭제할까요? 정리 결과가 모두 사라져요.`)) return;
  cur.items.forEach(i => delImg(i.id));
  jobs.splice(0, jobs.length, ...jobs.filter(j => j.proj !== cur));
  projects = projects.filter(p => p !== cur); save(); showHome();
};
$('#camInput').onchange = $('#fileInput').onchange = e => { addFiles(e.target.files); e.target.value = ''; };

// ---------- 내보내기 ----------
const toCell = v => (/^-?[1-9]\d{0,14}(,\d{3})*(\.\d+)?$|^0(\.\d+)?$/.test(String(v).trim()) ? Number(String(v).replace(/,/g, '')) : v);
function sheetName(name, used) {
  let n = (name || '시트').replace(/[\\/?*[\]:]/g, '').slice(0, 28) || '시트', k = 2, base = n;
  while (used.has(n)) n = base.slice(0, 26) + k++;
  used.add(n); return n;
}
function stamp() { const d = new Date(), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function fname(ext) { return `${(cur.name || '글자스캔정리').replace(/[\\/:*?"<>|]/g, '_')}_${stamp()}.${ext}`; }
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
$('#xlsxBtn').onclick = () => {
  if (typeof XLSX === 'undefined') return alert('엑셀 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
  const wb = XLSX.utils.book_new(), used = new Set();
  exportSections().forEach(s => {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows.map(r => r.map(toCell))]);
    ws['!cols'] = s.headers.map((h, c) => ({ wch: Math.min(40, Math.max(6, ...[h, ...s.rows.map(r => r[c] || '')].map(v => String(v).length * 1.6))) }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName(s.title, used));
  });
  if (!wb.SheetNames.length) return alert('저장할 결과가 없어요.');
  XLSX.writeFile(wb, fname('xlsx'));
};
$('#docBtn').onclick = () => {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px 8px}th{background:#e8f3ee}</style></head><body><h2>${esc(cur.name)}</h2>` +
    exportSections().map(s => `<h3>${esc(s.title)}</h3><table><tr>${s.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${s.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table><br>`).join('') + '</body></html>';
  download(new Blob(['﻿', html], { type: 'application/msword' }), fname('doc'));
};
$('#copyBtn').onclick = async () => {
  const tsv = exportSections().map(s => [s.title, s.headers.join('\t'), ...s.rows.map(r => r.join('\t'))].join('\n')).join('\n\n');
  try { await navigator.clipboard.writeText(tsv); $('#copyBtn').textContent = '복사됨 ✓'; setTimeout(() => $('#copyBtn').textContent = '복사', 1500); }
  catch { alert('복사에 실패했어요'); }
};

showHome();
if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});

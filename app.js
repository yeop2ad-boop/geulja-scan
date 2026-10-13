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
    img.onload = () => {
      const k = Math.min(1, 2200 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d');
      g.filter = 'grayscale(1) contrast(1.35)';
      g.drawImage(img, 0, 0, c.width, c.height);
      // 썸네일
      const t = document.createElement('canvas'), tk = 120 / Math.max(img.width, img.height);
      t.width = Math.max(1, Math.round(img.width * tk)); t.height = Math.max(1, Math.round(img.height * tk));
      t.getContext('2d').drawImage(img, 0, 0, t.width, t.height);
      URL.revokeObjectURL(url);
      resolve({ canvas: c, thumb: t.toDataURL('image/jpeg', 0.6) });
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

function wordsFrom(data) {
  let ws = data.words;
  if (!ws && data.blocks) ws = data.blocks.flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
  return (ws || []).filter(w => w.confidence > 30).map(w => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
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
        const { canvas, thumb } = await loadImage(job.file);
        item.thumb = thumb;
        if (typeof Tesseract === 'undefined') throw new Error('글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
        if (!worker) worker = await Tesseract.createWorker('kor+eng', 1, {
          logger: m => { if (m.status === 'recognizing text' && curItem) { curItem.progress = 0.1 + m.progress * 0.85; refreshProgress(); } }
        });
        const { data } = await worker.recognize(canvas);
        const words = wordsFrom(data);
        if (!words.length) throw new Error('글자를 찾지 못했어요');
        const res = GSAnalyze.analyze(words);
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
function mergeSections(items) {
  const groups = new Map();
  items.filter(i => i.status === 'done').forEach(it => it.sections.forEach(s => {
    const key = s.type === 'text' ? 'text' : s.headers.join('\u0001');
    let g = groups.get(key);
    if (!g) groups.set(key, g = { type: s.type === 'text' ? 'text' : 'table', headers: ['사진', ...s.headers], rows: [], photos: new Set(), kind: s.type });
    s.rows.forEach(r => g.rows.push([it.name, ...r]));
    g.photos.add(it.name);
  }));
  let n = 0;
  return [...groups.values()].sort((a, b) => (a.type === 'text') - (b.type === 'text') || b.rows.length - a.rows.length).map(g => ({
    type: g.kind,
    title: g.type === 'text' ? '일반 글자' : `패턴 ${++n}: ${g.headers.slice(1, 4).join('·')}`,
    headers: g.headers, rows: g.rows,
    note: g.type === 'text' ? `${g.photos.size}장의 반복 없는 글자` : `${g.photos.size}장에서 같은 패턴 발견 · 총 ${g.rows.length}줄`
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
  $('#items').innerHTML = items.map((it, idx) => `
    <div class="item ${it.status}">
      ${it.thumb ? `<img src="${it.thumb}" alt="">` : '<div class="ph"></div>'}
      <div class="item-main">
        <input class="iname" data-iname="${it.id}" value="${esc(it.name)}">
        <div class="note">${it.status === 'error' ? esc(it.error || '') : STATUS[it.status]}${it.status === 'done' ? ` · 구간 ${it.sections.length}개` : ''}</div>
        ${it.status === 'run' ? `<div class="bar"><div class="fill" style="width:${Math.round(it.progress * 100)}%"></div></div>` : ''}
      </div>
      <button class="x" data-delitem="${it.id}" title="사진 삭제">✕</button>
    </div>`).join('') || '<p class="hint">사진을 추가해 보세요. 여러 장을 한 번에 고를 수 있어요.</p>';

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
  if (d.delitem) { cur.items = cur.items.filter(i => i.id !== d.delitem); for (let k = jobs.length - 1; k >= 0; k--) if (jobs[k].item.id === d.delitem) jobs.splice(k, 1); save(); renderProject(); }
  if (d.mode) { mode = d.mode; renderProject(); }
  const card = t.closest('[data-open]'); if (card) openProject(card.dataset.open);
});
$('#newProjBtn').onclick = newProject;
$('#backBtn').onclick = () => { save(); showHome(); };
$('#delProjBtn').onclick = () => {
  if (!confirm(`'${cur.name}' 프로젝트를 삭제할까요? 정리 결과가 모두 사라져요.`)) return;
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

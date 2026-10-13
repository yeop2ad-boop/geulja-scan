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
const SRC = id => 'src:' + id; // IndexedDB: 보정 전 원본(2200px)

// 파일/Blob → 색상 캔버스(긴 변 2200px 이하)
function decodeFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 2200 / Math.max(img.width, img.height));
      const c = GSImg.mk(img.width * k, img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c);
    };
    img.onerror = () => reject(new Error('사진을 열 수 없어요'));
    img.src = url;
  });
}
const toBlob = (c, q) => new Promise(r => c.toBlob(r, 'image/jpeg', q));
function fitCanvas(src, max) {
  const k = Math.min(1, max / Math.max(src.width, src.height)), c = GSImg.mk(src.width * k, src.height * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c;
}
// 흑백+대비 (ctx.filter는 일부 브라우저에서 미지원이라 픽셀로 직접 처리)
function grayContrast(src, contrast) {
  const c = GSImg.mk(src.width, src.height), g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0);
  const id = g.getImageData(0, 0, c.width, c.height), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = Math.max(0, Math.min(255, ((77 * d[i] + 150 * d[i + 1] + 29 * d[i + 2]) / 256 - 128) * contrast + 128));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(id, 0, 0); return c;
}

// 보정 파이프라인: 종이 펴기(원근) → 기울기 → 조명 → 글자인식용 흑백
async function prepare(job) {
  const item = job.item;
  let src;
  if (job.file) {
    src = await decodeFile(job.file);
    await putImg(SRC(item.id), await toBlob(src, 0.9));
    item.sw = src.width; item.sh = src.height;
  } else {
    const b = await getImg(SRC(item.id));
    if (!b) throw new Error('원본 사진을 찾을 수 없어요. 다시 추가해 주세요.');
    src = await decodeFile(b); item.sw = src.width; item.sh = src.height;
  }
  const notes = [];
  let corners = job.corners, auto = false;
  if (corners === undefined) {
    const q = GSImg.detectPaper(src);
    if (q && GSImg.needsWarp(q, src.width, src.height)) { corners = q.map(p => ({ x: p.x / src.width, y: p.y / src.height })); auto = true; }
  }
  let work = src;
  if (Array.isArray(corners)) {
    work = GSImg.warp(src, corners.map(p => ({ x: p.x * src.width, y: p.y * src.height })));
    notes.push(auto ? '종이를 자동으로 반듯하게 폈어요' : '직접 맞춘 모서리로 폈어요'); item.corners = corners;
  } else item.corners = corners === 'none' ? 'none' : null;
  const skew = GSImg.estimateSkew(work);
  if (Math.abs(skew) >= 0.4) { work = GSImg.rotate(work, -skew); notes.push(`기울기 ${Math.abs(skew)}° 보정`); }
  const light = GSImg.normalizeLight(work); work = light.canvas;
  if (light.note) notes.push(light.note);
  item.fix = notes;
  const t = fitCanvas(work, 320);
  return { color: work, canvas: grayContrast(work, light.note ? 1.15 : 1.35), thumb: t.toDataURL('image/jpeg', 0.6), preview: await toBlob(fitCanvas(work, 1400), 0.8) };
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
// 보정 화면에서 모서리를 바꿔 다시 처리 (corners: 정규화 좌표 4개 | 'none' | undefined=자동)
function reprocess(item, corners) {
  if (!cur) return;
  Object.assign(item, { status: 'wait', progress: 0, sections: [], weak: [], error: '' });
  jobs.push({ proj: cur, item, corners });
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
  return GSImg.tileAnalyze(canvas.getContext('2d').getImageData(0, 0, w, h).data, w, h).bad;
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
        const { canvas, thumb, preview, color } = await prepare(job);
        item.thumb = thumb; item.w = canvas.width; item.h = canvas.height;
        await putImg(item.id, preview); refresh();
        if (typeof Tesseract === 'undefined') throw new Error('글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
        if (!worker) worker = await Tesseract.createWorker('kor+eng', 1, {
          logger: m => { if (m.status === 'recognizing text' && curItem) { curItem.progress = Math.max(curItem.progress, 0.1 + m.progress * 0.85); refreshProgress(); } }
        });
        const { data } = await worker.recognize(canvas);
        let { words, weak } = wordsFrom(data);
        // 색이 있는 글자(빨강·파랑 등)는 색마다 그 색의 글자만 따로 읽어 정확도를 높이고, 글자 색 이름도 확정
        try {
          const colored = [];
          for (const ck of GSImg.inkColors(color)) {
            const r = await worker.recognize(GSImg.colorMask(color, ck.name));
            wordsFrom(r.data).words.forEach(w => { w.cn = ck.name; colored.push(w); });
          }
          if (colored.length) {
            const overlap = (a, b) => { const ix = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), iy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0); return ix > 0 && iy > 0 && ix * iy > 0.4 * Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0)); };
            words = [...words.filter(w => !colored.some(c => overlap(w, c))), ...colored];
          }
        } catch (e) { /* 색 분리 실패 시 기본 인식 결과 사용 */ }
        if (!words.length) throw new Error('글자를 찾지 못했어요');
        const marks = GSImg.findMarks(canvas, words);
        // 도장·무늬를 글자로 잘못 읽은 단어는 제거
        const solid = marks.filter(m => m.kind === "mark" || m.kind === "graphic");
        const clean = words.filter(w => !solid.some(m => { const ix = Math.min(w.x1, m.x1) - Math.max(w.x0, m.x0), iy = Math.min(w.y1, m.y1) - Math.max(w.y0, m.y0); return ix > 0 && iy > 0 && ix * iy > 0.5 * (w.x1 - w.x0) * (w.y1 - w.y0); }));
        const res = GSAnalyze.analyze(clean.length ? clean : words, { marks });
        item.zones = res.zones; item.marks = res.marks;
        { const all = GSStyle.classify(clean.length ? clean : words, color), keep = all.filter(s => s.count >= 2); item.styles = keep.length ? keep : all; } // 낱글자 잡음 그룹은 제외
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
// 같은 패턴끼리 묶음(members: 어느 사진의 어느 구간인지 포함) — 합치기·선택 추출·합계 등이 함께 사용
function groupSections(items) {
  const groups = [];
  items.filter(i => i.status === 'done').forEach(it => it.sections.forEach(s => {
    let g = groups.find(x => (s.type === 'text') === (x.type === 'text') && (s.type === 'text' || samePattern(x, s)));
    if (!g) groups.push(g = { type: s.type === 'text' ? 'text' : 'table', headers: ['사진', ...s.headers], num: numCols(s), rows: [], photos: new Set(), kind: s.type, fuzzy: false, members: [] });
    else if (s.type !== 'text' && s.headers.some((h, c) => h !== g.headers[c + 1])) g.fuzzy = true;
    s.rows.forEach(r => g.rows.push([it.name, ...r]));
    g.photos.add(it.name); g.members.push({ item: it, section: s });
  }));
  let n = 0;
  groups.sort((a, b) => (a.type === 'text') - (b.type === 'text') || b.rows.length - a.rows.length);
  groups.forEach(g => { g.title = g.type === 'text' ? '일반 글자' : `패턴 ${++n}: ${g.headers.slice(1, 4).join('·')}`; });
  return groups;
}
function mergeSections(items) {
  return groupSections(items).map(g => {
    let rows = g.rows;
    if (cur && cur.dedupe) { const seen = new Set(); rows = rows.filter(r => { const k = r.slice(1).join('\u0001'); if (seen.has(k)) return false; seen.add(k); return true; }); }
    return {
      type: g.kind, title: g.title, headers: g.headers, rows,
      note: g.type === 'text' ? `${g.photos.size}장의 반복 없는 글자` : `${g.photos.size}장에서 같은 패턴 발견 · 총 ${rows.length}줄${g.fuzzy ? ' · 비슷한 제목도 함께 묶었어요' : ''}${rows.length < g.rows.length ? ` · 중복 ${g.rows.length - rows.length}줄 제거` : ''}`
    };
  });
}
function perPhoto(items) {
  return items.filter(i => i.status === 'done').flatMap(it => it.sections.map(s => ({ ...s, photo: it.name, title: s.title })));
}
const exportSections = () => [...(mode === 'merged' ? mergeSections(cur.items) : perPhoto(cur.items).map(s => ({ ...s, title: `${s.photo} ${s.title}` }))), ...(cur.extras || [])];

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
        ${it.fix && it.fix.length && it.status === "done" ? `<span class="gfix">✨ 보정됨</span>` : ""}
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
  if (d.delitem) { delImg(d.delitem); delImg(SRC(d.delitem)); cur.items =cur.items.filter(i => i.id !== d.delitem); for (let k = jobs.length - 1; k >= 0; k--) if (jobs[k].item.id === d.delitem) jobs.splice(k, 1); save(); renderProject(); }
  if (d.mode) { mode = d.mode; renderProject(); }
  const card = t.closest('[data-open]'); if (card) openProject(card.dataset.open);
});
$('#newProjBtn').onclick = newProject;
$('#backBtn').onclick = () => { save(); showHome(); };
$('#delProjBtn').onclick = () => {
  if (!confirm(`'${cur.name}' 프로젝트를 삭제할까요? 정리 결과가 모두 사라져요.`)) return;
  cur.items.forEach(i => { delImg(i.id); delImg(SRC(i.id)); });
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

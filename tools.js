// 더 많은 기능: 선택 추출 / 검색해서 모으기 / 숫자 합계 / 중복 줄 제거
(() => {
  const $ = s => document.querySelector(s);
  const num = t => { const m = String(t).replace(/,/g, '').match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; };
  const fmt = n => (Math.round(n * 100) / 100).toLocaleString('ko-KR');
  const extra = s => { (cur.extras = cur.extras || []).push(s); save(); renderProject(); };

  // ---------- 만든 결과(추출 결과) 표시 ----------
  window.renderExtras = () => {
    const box = $('#extras'); if (!box || !cur) return;
    $('#dedupeState').textContent = '같은 내용 줄을 하나로 · ' + (cur.dedupe ? '켜짐' : '꺼짐');
    $('#dedupeBtn').classList.toggle('on', !!cur.dedupe);
    box.innerHTML = (cur.extras || []).map((s, i) => `
      <article class="card extract">
        <div class="card-head"><div class="title">${esc(s.title)}</div><button class="x" data-delextra="${i}" title="삭제">✕</button></div>
        <div class="note">${esc(s.note || '')}</div>
        <div class="tbl-wrap"><table><thead><tr>${s.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      </article>`).join('');
  };
  const baseRender = window.renderProject;
  window.renderProject = function () { baseRender(); window.renderExtras(); };
  document.addEventListener('click', e => {
    const d = e.target.dataset;
    if (d.delextra != null) { cur.extras.splice(+d.delextra, 1); save(); renderProject(); }
    const tool = e.target.closest('[data-tool]');
    if (tool) ({ pick: openPick, find: openFind, sum: openSum, style: openStyle, dedupe: toggleDedupe })[tool.dataset.tool]();
    const as = e.target.closest('[data-addstyle]');
    if (as) { const g = styleGroups()[+as.dataset.addstyle]; if (g) { extra(styleSection(g)); as.textContent = '추가됨 ✓'; as.disabled = true; } }
  });

  // ---------- 글자 색·크기별 모아 읽기 ----------
  // 모든 사진에서 같은 색·같은 크기 글자끼리 묶음
  function styleGroups() {
    const map = new Map();
    cur.items.filter(i => i.status === 'done' && i.styles).forEach(it => it.styles.forEach(st => {
      let g = map.get(st.key);
      if (!g) map.set(st.key, g = { key: st.key, name: st.name, hex: st.hex, count: 0, rows: [] });
      g.count += st.count; st.lines.forEach(l => g.rows.push([it.name, l]));
    }));
    return [...map.values()].sort((a, b) => b.count - a.count);
  }
  const styleSection = g => ({ type: 'extract', title: `글자: ${g.name}`, headers: ['사진', '글자'], rows: g.rows, note: `${g.name} 글자 ${g.count}개를 ${g.rows.length}줄로 모았어요` });
  function openStyle() {
    const gs = styleGroups();
    if (!gs.length) return alert('글자 스타일 정보가 있는 사진이 아직 없어요. (이전 버전으로 정리한 사진은 삭제 후 다시 추가해 주세요)');
    const body = `<p class="pk-help">같은 색·같은 크기의 글자끼리 모았어요. 필요한 그룹만 결과에 추가할 수 있어요.</p>` + gs.map((g, i) => `
      <div class="stgrp">
        <div class="sthead"><span class="stdot" style="background:${g.hex}"></span><b>${esc(g.name)}</b><em>${g.count}개</em><button class="lg" data-addstyle="${i}">결과에 추가</button></div>
        <div class="stlines">${g.rows.slice(0, 6).map(r => `<div><i>${esc(r[0])}</i>${esc(r[1])}</div>`).join('')}${g.rows.length > 6 ? `<div class="more">… 외 ${g.rows.length - 6}줄</div>` : ''}</div>
      </div>`).join('');
    openSheet('글자 색·크기별 보기', body, '모든 그룹 추가');
    sheetResult = null;
    $('#shAdd').onclick = () => { gs.forEach(g => extra(styleSection(g))); $('#sheet').hidden = true; };
  }
  function toggleDedupe() { cur.dedupe = !cur.dedupe; save(); renderProject(); }

  // ---------- 작은 시트(검색 / 합계) ----------
  let sheetResult = null;
  const defaultAdd = () => { if (!sheetResult || !sheetResult.rows.length) return alert('추가할 결과가 없어요.'); extra(sheetResult); $('#sheet').hidden = true; };
  function openSheet(title, body, addLabel) {
    $('#shTitle').textContent = title; $('#shBody').innerHTML = body; $('#shAdd').textContent = addLabel || '결과에 추가';
    $('#shAdd').onclick = defaultAdd; // 도구마다 동작을 바꿀 수 있으므로 열 때마다 기본값으로 되돌림
    $('#sheet').hidden = false; sheetResult = null;
  }
  $('#shClose').onclick = () => { $('#sheet').hidden = true; };
  $('#shAdd').onclick = defaultAdd;

  function openFind() {
    openSheet('검색해서 모으기', `<p class="pk-help">찾을 단어를 입력하면 모든 사진에서 그 단어가 들어간 줄만 모아 줘요.</p><input id="fdIn" class="fd-in" placeholder="예: 아메리카노" autocomplete="off"><div id="fdOut"></div>`);
    const run = () => {
      const q = $('#fdIn').value.trim().toLowerCase(), out = $('#fdOut');
      if (!q) { out.innerHTML = ''; sheetResult = null; return; }
      const rows = [];
      cur.items.filter(i => i.status === 'done').forEach(it => it.sections.forEach(s => s.rows.forEach(r => {
        if (r.some(v => String(v).toLowerCase().includes(q))) rows.push([it.name, s.title, s.type === 'text' ? r.join(' ') : r.map((v, c) => `${s.headers[c]}: ${v}`).filter((_, c) => r[c]).join(' · ')]);
      })));
      sheetResult = { type: 'extract', title: `검색: ${$('#fdIn').value.trim()}`, headers: ['사진', '구간', '내용'], rows, note: `'${$('#fdIn').value.trim()}'이(가) 들어간 줄 ${rows.length}개` };
      out.innerHTML = rows.length ? tableHtml(sheetResult) : '<p class="hint">찾은 줄이 없어요.</p>';
    };
    $('#fdIn').oninput = run; $('#fdIn').focus();
  }
  function tableHtml(s) {
    return `<div class="note" style="margin:10px 0 6px">${esc(s.note)}</div><div class="tbl-wrap"><table><thead><tr>${s.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${s.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function openSum() {
    const rows = [];
    groupSections(cur.items).filter(g => g.type !== 'text').forEach(g => {
      g.headers.forEach((h, c) => {
        if (c === 0 || !g.num[c - 1]) return;
        const vals = g.rows.map(r => num(r[c])).filter(v => !isNaN(v));
        if (!vals.length) return;
        const sum = vals.reduce((a, b) => a + b, 0);
        rows.push([g.title.replace(/^패턴 \d+: /, '패턴: '), h, fmt(sum), fmt(sum / vals.length), String(vals.length)]);
      });
    });
    sheetResult = { type: 'extract', title: '숫자 합계', headers: ['패턴', '열', '합계', '평균', '개수'], rows, note: '숫자가 대부분인 열의 합계와 평균이에요' };
    openSheet('숫자 합계', rows.length ? tableHtml(sheetResult) : '<p class="hint">합계를 낼 숫자 열을 찾지 못했어요.</p>');
    sheetResult = rows.length ? sheetResult : null;
  }

  // ---------- 선택 추출 ----------
  const pk = { gi: 0, mi: 0, sel: new Set(), strokes: [], mode: null, k: 1, crop: null, groups: [], url: null };
  const cv = $('#pkCv'), inner = $('#pkInner'), img = $('#pkImg');
  const cellList = s => {
    const out = [];
    (s.headBoxes || []).forEach((b, c) => b && out.push({ r: -1, c, b }));
    (s.cellBoxes || []).forEach((row, r) => row.forEach((b, c) => b && out.push({ r, c, b })));
    return out;
  };

  function openPick() {
    pk.groups = groupSections(cur.items).filter(g => g.type !== 'text' && g.members.some(m => m.section.cellBoxes));
    if (!pk.groups.length) return alert('선택할 패턴이 아직 없어요. 사진을 추가해 정리한 뒤 이용해 주세요. (이전 버전으로 정리한 사진은 삭제 후 다시 추가해야 해요)');
    pk.gi = 0; pk.mi = 0; $('#pick').hidden = false; document.body.style.overflow = 'hidden';
    renderChips(); loadMember();
  }
  const closePick = () => { $('#pick').hidden = true; document.body.style.overflow = ''; };
  $('#pkClose').onclick = closePick;

  function renderChips() {
    $('#pkChips').innerHTML = pk.groups.map((g, i) => `<button class="pkchip${i === pk.gi ? ' on' : ''}" data-pg="${i}">${esc(g.title)}</button>`).join('');
  }
  const members = () => pk.groups[pk.gi].members.filter(m => m.section.cellBoxes);

  async function loadMember() {
    const ms = members(), m = ms[pk.mi]; if (!m) return;
    pk.sel = new Set(); pk.strokes = []; pk.mode = null;
    $('#pkWho').textContent = `${m.item.name} · ${pk.mi + 1}/${ms.length}`;
    $('#pkPrev').disabled = pk.mi === 0; $('#pkNext').disabled = pk.mi === ms.length - 1;
    const blob = await getImg(m.item.id);
    if (pk.url) URL.revokeObjectURL(pk.url);
    pk.url = blob ? URL.createObjectURL(blob) : m.item.thumb;
    const cells = cellList(m.section), pad = 14;
    const bx0 = Math.min(...cells.map(c => c.b.x0)) - pad, by0 = Math.min(...cells.map(c => c.b.y0)) - pad;
    const bx1 = Math.max(...cells.map(c => c.b.x1)) + pad, by1 = Math.max(...cells.map(c => c.b.y1)) + pad;
    const maxW = Math.min($('#pkStage').clientWidth || 600, 640), maxH = Math.max(160, innerHeight * 0.42);
    const k = Math.min(maxW / (bx1 - bx0), maxH / (by1 - by0));
    pk.k = k; pk.crop = { x: bx0, y: by0 };
    inner.style.width = (bx1 - bx0) * k + 'px'; inner.style.height = (by1 - by0) * k + 'px';
    cv.width = Math.round((bx1 - bx0) * k); cv.height = Math.round((by1 - by0) * k);
    img.style.cssText = `position:absolute;left:${-bx0 * k}px;top:${-by0 * k}px;width:${m.item.w * k}px;height:${m.item.h * k}px`;
    img.src = pk.url;
    draw(); compute();
  }

  // 표시 좌표 ↔ 사진(OCR) 좌표
  const toX = x => (x - pk.crop.x) * pk.k, toY = y => (y - pk.crop.y) * pk.k;
  function draw() {
    const m = members()[pk.mi]; if (!m) return;
    const g = cv.getContext('2d'); g.clearRect(0, 0, cv.width, cv.height);
    cellList(m.section).forEach(({ r, c, b }) => {
      const on = pk.sel.has(r + ',' + c), x = toX(b.x0), y = toY(b.y0), w = (b.x1 - b.x0) * pk.k, h = (b.y1 - b.y0) * pk.k;
      if (on) { g.fillStyle = 'rgba(34,197,94,.38)'; g.fillRect(x, y, w, h); }
      g.strokeStyle = on ? 'rgba(22,163,74,.95)' : 'rgba(255,255,255,.0)'; g.lineWidth = 2; if (on) g.strokeRect(x, y, w, h);
    });
    g.strokeStyle = '#f97316'; g.lineWidth = 5; g.lineCap = 'round'; g.lineJoin = 'round';
    pk.strokes.forEach(st => { g.beginPath(); st.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke(); });
  }
  // 선이 지나간 칸 선택 (선 위의 점들을 촘촘히 확인)
  function hit(p) {
    const m = members()[pk.mi], t = 5;
    cellList(m.section).forEach(({ r, c, b }) => {
      if (p.x >= toX(b.x0) - t && p.x <= toX(b.x1) + t && p.y >= toY(b.y0) - t && p.y <= toY(b.y1) + t) pk.sel.add(r + ',' + c);
    });
  }
  let drawing = null;
  cv.addEventListener('pointerdown', e => {
    cv.setPointerCapture(e.pointerId);
    const p = pt(e); drawing = [p]; pk.strokes.push(drawing); hit(p); draw();
  });
  cv.addEventListener('pointermove', e => {
    if (!drawing) return;
    const p = pt(e), q = drawing[drawing.length - 1], n = Math.ceil(Math.hypot(p.x - q.x, p.y - q.y) / 3);
    for (let i = 1; i <= n; i++) hit({ x: q.x + (p.x - q.x) * i / n, y: q.y + (p.y - q.y) * i / n });
    drawing.push(p); draw();
  });
  const endStroke = () => { if (drawing) { drawing = null; pk.mode = null; compute(); } };
  cv.addEventListener('pointerup', endStroke); cv.addEventListener('pointercancel', endStroke);
  const pt = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height }; };

  $('#pkClear').onclick = () => { pk.sel = new Set(); pk.strokes = []; pk.mode = null; draw(); compute(); };
  $('#pkPrev').onclick = () => { pk.mi--; loadMember(); };
  $('#pkNext').onclick = () => { pk.mi++; loadMember(); };
  document.addEventListener('click', e => {
    const g = e.target.dataset.pg; if (g != null) { pk.gi = +g; pk.mi = 0; renderChips(); loadMember(); }
    const pm = e.target.dataset.pm; if (pm) { pk.mode = pm; compute(); }
  });

  // 결과 계산: 선택한 칸 → (같은 열 모두 / 선택한 칸만)
  let pickResult = null;
  function compute() {
    const out = $('#pkResult'), ms = members(), m = ms[pk.mi];
    pickResult = null;
    const cells = [...pk.sel].map(k => k.split(',').map(Number));
    if (!cells.length) { out.innerHTML = '<p class="hint">아직 선택한 글자가 없어요. 위 사진에서 뽑고 싶은 글자 위를 그어 보세요.</p>'; return; }
    const rowsSel = [...new Set(cells.filter(([r]) => r >= 0).map(([r]) => r))].sort((a, b) => a - b);
    const cols = [...new Set(cells.map(([, c]) => c))].sort((a, b) => a - b);
    const auto = (rowsSel.length >= 2 || cells.some(([r]) => r < 0)) ? 'column' : 'cells';
    const mode = pk.mode || auto;
    document.querySelectorAll('[data-pm]').forEach(b => b.classList.toggle('active', b.dataset.pm === mode));
    const s = m.section;
    let headers = cols.map(c => s.headers[c]), rows = [], note;
    if (mode === 'cells') {
      headers = ['사진', ...headers];
      rowsSel.forEach(r => rows.push([m.item.name, ...cols.map(c => (pk.sel.has(r + ',' + c) ? (s.rows[r][c] || '') : ''))]));
      note = `선을 그은 칸만 ${rows.length}줄`;
    } else {
      headers = ['사진', ...headers];
      pk.groups[pk.gi].members.forEach(mm => mm.section.rows.forEach(r => rows.push([mm.item.name, ...cols.map(c => r[c] || '')])));
      note = `같은 패턴의 ${new Set(rows.map(r => r[0])).size}장에서 '${cols.map(c => s.headers[c]).join(', ')}' 열만 ${rows.length}줄`;
    }
    pickResult = { type: 'extract', title: `선택 추출: ${cols.map(c => s.headers[c]).join('·')}`, headers, rows, note };
    out.innerHTML = tableHtml(pickResult);
  }
  $('#pkAdd').onclick = () => { if (!pickResult || !pickResult.rows.length) return alert('먼저 사진 위에서 뽑을 글자를 그어 주세요.'); extra(pickResult); closePick(); };
})();

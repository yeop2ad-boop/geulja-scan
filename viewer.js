// 갤러리 뷰어: 좌우 스와이프로 사진 넘기기, 두 손가락 핀치 줌, 더블탭 확대, 한 손가락 이동
// 초록 반투명 ✓ = 인식한 패턴(표·반복 양식), 빨간 반투명 = 흐리거나 인식이 어려운 부분
(() => {
  const $ = s => document.querySelector(s);
  const stage = $('#vstage'), box = $('#vimg'), img = $('#vphoto'), layer = $('#vlayer');
  let list = [], idx = 0, S = 1, TX = 0, TY = 0, url = null;
  const pts = new Map();
  let lastDist = 0, lastMid = null, swipe = null, lastTap = 0, moved = false;
  const MAXZ = 6;

  const fitBox = () => {
    const sw = stage.clientWidth, sh = stage.clientHeight, nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    const k = Math.min(sw / nw, sh / nh);
    const w = nw * k, h = nh * k;
    box.style.width = w + 'px'; box.style.height = h + 'px';
    box.style.marginLeft = -w / 2 + 'px'; box.style.marginTop = -h / 2 + 'px';
    clamp(); apply();
  };
  function clamp() {
    const mx = Math.max(0, (box.offsetWidth * S - stage.clientWidth) / 2);
    const my = Math.max(0, (box.offsetHeight * S - stage.clientHeight) / 2);
    TX = Math.min(mx, Math.max(-mx, TX)); TY = Math.min(my, Math.max(-my, TY));
  }
  function apply() {
    box.style.transform = `translate(${TX}px,${TY}px) scale(${S})`;
    box.style.setProperty('--inv', 1 / S);
  }
  // 화면상의 점(px,py: 스테이지 중앙 기준)을 고정한 채 배율 변경
  function zoomAt(px, py, ns) {
    ns = Math.min(MAXZ, Math.max(1, ns));
    const r = ns / S;
    TX = px - (px - TX) * r; TY = py - (py - TY) * r; S = ns;
    if (S === 1) { TX = 0; TY = 0; }
    clamp(); apply();
  }
  const rel = (cx, cy) => { const r = stage.getBoundingClientRect(); return [cx - r.left - r.width / 2, cy - r.top - r.height / 2]; };

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest('.vnav')) return;
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { swipe = { x: e.clientX, y: e.clientY }; moved = false; }
    else { swipe = null; const [a, b] = [...pts.values()]; lastDist = Math.hypot(a.x - b.x, a.y - b.y); lastMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  });
  stage.addEventListener('pointermove', e => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (Math.abs(e.clientX - (swipe?.x ?? e.clientX)) > 6 || Math.abs(e.clientY - (swipe?.y ?? e.clientY)) > 6) moved = true;
    if (pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      moved = true;
      if (lastDist > 0) { const [px, py] = rel(mid.x, mid.y); zoomAt(px, py, S * d / lastDist); }
      if (lastMid) { TX += mid.x - lastMid.x; TY += mid.y - lastMid.y; clamp(); apply(); }
      lastDist = d; lastMid = mid;
    } else if (S > 1) { TX += dx; TY += dy; clamp(); apply(); }
  });
  const end = e => {
    const p = pts.get(e.pointerId); if (!p) return;
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      if (swipe && S === 1 && moved) {
        const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) go(idx + (dx < 0 ? 1 : -1));
      } else if (swipe && !moved) {
        const now = Date.now();
        if (now - lastTap < 300) { const [px, py] = rel(e.clientX, e.clientY); zoomAt(px, py, S > 1 ? 1 : 2.5); lastTap = 0; }
        else lastTap = now;
      }
      swipe = null; lastDist = 0; lastMid = null;
      if (S < 1.03) { S = 1; TX = TY = 0; apply(); }
    } else if (pts.size === 1) { lastDist = 0; lastMid = null; }
  };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  stage.addEventListener('wheel', e => { e.preventDefault(); const [px, py] = rel(e.clientX, e.clientY); zoomAt(px, py, S * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
  img.addEventListener('load', fitBox);
  window.addEventListener('resize', () => { if (!$('#viewer').hidden) fitBox(); });

  function overlays(it) {
    if (!it.w) return '';
    const pos = b => `left:${b.x0 / it.w * 100}%;top:${b.y0 / it.h * 100}%;width:${(b.x1 - b.x0) / it.w * 100}%;height:${(b.y1 - b.y0) / it.h * 100}%`;
    const ok = patternBoxes(it).map((b, n) => `<div class="vb ok" style="${pos(b)}"><i>✓</i></div>`);
    const bad = (it.weak || []).map(b => `<div class="vb bad" style="${pos({ x0: b.x0 - 3, y0: b.y0 - 3, x1: b.x1 + 3, y1: b.y1 + 3 })}"></div>`);
    const pad = (b, p) => ({ x0: b.x0 - p, y0: b.y0 - p, x1: b.x1 + p, y1: b.y1 + p });
    const zone = (it.zones || []).map(z => `<div class="vb zone${z.group ? ' rep' : ''}" style="${pos(pad(z.box, 8))}"><em>${z.name}</em></div>`);
    const mark = (it.marks || []).map(m => `<div class="vb mark" style="${pos(m)}"><em>${MARK_NAME[m.kind] || '표식'}${m.corner ? ' · 구석' : ''}</em></div>`);
    const style = (it.styles || []).flatMap(st => st.boxes.map(b => `<div class="vb style" style="${pos(pad(b, 3))};border-color:${st.hex}"><em style="background:${st.hex}">${st.name}</em></div>`));
    return zone.join('') + mark.join('') + style.join('') + ok.join('') + bad.join('');
  }
  const MARK_NAME = { 'rule-h': '가로선', 'rule-v': '세로선', grid: '표 테두리', graphic: '그림·로고', mark: '무늬' };
  // 패턴으로 인식한 구간의 위치 (반복 구역은 블록마다)
  const patternBoxes = it => (it.sections || []).filter(s => s.type !== 'text').flatMap(s => (s.boxes || (s.box ? [s.box] : [])));
  async function go(i) {
    if (i < 0 || i >= list.length) return;
    idx = i; S = 1; TX = TY = 0; apply();
    const it = list[i];
    const blob = await getImg(it.id);
    if (url) URL.revokeObjectURL(url);
    url = blob ? URL.createObjectURL(blob) : it.thumb;
    img.src = url;
    layer.innerHTML = overlays(it);
    const nOk = patternBoxes(it).length, nBad = (it.weak || []).length;
    $('#vZone').textContent = `구역 ${(it.zones || []).length}`;
    $('#vMark').textContent = `표식 ${(it.marks || []).length}`;
    $('#vStyle').textContent = `글자 스타일 ${(it.styles || []).length}`;
    $('#vTitle').textContent = it.name;
    $('#vCount').textContent = `${i + 1} / ${list.length}`;
    $('#vOk').textContent = `✓ 인식한 패턴 ${nOk}`;
    $('#vBad').textContent = `인식 어려움 ${nBad}`;
    $('#vPrev').disabled = i === 0; $('#vNext').disabled = i === list.length - 1;
    $('#vFixNote').textContent = (it.fix && it.fix.length) ? '✨ ' + it.fix.join(' · ') : '';
    $('#vStatus').textContent = it.status === 'done' ? '' : (it.status === 'error' ? '인식에 실패한 사진이에요' : '아직 글자를 읽는 중이에요');
  }
  window.openViewer = id => {
    list = cur.items.filter(i => i.thumb);
    const i = list.findIndex(x => x.id === id); if (i < 0) return;
    $('#viewer').hidden = false; document.body.style.overflow = 'hidden';
    go(i);
  };
  const close = () => { $('#viewer').hidden = true; document.body.style.overflow = ''; };
  $('#vClose').onclick = close;
  $('#vFix').onclick = () => window.openEditor && window.openEditor(list[idx]);
  $('#vPrev').onclick = () => go(idx - 1); $('#vNext').onclick = () => go(idx + 1);
  $('#vOk').onclick = e => { const off = layer.classList.toggle('hide-ok'); e.currentTarget.classList.toggle('off', off); };
  $('#vBad').onclick = e => { const off = layer.classList.toggle('hide-bad'); e.currentTarget.classList.toggle('off', off); };
  $('#vZone').onclick = e => { const off = layer.classList.toggle('hide-zone'); e.currentTarget.classList.toggle('off', off); };
  layer.classList.add('hide-style'); // 글자 스타일 표시는 기본으로 꺼 둠(필요할 때 켜기)
  $('#vStyle').onclick = e => { const off = layer.classList.toggle('hide-style'); e.currentTarget.classList.toggle('off', off); };
  $('#vMark').onclick = e => { const off = layer.classList.toggle('hide-mark'); e.currentTarget.classList.toggle('off', off); };
  document.addEventListener('keydown', e => {
    if ($('#viewer').hidden) return;
    if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') go(idx + 1); else if (e.key === 'ArrowLeft') go(idx - 1);
  });
})();

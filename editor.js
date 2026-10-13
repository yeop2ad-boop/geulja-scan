// 사진 보정 화면: 종이의 네 모서리를 끌어 맞추면 반듯하게 펴서 다시 인식
(() => {
  const $ = s => document.querySelector(s);
  const img = $('#edImg'), box = $('#edBox'), stage = $('#edStage'), poly = $('#edPoly');
  const handles = [...document.querySelectorAll('.edh')];
  let item = null, pts = [], iw = 0, ih = 0, url = null;
  const FULL = () => [{ x: .06, y: .06 }, { x: .94, y: .06 }, { x: .94, y: .94 }, { x: .06, y: .94 }];

  function layout() {
    const k = Math.min(stage.clientWidth / iw, stage.clientHeight / ih);
    box.style.width = iw * k + 'px'; box.style.height = ih * k + 'px';
  }
  function render() {
    handles.forEach((h, i) => { h.style.left = pts[i].x * 100 + '%'; h.style.top = pts[i].y * 100 + '%'; });
    poly.setAttribute('points', pts.map(p => `${p.x * 100},${p.y * 100}`).join(' '));
  }
  // TL, TR, BR, BL 순서로 정렬 (사용자가 꼭짓점을 서로 바꿔 끌어도 안전)
  function ordered() {
    const sum = p => p.x + p.y, dif = p => p.x - p.y;
    const tl = pts.reduce((a, b) => sum(b) < sum(a) ? b : a), br = pts.reduce((a, b) => sum(b) > sum(a) ? b : a);
    const tr = pts.reduce((a, b) => dif(b) > dif(a) ? b : a), bl = pts.reduce((a, b) => dif(b) < dif(a) ? b : a);
    return [tl, tr, br, bl].map(p => ({ x: p.x, y: p.y }));
  }

  window.openEditor = async it => {
    item = it;
    const b = await getImg(SRC(it.id));
    if (!b) return alert('원본 사진이 없어 보정할 수 없어요. 사진을 다시 추가해 주세요.');
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(b);
    img.onload = () => {
      iw = img.naturalWidth; ih = img.naturalHeight;
      pts = Array.isArray(it.corners) ? it.corners.map(p => ({ ...p })) : FULL();
      layout(); render();
    };
    img.src = url;
    $('#editor').hidden = false;
  };
  const close = () => { $('#editor').hidden = true; };

  handles.forEach((h, i) => {
    h.addEventListener('pointerdown', e => { e.preventDefault(); h.setPointerCapture(e.pointerId); h.classList.add('drag'); });
    h.addEventListener('pointermove', e => {
      if (!h.hasPointerCapture(e.pointerId)) return;
      const r = box.getBoundingClientRect();
      pts[i] = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
      render();
    });
    h.addEventListener('pointerup', () => h.classList.remove('drag'));
    h.addEventListener('pointercancel', () => h.classList.remove('drag'));
  });
  window.addEventListener('resize', () => { if (!$('#editor').hidden) { layout(); render(); } });

  $('#edAuto').onclick = () => {
    const c = fitCanvas(img, 1200), q = GSImg.detectPaper(c);
    if (!q) return alert('종이 모서리를 자동으로 찾지 못했어요. 직접 끌어서 맞춰 주세요.');
    pts = q.map(p => ({ x: p.x / c.width, y: p.y / c.height })); render();
  };
  $('#edReset').onclick = () => { pts = FULL(); render(); };
  const finish = corners => { close(); $('#vClose').click(); reprocess(item, corners); };
  $('#edApply').onclick = () => finish(ordered());
  $('#edNone').onclick = () => finish('none');
  $('#edCancel').onclick = close;
})();

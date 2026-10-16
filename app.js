// 글자스캔정리 — 빠른 글자 리더기
// 카메라 가운데 띠(빨간 선 구간) 안의 글자만 읽어서 메모장(옆으로 이어쓰기) 또는 엑셀(찍을 때마다 다음 칸)에 입력
(() => {
  const $ = s => document.querySelector(s);
  const KEY = 'reader_v1';
  const def = { mode: 'memo', memo: '', grid: [['', '', '']], cols: 3, dir: 'down', cur: { r: 0, c: 0 }, band: 0.2, x0: 0.06, x1: 0.94, space: 'keep', kind: 'all' };
  let st;
  try { st = Object.assign({}, def, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { st = { ...def }; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* 저장 공간 부족은 무시 */ } };
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };

  const video = $('#video'), cam = $('#cam'), band = $('#band');
  let stream = null, track = null, caps = {}, torchOn = false, zoom = 1, dz = 1, evVal = 0;

  /* ---------------- 띠(읽는 구간) ---------------- */
  function layoutBand() {
    st.band = Math.min(0.5, Math.max(0.07, st.band));
    st.x0 = Math.min(st.x0, st.x1 - 0.15); st.x1 = Math.max(st.x1, st.x0 + 0.15);
    band.style.left = st.x0 * 100 + '%'; band.style.width = (st.x1 - st.x0) * 100 + '%'; band.style.height = st.band * 100 + '%';
  }
  // 빨간 선 양 끝 손잡이: 좌우로 끌어 읽는 길이 조절
  function drag(el, side) {
    el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); el._d = true; });
    el.addEventListener('pointermove', e => {
      if (!el._d) return;
      const r = cam.getBoundingClientRect(), x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (side === 'L') st.x0 = Math.min(x, st.x1 - 0.15); else st.x1 = Math.max(x, st.x0 + 0.15);
      layoutBand();
    });
    const end = () => { if (el._d) { el._d = false; save(); } };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  drag($('#gripL'), 'L'); drag($('#gripR'), 'R');
  $('#bandPlus').onclick = () => { st.band += 0.04; layoutBand(); save(); };
  $('#bandMinus').onclick = () => { st.band -= 0.04; layoutBand(); save(); };

  /* ---------------- 카메라 ---------------- */
  async function startCam() {
    if (stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return noCam();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) { return noCam(); }
    $('#nocam').hidden = true;
    video.srcObject = stream; await video.play().catch(() => {});
    track = stream.getVideoTracks()[0]; caps = (track.getCapabilities && track.getCapabilities()) || {};
    try { if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* 일부 기기 미지원 */ }
    const er0 = caps.exposureCompensation;
    $('#torch').hidden = !(caps.torch || (er0 && er0.max > er0.min)); // 플래시 또는 밝기 조절 중 하나라도 되면 버튼 표시
    zoom = caps.zoom ? caps.zoom.min : 1; dz = 1; video.style.transform = '';
    setupLight();
    try { if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {}); } catch { /* 무시 */ }
  }
  function stopCam() { if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; track = null; video.srcObject = null; }
  function noCam() { $('#nocam').hidden = false; }
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopCam(); else startCam(); });
  // 🔦 플래시: 누르면 켜지면서 밝기 슬라이더가 나오고, 다시 누르면 꺼짐
  const fmtEv = v => (v > 0 ? '+' : '') + Number(v).toFixed(1);
  function setupLight() {
    const er = caps.exposureCompensation, r = $('#lightRange');
    if (er && er.max > er.min) { r.min = er.min; r.max = er.max; r.step = er.step || 0.5; r.value = evVal; $('#lightVal').textContent = fmtEv(evVal); }
  }
  $('#lightRange').oninput = e => {
    evVal = +e.target.value; $('#lightVal').textContent = fmtEv(evVal); placeThumb();
    if (track) track.applyConstraints({ advanced: [{ exposureCompensation: evVal }] }).catch(() => {});
  };
  $('#torch').onclick = async () => {
    const btn = $('#torch'), er = caps.exposureCompensation, hasEv = er && er.max > er.min, on = !btn.classList.contains('on');
    if (caps.torch) { try { await track.applyConstraints({ advanced: [{ torch: on }] }); torchOn = on; } catch { return toast('이 기기는 플래시를 켤 수 없어요', 'bad'); } } else torchOn = on;
    btn.classList.toggle('on', on);
    $('#lightPanel').hidden = !(on && hasEv);
  };

  /* ---------------- 두 손가락 확대·축소 ---------------- */
  // 기기가 지원하면 실제 카메라 줌, 아니면 화면 확대(디지털). 읽는 영역 계산도 확대 배율(dz)을 반영
  const pts = new Map(); let pinch = null, zTimer = null, zApplyT = 0;
  const zLim = () => (caps.zoom ? { min: caps.zoom.min, max: Math.min(caps.zoom.max, 10), hw: true } : { min: 1, max: 4, hw: false });
  function applyZoom(z) {
    const L = zLim(); zoom = Math.min(L.max, Math.max(L.min, z));
    if (L.hw) { dz = 1; const now = Date.now(); if (track && now - zApplyT > 50) { zApplyT = now; track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {}); } }
    else { dz = zoom; video.style.transform = `scale(${dz})`; }
    const tip = $('#zoomTip'); tip.textContent = (zoom / L.min).toFixed(1) + '×'; tip.hidden = false;
    clearTimeout(zTimer); zTimer = setTimeout(() => { tip.hidden = true; }, 900);
  }

  /* ---------------- 탭 초점 (갤럭시 카메라 방식) ---------------- */
  // 화면을 톡 누르면 그 지점에 노란 초점 상자가 뜨고 초점을 맞춤 · 상자 옆 해 모양을 끌면 밝기 조절 · 길게 누르면 초점·밝기 잠금
  const fbox = $('#fbox'), fexp = $('#fexp'), fthumb = fexp.querySelector('i');
  let fTimer = null, locked = false, down = null;
  function placeThumb() { const er = caps.exposureCompensation; if (!er || er.max <= er.min) return; fthumb.style.top = (1 - (evVal - er.min) / (er.max - er.min)) * 100 + '%'; }
  function keepBox(ms) { clearTimeout(fTimer); if (ms) fTimer = setTimeout(() => { fbox.classList.add('fade'); setTimeout(() => { if (fbox.classList.contains('fade')) fbox.hidden = true; }, 380); }, ms); }
  function showBox(x, y, lock) {
    fbox.hidden = false; fbox.classList.remove('fade'); fbox.classList.toggle('locked', !!lock);
    fbox.style.left = x + 'px'; fbox.style.top = y + 'px';
    fbox.style.animation = 'none'; void fbox.offsetWidth; fbox.style.animation = '';
    const er = caps.exposureCompensation; fexp.hidden = !(er && er.max > er.min);
    const nearRight = x > cam.clientWidth - 120; fexp.style.left = nearRight ? 'auto' : 'calc(100% + 14px)'; fexp.style.right = nearRight ? 'calc(100% + 14px)' : 'auto';
    placeThumb(); keepBox(lock ? 0 : 2200);
  }
  // 누른 곳(화면 좌표) → 영상 속 비율 좌표로 바꿔 그 지점에 초점
  async function focusAt(cx, cy, lock) {
    const vw = video.videoWidth, vh = video.videoHeight; locked = !!lock;
    if (!track || !vw) return;
    const cw = cam.clientWidth, ch = cam.clientHeight, k0 = Math.max(cw / vw, ch / vh) * dz;
    const nx = Math.min(1, Math.max(0, ((cx - cw / 2) / k0 + vw / 2) / vw)), ny = Math.min(1, Math.max(0, ((cy - ch / 2) / k0 + vh / 2) / vh)), fm = caps.focusMode || [];
    const adv = { pointsOfInterest: [{ x: nx, y: ny }] };
    if (fm.includes('single-shot')) adv.focusMode = 'single-shot'; else if (fm.includes('continuous')) adv.focusMode = 'continuous';
    try { await track.applyConstraints({ advanced: [adv] }); }
    catch { try { if (fm.length) await track.applyConstraints({ advanced: [{ focusMode: fm.includes('continuous') ? 'continuous' : fm[0] }] }); } catch { /* 이 기기는 초점 지정 미지원 */ } }
    // 잠그지 않았다면, 맞춘 뒤에는 그 지점을 기준으로 계속 초점을 따라가게 함
    if (!lock && fm.includes('continuous')) setTimeout(() => { if (!locked && track) track.applyConstraints({ advanced: [{ focusMode: 'continuous', pointsOfInterest: [{ x: nx, y: ny }] }] }).catch(() => {}); }, 900);
  }
  cam.addEventListener('pointerdown', e => {
    if (e.target.closest('.grip, button, label, #fexp, #nocam, #lightPanel')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { // 두 번째 손가락이 닿으면 확대·축소 시작 (탭/길게누르기는 취소)
      if (down) { clearTimeout(down.timer); down = null; }
      const [a, b] = [...pts.values()]; pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom }; return;
    }
    if (pts.size > 2) return;
    const r = cam.getBoundingClientRect(); down = { x: e.clientX - r.left, y: e.clientY - r.top, moved: false, fired: false };
    down.timer = setTimeout(() => { if (down && !down.moved) { down.fired = true; showBox(down.x, down.y, true); focusAt(down.x, down.y, true); if (navigator.vibrate) navigator.vibrate(20); } }, 550);
  });
  cam.addEventListener('pointermove', e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) { const [a, b] = [...pts.values()]; applyZoom(pinch.z0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0)); return; }
    if (!down) return; const r = cam.getBoundingClientRect(); if (Math.hypot(e.clientX - r.left - down.x, e.clientY - r.top - down.y) > 10) { down.moved = true; clearTimeout(down.timer); }
  });
  const endPtr = e => { pts.delete(e.pointerId); if (pinch && pts.size < 2) { pinch = null; if (zLim().hw && track) track.applyConstraints({ advanced: [{ zoom }] }).catch(() => {}); return true; } return false; };
  cam.addEventListener('pointerup', e => { const was = endPtr(e); if (was || !down) return; clearTimeout(down.timer); const d = down; down = null; if (d.moved || d.fired) return; showBox(d.x, d.y, false); focusAt(d.x, d.y, false); });
  cam.addEventListener('pointercancel', e => { endPtr(e); if (down) { clearTimeout(down.timer); down = null; } });
  // 밝기(노출) 슬라이더
  function setEv(e) {
    const er = caps.exposureCompensation; if (!er) return;
    const r = fexp.getBoundingClientRect(), t = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    evVal = er.min + (1 - t) * (er.max - er.min); if (er.step) evVal = Math.round(evVal / er.step) * er.step;
    placeThumb(); $('#lightRange').value = evVal; $('#lightVal').textContent = fmtEv(evVal);
    if (track) track.applyConstraints({ advanced: [{ exposureCompensation: evVal }] }).catch(() => {});
  }
  fexp.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); fexp.setPointerCapture(e.pointerId); fexp._d = true; keepBox(0); setEv(e); });
  fexp.addEventListener('pointermove', e => { if (fexp._d) setEv(e); });
  const endEv = () => { if (fexp._d) { fexp._d = false; if (!fbox.classList.contains('locked')) keepBox(2200); } };
  fexp.addEventListener('pointerup', endEv); fexp.addEventListener('pointercancel', endEv);

  /* ---------------- 글자 인식 엔진 ---------------- */
  let worker = null, engWorker = null, ready = false;
  const readyP = (async () => {
    try {
      worker = await Tesseract.createWorker('kor+eng', 1, {
        logger: m => { if (!ready && m.progress != null && /load|init/.test(m.status)) $('#status').textContent = `엔진 준비 중 ${Math.round(m.progress * 100)}%`; }
      });
      await worker.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      // 첫 촬영이 느리지 않도록 한 번 예열
      const w = mk(260, 70), g = w.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 260, 70); g.fillStyle = '#000'; g.font = '36px sans-serif'; g.fillText('안녕 123', 10, 48);
      await worker.recognize(w);
      ready = true; const s = $('#status'); s.textContent = '준비 완료 ✓'; s.classList.add('ready'); setTimeout(() => { s.style.opacity = 0; }, 2200);
      $('#shutter').classList.remove('wait');
      // 숫자 쉼표 확인용 영어 전용 엔진(작아서 금방 뜸) — 준비되면 자동으로 사용
      Tesseract.createWorker('eng', 1).then(async w => { await w.setParameters({ tessedit_pageseg_mode: '7', preserve_interword_spaces: '1' }); engWorker = w; }).catch(() => {});
    } catch (e) { $('#status').textContent = '엔진을 불러오지 못했어요 · 인터넷을 확인해 주세요'; }
  })();
  $('#shutter').classList.add('wait');

  // 엔진은 한글 글자 사이에 가짜 띄어쓰기를 넣는 일이 잦음("청 구 금액", "2026 년"). 엔진의 글자 위치는 부정확해서
  // 쓰지 않고, 사진에서 직접 잰 "진짜 빈 구간"의 개수·위치와 맞춰 보며 가짜 띄어쓰기만 지운다 (진짜 것은 유지).
  const cw = ch => (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(ch) ? 1 : /\d/.test(ch) ? 0.58 : /[A-Z]/.test(ch) ? 0.68 : /[a-z]/.test(ch) ? 0.52 : /[,.:;'`|!]/.test(ch) ? 0.28 : /[-_]/.test(ch) ? 0.45 : ch === '%' ? 0.85 : 0.7);
  function reconcile(text, gaps, L, R) {
    const toks = text.split(' ').filter(Boolean), cand = toks.length - 1;
    if (cand < 1 || !gaps || gaps.length >= cand) return text;          // 진짜 빈 구간이 충분하면 엔진 결과 그대로
    if (gaps.length === 0) return toks.join('');                          // 빈 구간이 하나도 없으면 한 덩어리
    const wt = toks.map(t => [...t].reduce((s, ch) => s + cw(ch), 0)), Wtot = wt.reduce((a, b) => a + b, 0) || 1;
    const cum = []; let acc = 0; for (let b = 0; b < cand; b++) { acc += wt[b]; cum.push(acc); }
    const n = gaps.length, sumGap = gaps.reduce((s, g) => s + g.w, 0), inkTot = Math.max(1, (R - L) - sumGap);
    const pre = []; let pg = 0; for (let j = 0; j < n; j++) { pre.push(pg); pg += gaps[j].w; }
    const cost = (j, b) => Math.abs(L + (cum[b] / Wtot) * inkTot + pre[j] + gaps[j].w / 2 - gaps[j].c);
    // 진짜 빈 구간 j번째에 어느 토큰 경계 b를 맞출지: 순서를 지키며 총 오차 최소 (DP)
    const best = Array.from({ length: n }, () => Array(cand).fill(Infinity)), from = Array.from({ length: n }, () => Array(cand).fill(-1));
    for (let b = 0; b < cand; b++) best[0][b] = cost(0, b);
    for (let j = 1; j < n; j++) for (let b = j; b < cand; b++) for (let p = j - 1; p < b; p++) { const v = best[j - 1][p] + cost(j, b); if (v < best[j][b]) { best[j][b] = v; from[j][b] = p; } }
    let bb = -1, bv = Infinity; for (let b = n - 1; b < cand; b++) if (best[n - 1][b] < bv) { bv = best[n - 1][b]; bb = b; }
    if (bb < 0) return text;
    const keep = new Set(); for (let j = n - 1; j >= 0; j--) { keep.add(bb); bb = from[j][bb]; }
    return toks.reduce((s, t, i) => s + (i && keep.has(i - 1) ? ' ' : '') + t, '');
  }
  // 엔진이 자주 틀리는 기호: ₩ → \ , 괄호 안쪽 공백
  const cleanEdge = t => t.replace(/^[|_~'"`\s]+|[|_~'"`\s]+$/g, '').replace(/\s{2,}/g, ' ').replace(/\\(?=\d)/g, '₩').replace(/([(\[{])\s+/g, '$1').replace(/\s+([)\]}])/g, '$1');
  // 숫자 쉼표 보정: 한글 엔진은 "4,500"의 쉼표를 빠뜨리곤 함. 영어 전용 엔진이 같은 숫자(자릿수 동일)를 쉼표 포함으로 읽었을 때만 그 표기를 채택
  const VALID_COMMA = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
  async function fixNumbers(text, canvas) {
    if (!engWorker || !/\d{4,}|\d,\d{1,2}(?!\d)|\d{4},|\d\.\d{3}[,.]/.test(text)) return text;
    let e = ''; try { e = (await engWorker.recognize(canvas)).data.text.replace(/\n/g, ' '); } catch { return text; }
    const re = /\d[\d,.]*\d|\d/g, et = (e.match(re) || []).filter(t => VALID_COMMA.test(t));
    if (!et.length) return text;
    return text.replace(re, tk => {
      if (VALID_COMMA.test(tk)) return tk;
      const dg = tk.replace(/\D/g, ''), hit = et.find(x => x.replace(/\D/g, '') === dg);
      return hit || tk;
    });
  }
  async function recognize(canvas) {
    await readyP; if (!worker) throw new Error('engine');
    const run = async () => {
      const { data } = await worker.recognize(canvas);
      const raw = cleanEdge((data.words || []).filter(w => w.text.trim() && w.confidence > 25).map(w => w.text.trim()).join(' '));
      return { text: reconcile(raw, canvas.__gaps, canvas.__L, canvas.__R), conf: data.confidence || 0 };
    };
    let r = await run();
    if (r.conf < 62) { // 자신 없을 때만 한 번 더(여러 줄 모드) 시도해 더 나은 쪽 선택
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      const r2 = await run(); await worker.setParameters({ tessedit_pageseg_mode: '7' });
      if (r2.conf > r.conf && r2.text) r = r2;
    }
    return fixNumbers(r.text, canvas);
  }

  /* ---------------- 캡처 + 최소 정리 ---------------- */
  // 화면의 띠(빨간 선 구간) → 영상 좌표로 변환해 그 부분만 잘라 냄
  function grab() {
    const vw = video.videoWidth, vh = video.videoHeight; if (!vw) return null;
    // 화면 좌표 → 영상 좌표 (cover 배치 + 디지털 확대 dz 반영)
    const cw = cam.clientWidth, ch = cam.clientHeight, k0 = Math.max(cw / vw, ch / vh) * dz, X = x => (x - cw / 2) / k0 + vw / 2, Y = y => (y - ch / 2) / k0 + vh / 2;
    const sx = Math.max(0, X(cw * st.x0)), sx1 = Math.min(vw, X(cw * st.x1));
    const sy = Math.max(0, Y(ch * (0.5 - st.band / 2))), sy1 = Math.min(vh, Y(ch * (0.5 + st.band / 2)));
    const w = sx1 - sx, h = sy1 - sy; if (w < 10 || h < 6) return null;
    const k = Math.min(1, 2400 / w), c = mk(w * k, h * k);
    c.getContext('2d').drawImage(video, sx, sy, w, h, 0, 0, c.width, c.height);
    return c;
  }
  // 아주 가벼운 정리: 회색조 → 밝기 늘리기 → (밝은 글자면 뒤집기) → 띠 가운데 글줄만 남기고 알맞은 크기로
  function prepLine(c) {
    const w = c.width, h = c.height, g = c.getContext('2d', { willReadFrequently: true }), d = g.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h), hist = new Uint32Array(256);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) { const v = (77 * d[i] + 150 * d[i + 1] + 29 * d[i + 2]) >> 8; gray[j] = v; hist[v]++; }
    // 글자/바탕 가르기(Otsu): 글자는 늘 면적이 작은 쪽. 짧은 글자라도, 밝은 글자·어두운 바탕이라도 동작
    const tot = w * h; let sumAll = 0; for (let v = 0; v < 256; v++) sumAll += v * hist[v];
    let wB = 0, sB = 0, bestVar = -1, th0 = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = tot - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB, mF = (sumAll - sB) / wF, bv = wB * wF * (mB - mF) * (mB - mF);
      if (bv > bestVar) { bestVar = bv; th0 = t; }
    }
    let nD = 0, sD = 0, nL = 0, sL = 0;
    for (let v = 0; v < 256; v++) { if (v <= th0) { nD += hist[v]; sD += v * hist[v]; } else { nL += hist[v]; sL += v * hist[v]; } }
    if (!nD || !nL) return null;
    const mD = sD / nD, mL = sL / nL;
    if (mL - mD < 30) return null; // 대비가 없으면 글자가 없는 것
    const inkIsLight = nL < nD, sc = 255 / (mL - mD);
    for (let j = 0; j < gray.length; j++) { let v = Math.max(0, Math.min(255, (gray[j] - mD) * sc)); gray[j] = inkIsLight ? 255 - v : v; } // 항상 "밝은 바탕 + 어두운 글자"로
    // 글줄 찾기: 잉크(어두운 점)가 있는 가로줄 묶음 중 띠 가운데를 지나는 것(없으면 가장 큰 것)
    const rowInk = new Uint32Array(h), thr = 120;
    for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (gray[y * w + x] < thr) n++; rowInk[y] = n; }
    const minInk = Math.max(2, w * 0.004), segs = []; let s0 = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rowInk[y] > minInk;
      if (on && s0 < 0) s0 = y;
      if (!on && s0 >= 0) { let mass = 0; for (let k = s0; k < y; k++) mass += rowInk[k]; segs.push({ a: s0, b: y, mass }); s0 = -1; }
    }
    if (!segs.length) return null;
    const gap = Math.max(2, h * 0.1), merged = [segs[0]];
    for (let i = 1; i < segs.length; i++) { const l = merged[merged.length - 1]; if (segs[i].a - l.b <= gap) { l.b = segs[i].b; l.mass += segs[i].mass; } else merged.push({ ...segs[i] }); }
    const mid = h / 2, maxMass = Math.max(...merged.map(s => s.mass));
    let pick = merged.find(s => s.a <= mid && s.b >= mid && s.mass > maxMass * 0.2) || merged.reduce((a, b) => (b.mass > a.mass ? b : a));
    let top = pick.a, bot = pick.b;
    // 가로로 글자가 있는 범위
    let left = w, right = 0;
    for (let y = top; y < bot; y++) for (let x = 0; x < w; x++) if (gray[y * w + x] < thr) { if (x < left) left = x; if (x > right) right = x; }
    if (right <= left) return null;
    const th = bot - top, padY = Math.round(th * 0.35), padX = Math.round(th * 0.8);
    top = Math.max(0, top - padY); bot = Math.min(h, bot + padY); left = Math.max(0, left - padX); right = Math.min(w, right + padX);
    const cw = right - left, chh = bot - top;
    const crop = mk(cw, chh), cg = crop.getContext('2d'), id = cg.createImageData(cw, chh);
    for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) { const v = gray[(top + y) * w + left + x], o = (y * cw + x) * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = v; id.data[o + 3] = 255; }
    cg.putImageData(id, 0, 0);
    // 글자 높이가 대략 44px이 되도록 (너무 크면 줄이고 너무 작으면 키움) → 빠르고 정확한 크기
    const k = Math.max(0.2, Math.min(3, (window.__tgt || 44) / th)), kk = Math.min(k, 2200 / cw), out = mk(cw * kk, chh * kk), og = out.getContext('2d');
    og.imageSmoothingQuality = 'high'; og.fillStyle = '#fff'; og.fillRect(0, 0, out.width, out.height); og.drawImage(crop, 0, 0, out.width, out.height);
    // 사진 속 "진짜 띄어쓰기": 글자 높이의 22% 이상 완전히 비어 있는 세로 구간 (엔진이 넣은 가짜 띄어쓰기를 걸러낼 때 사용)
    const od = og.getImageData(0, 0, out.width, out.height).data, OW = out.width, OH = out.height, col = new Uint8Array(OW);
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) if (od[(y * OW + x) * 4] < 140) col[x] = 1;
    let L = 0, Rr = OW - 1; while (L < OW && !col[L]) L++; while (Rr > L && !col[Rr]) Rr--;
    const need = 0.33 * th * kk, gaps = []; let run = 0;
    for (let x = L; x <= Rr; x++) { if (!col[x]) run++; else { if (run >= need) gaps.push({ c: x - run / 2, w: run }); run = 0; } }
    out.__gaps = gaps; out.__L = L; out.__R = Rr;
    return out;
  }

  /* ---------------- 입력(메모장 / 엑셀) ---------------- */
  const hist = [];
  function ensureRow(r) { while (st.grid.length <= r) st.grid.push(Array(st.cols).fill('')); }
  function fixGrid() { st.grid.forEach(row => { while (row.length < st.cols) row.push(''); row.length = st.cols; }); if (!st.grid.length) st.grid = [Array(st.cols).fill('')]; st.cur.c = Math.min(st.cur.c, st.cols - 1); ensureRow(st.cur.r); }
  function commit(text) {
    if (st.mode === 'memo') {
      hist.push({ mode: 'memo', memo: st.memo });
      st.memo = st.memo && !/\s$/.test(st.memo) ? st.memo + ' ' + text : st.memo + text; // 옆으로 이어서
      renderMemo();
    } else {
      const { r, c } = st.cur; ensureRow(r);
      hist.push({ mode: 'excel', r, c, old: st.grid[r][c], cur: { ...st.cur } });
      st.grid[r][c] = text;
      if (st.dir === 'down') st.cur.r++; else { st.cur.c++; if (st.cur.c >= st.cols) { st.cur.c = 0; st.cur.r++; } }
      ensureRow(st.cur.r); renderGrid(true);
    }
    if (hist.length > 50) hist.shift();
    save();
  }
  $('#undo').onclick = () => {
    const h = hist.pop(); if (!h) return toast('취소할 입력이 없어요', 'bad');
    if (h.mode === 'memo') { st.memo = h.memo; renderMemo(); } else { st.grid[h.r][h.c] = h.old; st.cur = h.cur; renderGrid(true); }
    save(); $('#last').textContent = '방금 입력을 취소했어요'; $('#last').classList.remove('has');
  };

  /* ---------------- 촬영 ---------------- */
  let chain = Promise.resolve(), pending = 0;
  function setBusy() { $('#shutter').classList.toggle('busy', pending > 0); band.classList.toggle('busy', pending > 0); }
  function flash(cls) { band.classList.remove('ok', 'bad'); void band.offsetWidth; band.classList.add(cls); setTimeout(() => band.classList.remove(cls), 600); }
  let toastT; function toast(msg, cls) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1400); if (cls) flash(cls); }

  /* ---------------- 셔터 양옆 선택: 띄어쓰기 / 글자·숫자 ---------------- */
  // 읽은 결과를 선택한 방식으로 정리: 글자만(한글·영문) / 숫자만(숫자와 , . - : /) / 전체, 그리고 띄어쓰기 포함·빼고
  function finalize(t) {
    if (st.kind === 'text') t = t.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣA-Za-z\s]/g, '');
    else if (st.kind === 'num') { const m = t.match(/\d(?:[\d,.\-:/]*\d)?/g); t = m ? m.join(' ') : ''; }
    t = t.replace(/\s+/g, ' ').trim();
    return st.space === 'strip' ? t.replace(/\s/g, '') : t;
  }
  function syncOpts() {
    document.querySelectorAll('#optSpace button').forEach(b => b.classList.toggle('on', b.dataset.sp === st.space));
    document.querySelectorAll('#optKind button').forEach(b => b.classList.toggle('on', b.dataset.kind === st.kind));
  }
  document.querySelectorAll('#optSpace button').forEach(b => { b.onclick = () => { st.space = b.dataset.sp; syncOpts(); save(); }; });
  document.querySelectorAll('#optKind button').forEach(b => { b.onclick = () => { st.kind = b.dataset.kind; syncOpts(); save(); }; });

  async function process(canvas) {
    const t0 = performance.now();
    try {
      const line = prepLine(canvas);
      if (!line) { toast('글자를 찾지 못했어요', 'bad'); return; }
      const kind = st.kind, space = st.space; // 누른 순간의 선택을 적용
      const text = finalize(await recognize(line));
      if (!text) { toast(kind === 'num' ? '숫자를 찾지 못했어요' : kind === 'text' ? '글자를 찾지 못했어요' : '글자를 읽지 못했어요 · 다시 맞춰 주세요', 'bad'); return; }
      commit(text);
      flash('ok'); toast(text); if (navigator.vibrate) navigator.vibrate(25);
      const l = $('#last'); l.textContent = '✓ ' + text; l.classList.add('has');
      console.log('읽기 소요', Math.round(performance.now() - t0), 'ms →', text);
    } catch (e) { toast('읽는 중 문제가 생겼어요', 'bad'); }
  }
  function shoot() {
    const c = grab();
    if (!c) return toast('카메라를 준비하는 중이에요', 'bad');
    pending++; setBusy();
    chain = chain.then(() => process(c)).finally(() => { pending--; setBusy(); }); // 연달아 눌러도 순서대로 입력
  }
  $('#shutter').onclick = shoot;
  document.addEventListener('keydown', e => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); shoot(); } });
  // 카메라가 없을 때: 사진을 골라 같은 띠 구간을 읽음
  $('#fileIn').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const img = new Image(); img.src = URL.createObjectURL(f);
    await img.decode().catch(() => {});
    const w = img.width * (st.x1 - st.x0), h = img.height * st.band, c = mk(w, h);
    c.getContext('2d').drawImage(img, img.width * st.x0, img.height * (0.5 - st.band / 2), w, h, 0, 0, w, h);
    pending++; setBusy(); chain = chain.then(() => process(c)).finally(() => { pending--; setBusy(); });
  };

  /* ---------------- 화면: 탭 / 메모장 / 엑셀 ---------------- */
  function setMode(m) {
    st.mode = m; save();
    document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#p-memo').hidden = m !== 'memo'; $('#p-excel').hidden = m !== 'excel';
    if (m === 'excel') renderGrid(true);
  }
  document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => setMode(b.dataset.mode); });

  const memo = $('#memo');
  function renderMemo() { memo.value = st.memo; memo.scrollTop = memo.scrollHeight; }
  memo.addEventListener('input', () => { st.memo = memo.value; save(); });
  $('#mNl').onclick = () => { st.memo += '\n'; renderMemo(); save(); };
  const copy = async txt => { try { await navigator.clipboard.writeText(txt); toast('복사했어요'); } catch { toast('복사하지 못했어요', 'bad'); } };
  const download = (blob, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };
  const stamp = () => { const d = new Date(), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
  $('#mCopy').onclick = () => copy(st.memo);
  $('#mSave').onclick = () => { if (!st.memo.trim()) return toast('저장할 글자가 없어요', 'bad'); download(new Blob(['﻿', st.memo], { type: 'text/plain;charset=utf-8' }), `메모_${stamp()}.txt`); };
  const memoClear = () => { if (st.memo && confirm('메모장을 모두 지울까요?')) { hist.push({ mode: 'memo', memo: st.memo }); st.memo = ''; renderMemo(); save(); } };

  const colName = i => String.fromCharCode(65 + i);
  function renderGrid(scroll) {
    fixGrid();
    const rows = Math.max(st.grid.length, st.cur.r + 1);
    let h = '<thead><tr><th class="rn"></th>' + Array.from({ length: st.cols }, (_, c) => `<th>${colName(c)}</th>`).join('') + '</tr></thead><tbody>';
    for (let r = 0; r < rows; r++) {
      h += `<tr><td class="rn">${r + 1}</td>` + Array.from({ length: st.cols }, (_, c) => `<td class="${st.cur.r === r && st.cur.c === c ? 'cur' : ''}"><input data-r="${r}" data-c="${c}" value="${(st.grid[r][c] || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" autocomplete="off"></td>`).join('') + '</tr>';
    }
    $('#grid').innerHTML = h + '</tbody>';
    syncDir();
    if (scroll) { const cur = $('#grid td.cur'); if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  $('#grid').addEventListener('input', e => { const t = e.target; if (t.dataset.r == null) return; st.grid[+t.dataset.r][+t.dataset.c] = t.value; save(); });
  $('#grid').addEventListener('focusin', e => {
    const t = e.target; if (t.dataset.r == null) return;
    st.cur = { r: +t.dataset.r, c: +t.dataset.c };
    document.querySelectorAll('#grid td.cur').forEach(x => x.classList.remove('cur')); t.parentElement.classList.add('cur'); save();
  });
  // 다음 칸 방향 선택 (아래 ↓ / 옆 →)
  function syncDir() { document.querySelectorAll('#eDirSeg button').forEach(b => b.classList.toggle('on', b.dataset.dir === st.dir)); }
  document.querySelectorAll('#eDirSeg button').forEach(b => { b.onclick = () => { st.dir = b.dataset.dir; syncDir(); save(); }; });
  $('#eNext').onclick = () => { st.cur.c = 0; st.cur.r++; ensureRow(st.cur.r); renderGrid(true); save(); };
  const gridRows = () => { const rows = st.grid.map(r => r.slice()); while (rows.length && rows[rows.length - 1].every(v => !v)) rows.pop(); return rows; };
  const eColP = () => { if (st.cols < 8) { st.cols++; renderGrid(); save(); } else toast('열은 최대 8개예요', 'bad'); };
  const eColM = () => { if (st.cols > 1) { st.cols--; renderGrid(); save(); } };
  const eCopy = () => copy(gridRows().map(r => r.join('\t')).join('\n'));
  const eClear = () => { if (confirm('엑셀 표를 모두 지울까요?')) { st.grid = [Array(st.cols).fill('')]; st.cur = { r: 0, c: 0 }; renderGrid(); save(); } };

  /* ---------------- ⋯ 더보기 (자주 안 쓰는 기능은 여기로) ---------------- */
  function openMore(kind) {
    const items = kind === 'memo'
      ? [{ t: '메모 전체 지우기', fn: memoClear, warn: 1 }]
      : [{ t: '표 복사', fn: eCopy }, { t: `열 추가 (지금 ${st.cols}열)`, fn: eColP }, { t: '열 줄이기', fn: eColM }, { t: '표 전체 지우기', fn: eClear, warn: 1 }];
    const card = $('#moreCard'); card.innerHTML = '';
    items.forEach(it => { const b = document.createElement('button'); b.textContent = it.t; if (it.warn) b.className = 'warn'; b.onclick = () => { $('#more').hidden = true; it.fn(); }; card.appendChild(b); });
    const c = document.createElement('button'); c.textContent = '닫기'; c.className = 'cancel'; c.onclick = () => { $('#more').hidden = true; }; card.appendChild(c);
    $('#more').hidden = false;
  }
  document.querySelectorAll('.more-btn').forEach(b => { b.onclick = () => openMore(b.dataset.more); });
  $('#more').addEventListener('click', e => { if (e.target.id === 'more') $('#more').hidden = true; });
  const loadXlsx = () => new Promise((res, rej) => { if (window.XLSX) return res(); const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const toCell = v => (/^-?[1-9]\d{0,14}(,\d{3})*(\.\d+)?$|^0(\.\d+)?$/.test(String(v).trim()) ? Number(String(v).replace(/,/g, '')) : v);
  $('#eSave').onclick = async () => {
    const rows = gridRows(); if (!rows.length) return toast('저장할 내용이 없어요', 'bad');
    try { await loadXlsx(); } catch { return toast('엑셀 기능을 불러오지 못했어요', 'bad'); }
    const wb = XLSX.utils.book_new(), ws = XLSX.utils.aoa_to_sheet(rows.map(r => r.map(toCell)));
    ws['!cols'] = Array.from({ length: st.cols }, (_, c) => ({ wch: Math.min(40, Math.max(8, ...rows.map(r => String(r[c] || '').length * 1.7))) }));
    XLSX.utils.book_append_sheet(wb, ws, '글자'); XLSX.writeFile(wb, `글자_${stamp()}.xlsx`);
  };

  /* ---------------- 시작 ---------------- */
  layoutBand(); renderMemo(); setMode(st.mode); syncOpts();
  startCam();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});
  window.__reader = { setCam: (t, c) => { track = t; caps = c; }, st, prepLine, recognize, grab, shoot, commit, finalize, raw: async c => { await readyP; return worker.recognize(c); } }; // 점검용
})();

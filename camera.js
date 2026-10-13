// 실시간 촬영 화면: 카메라 영상을 계속 분석해 읽을 수 있는 곳은 초록, 흐리거나 읽기 어려운 곳은 빨강 박스로 표시
(() => {
  const $ = s => document.querySelector(s);
  const video = $('#camVideo'), ov = $('#camOverlay'), stage = $('#camStage');
  const work = document.createElement('canvas');
  let stream = null, timer = null, shots = 0, state = null, pend = null, pendN = 0;

  async function open() {
    if (!cur) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return $('#camInput').click();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) { return $('#camInput').click(); } // 권한 거부·카메라 없음 → 기본 촬영(파일 선택)으로
    video.srcObject = stream;
    await video.play().catch(() => {});
    $('#cam').hidden = false; document.body.style.overflow = 'hidden';
    shots = 0; state = null; count(); loop();
  }
  function close() {
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    $('#cam').hidden = true; document.body.style.overflow = '';
  }
  const count = () => { $('#camCount').textContent = `${shots}장 촬영`; };

  function loop() {
    timer = setTimeout(loop, 170);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    const aw = Math.min(640, vw), ah = Math.round(vh * aw / vw);
    work.width = aw; work.height = ah;
    const g = work.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, aw, ah);
    const r = GSImg.tileAnalyze(g.getImageData(0, 0, aw, ah).data, aw, ah, { minGrad: 45 });
    draw(r, aw, ah, vw, vh); judge(r);
  }

  function draw(r, aw, ah, vw, vh) {
    const cw = stage.clientWidth, ch = stage.clientHeight;
    if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
    const k = Math.min(cw / vw, ch / vh), ox = (cw - vw * k) / 2, oy = (ch - vh * k) / 2, s = vw / aw * k;
    const g = ov.getContext('2d');
    g.clearRect(0, 0, cw, ch);
    const box = (b, fill, line) => {
      g.fillStyle = fill; g.strokeStyle = line; g.lineWidth = 2;
      const x = ox + b.x0 * s, y = oy + b.y0 * s, w = (b.x1 - b.x0) * s, h = (b.y1 - b.y0) * s;
      g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h);
    };
    r.ok.forEach(b => box(b, 'rgba(34,197,94,.26)', 'rgba(34,197,94,.95)'));
    r.bad.forEach(b => box(b, 'rgba(239,68,68,.34)', 'rgba(239,68,68,.95)'));
  }

  // 상태 판정 (같은 판정이 2번 이어질 때만 바꿔 깜빡임 방지)
  function judge(r) {
    let s;
    const frac = r.ink ? r.badTiles / r.ink : 0;
    if (r.mean < 55) s = ['bad', '너무 어두워요 · 조명을 켜 주세요 (촬영 후 밝기는 자동 보정돼요)'];
    else if (r.mean > 246) s = ['bad', '너무 밝아요 · 빛 반사를 피해 주세요'];
    else if (r.ink < 6) s = ['bad', '글자가 보이지 않아요 · 글자 쪽으로 가까이 가 주세요'];
    else if (frac > 0.35) s = ['bad', '흐려요 · 초점이 맞을 때까지 멈춰 주세요'];
    else if (frac > 0.12) s = ['bad', '일부가 흐려요 · 빨간 부분이 선명해지게 해 주세요'];
    else s = ['ok', '✓ 인식할 수 있어요 · 촬영하세요'];
    const key = s[0] + s[1];
    if (!state) apply(s, key);
    else if (key !== state) { if (pend === key) { if (++pendN >= 2) apply(s, key); } else { pend = key; pendN = 1; } }
    else { pend = null; pendN = 0; }
  }
  function apply(s, key) {
    state = key; pend = null; pendN = 0;
    const el = $('#camStatus'); el.textContent = s[1]; el.className = 'camstatus ' + s[0];
    $('#camShot').className = 'camshot ' + s[0];
  }

  async function shot() {
    const vw = video.videoWidth; if (!vw) return;
    const c = GSImg.mk(vw, video.videoHeight);
    c.getContext('2d').drawImage(video, 0, 0);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    const f = $('#camFlash'); f.classList.add('on'); setTimeout(() => f.classList.remove('on'), 120);
    addFiles([new File([blob], 'camera.jpg', { type: 'image/jpeg' })]);
    shots++; count();
  }
  $('#camBtn').onclick = open;
  $('#camShot').onclick = shot;
  $('#camDone').onclick = close;
  document.addEventListener('keydown', e => { if (!$('#cam').hidden && e.key === 'Escape') close(); });
})();

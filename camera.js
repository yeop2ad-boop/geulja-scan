// 실시간 촬영 화면: 종이 끝단(사각형) + 밝기 / 초점 / 각도를 계속 점검하고, 모두 괜찮으면 OK 사인을 표시
(() => {
  const $ = s => document.querySelector(s);
  const video = $('#camVideo'), ov = $('#camOverlay'), stage = $('#camStage');
  const work = document.createElement('canvas');
  let stream = null, timer = null, shots = 0, state = null, pend = null, pendN = 0;
  let quad = null, miss = 0, steady = 0, tilt = 0, frame = 0, textSkew = 0;
  const MAX_ROT = 15, MAX_PERSP = 28; // 이보다 기울면 "너무 기울었어요" (도, 근사값)

  async function open() {
    if (!cur) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return $('#camInput').click();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) { return $('#camInput').click(); } // 권한 거부·카메라 없음 → 기본 촬영(파일 선택)으로
    video.srcObject = stream;
    await video.play().catch(() => {});
    $('#cam').hidden = false; document.body.style.overflow = 'hidden';
    shots = 0; state = null; quad = null; miss = 0; steady = 0; tilt = 0; frame = 0; textSkew = 0; count(); loop();
  }
  function close() {
    clearTimeout(timer); timer = null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = null; video.srcObject = null;
    $('#cam').hidden = true; document.body.style.overflow = '';
  }
  const count = () => { $('#camCount').textContent = `${shots}장 촬영`; };

  // 종이 모서리에서 기울기 계산: rot = 글줄 방향 회전각, persp = 비스듬히 본 정도(윗변·아랫변 길이 차)
  function geom(q) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const top = d(q[0], q[1]), bot = d(q[3], q[2]), lef = d(q[0], q[3]), rig = d(q[1], q[2]);
    let rot = (Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x) + Math.atan2(q[2].y - q[3].y, q[2].x - q[3].x)) / 2 * 180 / Math.PI;
    while (rot > 45) rot -= 90; while (rot < -45) rot += 90;
    const r = Math.min(Math.min(top, bot) / Math.max(top, bot), Math.min(lef, rig) / Math.max(lef, rig));
    return { rot, persp: Math.acos(Math.min(1, r)) * 180 / Math.PI };
  }

  function loop() {
    timer = setTimeout(loop, 170);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw) return;
    frame++;
    const aw = Math.min(640, vw), ah = Math.round(vh * aw / vw);
    work.width = aw; work.height = ah;
    const g = work.getContext('2d', { willReadFrequently: true });
    g.drawImage(video, 0, 0, aw, ah);
    const r = GSImg.tileAnalyze(g.getImageData(0, 0, aw, ah).data, aw, ah, { minGrad: 45 });

    // 종이 끝단: 찾은 모서리를 이전 프레임과 섞어 떨림을 줄이고, 거의 안 움직이면 "안정"
    const q = GSImg.detectPaper(work);
    if (q) {
      miss = 0;
      if (quad) {
        const jit = q.reduce((s, p, i) => s + Math.hypot(p.x - quad[i].x, p.y - quad[i].y), 0) / 4 / aw;
        quad = quad.map((p, i) => ({ x: p.x * 0.55 + q[i].x * 0.45, y: p.y * 0.55 + q[i].y * 0.45 }));
        steady = jit < 0.015 ? steady + 1 : 0;
      } else { quad = q; steady = 0; }
    } else if (++miss >= 3) { quad = null; steady = 0; }

    // 각도: 종이 모서리가 있으면 거기서, 없으면 글줄 기울기(가끔 계산)
    let rot = 0, persp = 0, hasAngle = false;
    if (quad) { const gm = geom(quad); rot = gm.rot; persp = gm.persp; hasAngle = true; }
    else if (r.ink >= 6) { if (frame % 6 === 1) textSkew = GSImg.estimateSkew(work); rot = textSkew; hasAngle = true; }
    const t = Math.max(Math.abs(rot), persp);
    tilt = tilt * 0.5 + t * 0.5;
    const angle = !hasAngle ? 'none' : (Math.abs(rot) > MAX_ROT || persp > MAX_PERSP) ? 'bad' : 'ok';

    const edge = quad ? (steady >= 3 ? 'ok' : 'wait') : 'none';
    const frac = r.ink ? r.badTiles / r.ink : 0;
    const focus = r.ink < 6 ? 'text' : frac <= 0.12 ? 'ok' : 'bad';
    const light = r.mean < 65 ? 'dark' : r.mean > 246 ? 'bright' : 'ok';
    const view = { edge, focus, light, angle, tilt: Math.round(tilt) };
    draw(quad, view, aw, ah, vw, vh);
    judge(view);
  }

  const allOk = v => v.light === 'ok' && v.focus === 'ok' && v.angle !== 'bad' && v.edge !== 'wait';

  function draw(q, v, aw, ah, vw, vh) {
    const cw = stage.clientWidth, ch = stage.clientHeight;
    if (ov.width !== cw || ov.height !== ch) { ov.width = cw; ov.height = ch; }
    const k = Math.min(cw / vw, ch / vh), ox = (cw - vw * k) / 2, oy = (ch - vh * k) / 2, s = vw / aw * k;
    const g = ov.getContext('2d');
    g.clearRect(0, 0, cw, ch);
    const good = allOk(v), col = good ? '#22c55e' : v.angle === 'bad' ? '#f59e0b' : '#ffffff';
    if (q) {
      const P = q.map(p => ({ x: ox + p.x * s, y: oy + p.y * s }));
      g.beginPath(); P.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath();
      g.fillStyle = good ? 'rgba(34,197,94,.14)' : 'rgba(255,255,255,.07)'; g.fill();
      g.strokeStyle = v.edge === 'ok' ? col : 'rgba(255,255,255,.55)'; g.lineWidth = v.edge === 'ok' ? 3 : 2; g.setLineDash(v.edge === 'ok' ? [] : [8, 7]); g.stroke(); g.setLineDash([]);
      // 모서리 꺾쇠(촬영 끝단 표시)
      g.strokeStyle = col; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
      const L = 26;
      P.forEach((p, i) => {
        const a = P[(i + 3) % 4], b = P[(i + 1) % 4], u = n => { const d = Math.hypot(n.x - p.x, n.y - p.y) || 1; return { x: (n.x - p.x) / d * L, y: (n.y - p.y) / d * L }; };
        const ua = u(a), ub = u(b);
        g.beginPath(); g.moveTo(p.x + ua.x, p.y + ua.y); g.lineTo(p.x, p.y); g.lineTo(p.x + ub.x, p.y + ub.y); g.stroke();
      });
    }
    // 초점 표시: 화면 가운데 링 (초점이 맞으면 초록 ✓)
    const cx = cw / 2, cy = ch / 2, R = 34;
    g.lineWidth = 3; g.lineCap = 'round';
    if (v.focus === 'ok') {
      g.strokeStyle = '#22c55e'; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 6; g.beginPath(); g.moveTo(cx - 13, cy + 1); g.lineTo(cx - 3, cy + 11); g.lineTo(cx + 15, cy - 11); g.stroke();
    } else {
      g.strokeStyle = 'rgba(255,255,255,.75)'; g.setLineDash([6, 8]);
      g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      g.lineWidth = 2; [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => { g.beginPath(); g.moveTo(cx + dx * (R - 6), cy + dy * (R - 6)); g.lineTo(cx + dx * (R + 8), cy + dy * (R + 8)); g.stroke(); });
    }
  }

  // 상태 판정 (같은 판정이 2번 이어질 때만 바꿔 깜빡임 방지)
  function judge(v) {
    let msg, cls = 'wait';
    if (v.light === 'dark') { msg = '너무 어두워요 · 조명을 켜 주세요 (촬영 후 밝기는 자동 보정돼요)'; cls = 'warn'; }
    else if (v.light === 'bright') { msg = '너무 밝아요 · 빛 반사를 피해 주세요'; cls = 'warn'; }
    else if (v.focus === 'bad') { msg = '초점이 안 맞아요 · 멈추고 살짝 거리를 조절해 주세요'; cls = 'warn'; }
    else if (v.angle === 'bad') { msg = `각도가 너무 기울었어요 (${v.tilt}°) · 종이와 평행하게 들어 주세요`; cls = 'warn'; }
    else if (v.focus === 'text') msg = '글자가 보이게 가까이 비춰 주세요';
    else if (v.edge === 'none') msg = '종이 전체가 화면에 들어오게 비춰 주세요';
    else if (v.edge === 'wait') msg = '종이 가장자리를 맞추는 중이에요 · 잠시 멈춰 주세요';
    else { msg = '✓ OK · 촬영하세요'; cls = 'ok'; }
    const key = `${v.edge}|${v.focus}|${v.light}|${v.angle}|${v.angle === 'bad' ? Math.floor(v.tilt / 3) : ''}`;
    if (!state) apply(v, key, msg, cls);
    else if (key !== state) { if (pend === key) { if (++pendN >= 2) apply(v, key, msg, cls); } else { pend = key; pendN = 1; } }
    else { pend = null; pendN = 0; }
  }
  function chip(id, text, on, bad) { const el = $(id); el.textContent = text; el.className = 'chip2' + (on ? ' on' : bad ? ' bad' : ''); }
  function apply(v, key, msg, cls) {
    state = key; pend = null; pendN = 0;
    const el = $('#camStatus'); el.textContent = msg; el.className = 'camstatus ' + cls;
    chip('#chipEdge', v.edge === 'ok' ? '▢ 가장자리 OK' : v.edge === 'wait' ? '▢ 가장자리 맞추는 중' : '▢ 가장자리 못 찾음', v.edge === 'ok');
    chip('#chipFocus', v.focus === 'ok' ? '◎ 초점 OK' : v.focus === 'bad' ? '◎ 초점이 안 맞아요' : '◎ 글자를 비춰 주세요', v.focus === 'ok', v.focus === 'bad');
    chip('#chipLight', v.light === 'ok' ? '☀ 밝기 OK' : v.light === 'dark' ? '☀ 너무 어두워요' : '☀ 너무 밝아요', v.light === 'ok', v.light !== 'ok');
    chip('#chipAngle', v.angle === 'none' ? '∠ 각도 확인 중' : v.angle === 'ok' ? `∠ 각도 OK · ${v.tilt}°` : `∠ 너무 기울었어요 · ${v.tilt}°`, v.angle === 'ok', v.angle === 'bad');
    $('#camOk').hidden = !(allOk(v) && v.edge === 'ok');
    $('#camShot').className = 'camshot ' + (allOk(v) && v.edge === 'ok' ? 'ok' : '');
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

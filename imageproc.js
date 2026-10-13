// 이미지 보정 모듈: 기울기(회전) / 원근(사선) / 조명 / 종이 모서리 감지 / 선명도(타일) 분석
(function (root) {
  'use strict';
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
  const gray = (r, g, b) => (77 * r + 150 * g + 29 * b) >> 8;

  function scaled(src, maxDim) {
    const k = Math.min(1, maxDim / Math.max(src.width, src.height));
    const c = mk(src.width * k, src.height * k);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(src, 0, 0, c.width, c.height);
    return { c, g, k };
  }
  function grayArr(c, g) {
    const w = c.width, h = c.height, d = g.getImageData(0, 0, w, h).data, a = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < a.length; i += 4, j++) a[j] = gray(d[i], d[i + 1], d[i + 2]);
    return a;
  }

  // ---------- 1) 글줄 기울기 추정 (투영 프로파일) ----------
  // 반환: 글줄이 시계방향으로 기울어진 각도(도). 이미지를 -각도만큼 돌리면 반듯해짐
  function estimateSkew(src) {
    const { c, g } = scaled(src, 700), w = c.width, h = c.height, a = grayArr(c, g);
    const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += a[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
    const r = 10, xs = [], ys = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      const m = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0));
      if (a[y * w + x] < m - 25) { xs.push(x); ys.push(y); }
    }
    if (xs.length < 400) return 0;
    const step = Math.ceil(xs.length / 25000), off = w + 2, bins = new Float32Array(h + w + 4);
    const score = deg => {
      const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t);
      bins.fill(0);
      for (let i = 0; i < xs.length; i += step) bins[(ys[i] * cs - xs[i] * sn + off) | 0]++;
      let s = 0; for (let i = 0; i < bins.length; i++) s += bins[i] * bins[i];
      return s;
    };
    let best = 0, bs = -1;
    for (let d = -20; d <= 20; d += 1) { const s = score(d); if (s > bs) { bs = s; best = d; } }
    for (let d = best - 1; d <= best + 1; d += 0.2) { const s = score(d); if (s > bs) { bs = s; best = d; } }
    return bs > score(0) * 1.04 ? Math.round(best * 10) / 10 : 0;
  }

  function rotate(src, deg) {
    const t = deg * Math.PI / 180, cs = Math.abs(Math.cos(t)), sn = Math.abs(Math.sin(t));
    const nw = src.width * cs + src.height * sn, nh = src.width * sn + src.height * cs;
    const k = Math.min(1, 2600 / Math.max(nw, nh)), c = mk(nw * k, nh * k), g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.translate(c.width / 2, c.height / 2); g.rotate(t); g.scale(k, k);
    g.drawImage(src, -src.width / 2, -src.height / 2);
    return c;
  }

  // ---------- 2) 원근(사선) 보정 ----------
  function solveH(dst, src) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = dst[i], { x: u, y: v } = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]); A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (let c = 0; c < 8; c++) {
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]];
      const d = A[c][c]; if (Math.abs(d) < 1e-12) return null;
      for (let k = c; k < 9; k++) A[c][k] /= d;
      for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c]; if (f) for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k]; }
    }
    return A.map(r => r[8]);
  }
  // pts: [TL, TR, BR, BL] (src 픽셀 좌표)
  function warp(src, pts) {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(d(pts[0], pts[1]), d(pts[3], pts[2])), H = Math.max(d(pts[0], pts[3]), d(pts[1], pts[2]));
    const k = Math.min(1, 2200 / Math.max(W, H)); W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
    const h = solveH([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], pts);
    if (!h) return src;
    const sw = src.width, sh = src.height, sd = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = mk(W, H), og = out.getContext('2d'), od = og.createImageData(W, H), o = od.data;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const den = h[6] * x + h[7] * y + 1;
      let u = (h[0] * x + h[1] * y + h[2]) / den, v = (h[3] * x + h[4] * y + h[5]) / den;
      u = u < 0 ? 0 : u > sw - 1.001 ? sw - 1.001 : u; v = v < 0 ? 0 : v > sh - 1.001 ? sh - 1.001 : v;
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0, i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4, oi = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) o[oi + c] = sd[i00 + c] * (1 - fx) * (1 - fy) + sd[i10 + c] * fx * (1 - fy) + sd[i01 + c] * (1 - fx) * fy + sd[i11 + c] * fx * fy;
      o[oi + 3] = 255;
    }
    og.putImageData(od, 0, 0);
    return out;
  }

  // ---------- 3) 종이 모서리 자동 감지 (밝은 종이 + 어두운 배경) ----------
  function otsu(a) {
    const hist = new Float64Array(256); for (let i = 0; i < a.length; i++) hist[a[i]]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let wB = 0, sB = 0, best = 0, th = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue; const wF = a.length - wB; if (!wF) break;
      sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; th = t; }
    }
    return th;
  }
  // 반환: [TL,TR,BR,BL] (src 픽셀 좌표) 또는 null
  function detectPaper(src) {
    const { c, g, k } = scaled(src, 360), w = c.width, h = c.height, a = grayArr(c, g), th = otsu(a);
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    let bestArea = 0, bestPts = null, id = 0;
    for (let s = 0; s < a.length; s++) {
      if (lab[s] || a[s] <= th) continue;
      id++; let sp = 0, area = 0, tl = [1e9, 0, 0], tr = [-1e9, 0, 0], br = [-1e9, 0, 0], bl = [1e9, 0, 0];
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i / w) | 0; area++;
        const sm = x + y, df = x - y;
        if (sm < tl[0]) tl = [sm, x, y]; if (sm > br[0]) br = [sm, x, y]; if (df > tr[0]) tr = [df, x, y]; if (df < bl[0]) bl = [df, x, y];
        if (x > 0 && !lab[i - 1] && a[i - 1] > th) { lab[i - 1] = id; stack[sp++] = i - 1; }
        if (x < w - 1 && !lab[i + 1] && a[i + 1] > th) { lab[i + 1] = id; stack[sp++] = i + 1; }
        if (y > 0 && !lab[i - w] && a[i - w] > th) { lab[i - w] = id; stack[sp++] = i - w; }
        if (y < h - 1 && !lab[i + w] && a[i + w] > th) { lab[i + w] = id; stack[sp++] = i + w; }
      }
      if (area > bestArea) { bestArea = area; bestPts = [tl, tr, br, bl]; }
    }
    const f = bestArea / (w * h);
    if (!bestPts || f < 0.25 || f > 0.97) return null;
    const p = bestPts.map(q => ({ x: q[1], y: q[2] }));
    let qa = 0; for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; qa += p[i].x * p[j].y - p[j].x * p[i].y; }
    qa = Math.abs(qa) / 2;
    const ratio = bestArea / qa;
    if (!qa || ratio < 0.72 || ratio > 1.05) return null; // 사각형 모양이 아니면 신뢰 안 함
    return p.map(q => ({ x: (q.x + 0.5) / k, y: (q.y + 0.5) / k }));
  }
  // 사각형이 반듯하면(회전·원근 없음) 굳이 펴지 않음
  function needsWarp(p, w, h) {
    const minX = Math.min(...p.map(q => q.x)), maxX = Math.max(...p.map(q => q.x)), minY = Math.min(...p.map(q => q.y)), maxY = Math.max(...p.map(q => q.y));
    const dev = Math.max(Math.abs(p[0].x - minX), Math.abs(p[3].x - minX), Math.abs(p[1].x - maxX), Math.abs(p[2].x - maxX),
      Math.abs(p[0].y - minY), Math.abs(p[1].y - minY), Math.abs(p[3].y - maxY), Math.abs(p[2].y - maxY));
    return dev / Math.max(w, h) > 0.02;
  }

  // ---------- 4) 조명 보정 (그림자·어두움·과노출) ----------
  function maxF(a, w, h, r) { const o = new Float32Array(a.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; const v = a[yy * w + xx]; if (v > m) m = v; } } o[y * w + x] = m; } return o; }
  function boxF(a, w, h, r) { const o = new Float32Array(a.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0, n = 0; for (let dy = -r; dy <= r; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -r; dx <= r; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += a[yy * w + xx]; n++; } } o[y * w + x] = s / n; } return o; }
  const pct = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

  // 반환 { canvas, note } — 보정이 필요 없으면 원본 그대로, note=''
  function normalizeLight(src) {
    const { c, g } = scaled(src, 260), sw = c.width, sh = c.height, small = grayArr(c, g);
    const bg = boxF(maxF(small, sw, sh, 2), sw, sh, 2); // 종이(배경) 밝기 지도
    const bm = bg.reduce((s, v) => s + v, 0) / bg.length, lo = pct(bg, 0.05), hi = pct(bg, 0.95);
    const rg = pct(small, 0.98) - pct(small, 0.02);
    const uneven = hi / Math.max(lo, 1) > 1.35;
    if (bm > 95 && !uneven && rg > 110 && !(bm >= 242 && rg < 150)) return { canvas: src, note: '' };
    const note = bm <= 95 ? '어두운 사진을 밝게 보정했어요' : bm >= 242 ? '너무 밝은 사진을 보정했어요' : uneven ? '그림자·조명 차이를 보정했어요' : '대비를 보정했어요';
    // 배경 지도를 원본 크기로 확대
    const bc = mk(sw, sh), bgx = bc.getContext('2d'), bd = bgx.createImageData(sw, sh);
    for (let i = 0; i < bg.length; i++) { const v = Math.max(1, Math.min(255, bg[i])); bd.data[i * 4] = bd.data[i * 4 + 1] = bd.data[i * 4 + 2] = v; bd.data[i * 4 + 3] = 255; }
    bgx.putImageData(bd, 0, 0);
    const W = src.width, H = src.height, big = mk(W, H), bg2 = big.getContext('2d', { willReadFrequently: true });
    bg2.imageSmoothingEnabled = true; bg2.imageSmoothingQuality = 'high'; bg2.drawImage(bc, 0, 0, W, H);
    const bgd = bg2.getImageData(0, 0, W, H).data;
    const out = mk(W, H), og = out.getContext('2d', { willReadFrequently: true });
    og.drawImage(src, 0, 0);
    const id = og.getImageData(0, 0, W, H), d = id.data, hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
      const f = Math.min(4, Math.max(0.6, 238 / Math.max(bgd[i], 18)));
      d[i] = Math.min(255, d[i] * f); d[i + 1] = Math.min(255, d[i + 1] * f); d[i + 2] = Math.min(255, d[i + 2] * f);
      hist[gray(d[i], d[i + 1], d[i + 2])]++;
    }
    // 밝기 범위 늘리기(1%~99%)
    const tot = W * H; let acc = 0, p1 = 0, p99 = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc < tot * 0.01) p1 = v; if (acc < tot * 0.99) p99 = v; }
    const span = Math.max(40, p99 - p1), sc = 255 / span;
    for (let i = 0; i < d.length; i += 4) { d[i] = Math.max(0, Math.min(255, (d[i] - p1) * sc)); d[i + 1] = Math.max(0, Math.min(255, (d[i + 1] - p1) * sc)); d[i + 2] = Math.max(0, Math.min(255, (d[i + 2] - p1) * sc)); }
    og.putImageData(id, 0, 0);
    return { canvas: out, note };
  }

  // ---------- 5) 선명도 타일 분석 (사진 후처리 + 실시간 카메라 공용) ----------
  // 글자(대비)가 있는 칸 중 경계가 뭉개진 칸 = bad(흐림), 선명한 칸 = ok(인식 가능)
  function cluster(flag, gx, gy, T, w, h, minN) {
    const seen = new Uint8Array(gx * gy), out = [];
    for (let s = 0; s < flag.length; s++) {
      if (!flag[s] || seen[s]) continue;
      const st = [s]; seen[s] = 1; let x0 = gx, y0 = gy, x1 = 0, y1 = 0, n = 0;
      while (st.length) {
        const i = st.pop(), x = i % gx, y = (i / gx) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= gx || ny >= gy) continue;
          const j = ny * gx + nx; if (flag[j] && !seen[j]) { seen[j] = 1; st.push(j); }
        }
      }
      if (n >= minN) out.push({ x0: x0 * T, y0: y0 * T, x1: Math.min(w, (x1 + 1) * T), y1: Math.min(h, (y1 + 1) * T), n });
    }
    return out;
  }
  function tileAnalyze(data, w, h, o) {
    o = Object.assign({ minRange: 80, minGrad: 55, rel: 0.45, minOk: 3, minBad: 2 }, o);
    const g = new Uint8Array(w * h); let msum = 0, mn = 0;
    for (let i = 0, j = 0; j < g.length; i += 4, j++) { g[j] = gray(data[i], data[i + 1], data[i + 2]); if (j % 7 === 0) { msum += g[j]; mn++; } }
    const T = Math.max(10, Math.round(Math.max(w, h) / 55)), gx = Math.ceil(w / T), gy = Math.ceil(h / T);
    const rng = new Float32Array(gx * gy), grad = new Float32Array(gx * gy);
    for (let ty = 0; ty < gy; ty++) for (let tx = 0; tx < gx; tx++) {
      let lo = 255, hi = 0, gm = 0;
      const x1 = Math.min(w - 1, (tx + 1) * T), y1 = Math.min(h - 1, (ty + 1) * T);
      for (let y = ty * T; y < y1; y++) for (let x = tx * T; x < x1; x++) {
        const v = g[y * w + x]; if (v < lo) lo = v; if (v > hi) hi = v;
        const dx = Math.abs(v - g[y * w + x + 1]), dy = Math.abs(v - g[(y + 1) * w + x]); if (dx > gm) gm = dx; if (dy > gm) gm = dy;
      }
      rng[ty * gx + tx] = hi - lo; grad[ty * gx + tx] = gm;
    }
    const ink = [...grad.keys()].filter(i => rng[i] > o.minRange);
    const res = { ok: [], bad: [], ink: ink.length, tiles: gx * gy, badTiles: 0, mean: msum / Math.max(1, mn) };
    if (ink.length < 4) return res;
    const sorted = ink.map(i => grad[i]).sort((a, b) => a - b), med = sorted[sorted.length >> 1];
    const bad = new Uint8Array(gx * gy), okf = new Uint8Array(gx * gy);
    ink.forEach(i => { if (grad[i] < med * o.rel || grad[i] < o.minGrad) { bad[i] = 1; res.badTiles++; } else okf[i] = 1; });
    res.bad = cluster(bad, gx, gy, T, w, h, o.minBad); res.ok = cluster(okf, gx, gy, T, w, h, o.minOk);
    return res;
  }

  root.GSImg = { estimateSkew, rotate, warp, detectPaper, needsWarp, normalizeLight, tileAnalyze, mk };
})(window);

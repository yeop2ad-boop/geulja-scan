// 글자 스타일 분석: 단어마다 실제 글자 색과 크기를 재서, 같은 색·같은 크기의 글자끼리 묶어 읽는다
(function (root) {
  'use strict';
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

  // 박스 안의 "잉크(글자) 색": 바탕색에서 멀리 떨어진 픽셀의 평균
  function inkColor(d, W, H, b) {
    const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(W - 1, Math.ceil(b.x1)), y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(H - 1, Math.ceil(b.y1));
    if (x1 <= x0 || y1 <= y0) return null;
    // 바탕색: 박스 바로 바깥 위·아래 띠의 평균
    let br = 0, bg = 0, bb = 0, bn = 0;
    const ring = (y) => { if (y < 0 || y >= H) return; for (let x = x0; x <= x1; x += 2) { const i = (y * W + x) * 4; br += d[i]; bg += d[i + 1]; bb += d[i + 2]; bn++; } };
    ring(y0 - 3); ring(y0 - 2); ring(y1 + 2); ring(y1 + 3);
    if (!bn) { const i = (y0 * W + x0) * 4; br = d[i]; bg = d[i + 1]; bb = d[i + 2]; bn = 1; }
    br /= bn; bg /= bn; bb /= bn;
    const px = [], step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 600)));
    for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
      const i = (y * W + x) * 4, dr = d[i] - br, dg = d[i + 1] - bg, db = d[i + 2] - bb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist > 55) px.push([dist, d[i], d[i + 1], d[i + 2]]);
    }
    if (px.length < 4) return { r: 20, g: 20, b: 20, bg: [br, bg, bb] };
    px.sort((p, q) => q[0] - p[0]);
    const core = px.slice(0, Math.max(3, Math.ceil(px.length * 0.4)));
    const m = [0, 0, 0]; core.forEach(p => { m[0] += p[1]; m[1] += p[2]; m[2] += p[3]; });
    return { r: m[0] / core.length, g: m[1] / core.length, b: m[2] / core.length, bg: [br, bg, bb] };
  }

  function colorName(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx, s = mx ? (mx - mn) / mx : 0;
    let h = 0;
    if (mx !== mn) { const d = mx - mn; h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; if (h < 0) h += 360; }
    const bgLum = (0.299 * c.bg[0] + 0.587 * c.bg[1] + 0.114 * c.bg[2]) / 255;
    if (s < 0.28) {
      if (v > 0.8 && bgLum < 0.5) return '흰색';
      return v < 0.42 ? '검정' : '회색';
    }
    if (h < 15 || h >= 345) return '빨강';
    if (h < 40) return '주황';
    if (h < 70) return '노랑';
    if (h < 170) return '초록';
    if (h < 200) return '청록';
    if (h < 260) return '파랑';
    if (h < 300) return '보라';
    return '분홍';
  }
  const hex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const SIZE = ['작은 글자', '보통 글자', '큰 글자', '아주 큰 글자'];
  const sizeClass = ratio => (ratio < 0.62 ? 0 : ratio < 1.45 ? 1 : ratio < 2.2 ? 2 : 3);

  // words: [{text,x0,y0,x1,y1}], colorCanvas: 보정된 컬러 사진(단어 좌표와 같은 크기)
  function classify(words, colorCanvas) {
    if (!words.length) return [];
    const W = colorCanvas.width, H = colorCanvas.height;
    const d = colorCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    const medH = median(words.map(w => w.y1 - w.y0)) || 10;
    // 1) 단어마다 글자 색
    const info = words.map(w => {
      const ink = inkColor(d, W, H, w) || { r: 20, g: 20, b: 20, bg: [255, 255, 255] };
      return { w, ink, color: w.cn || colorName(ink) };
    });
    // 2) 크기는 단어 하나가 아니라 "같은 색의 같은 줄" 전체의 대표 높이로 판정 (낱글자 상자의 들쭉날쭉함 방지)
    const byColor = new Map();
    info.forEach(o => { if (!byColor.has(o.color)) byColor.set(o.color, []); byColor.get(o.color).push(o); });
    byColor.forEach(list => {
      list.sort((a, b) => (a.w.y0 + a.w.y1) - (b.w.y0 + b.w.y1));
      let line = [];
      const flush = () => { const h = median(line.map(o => o.w.y1 - o.w.y0)); line.forEach(o => { o.size = sizeClass(h / medH); }); line = []; };
      list.forEach(o => {
        const yc = (o.w.y0 + o.w.y1) / 2;
        if (line.length && Math.abs(yc - line.yc) > medH * 0.7) flush();
        line.yc = line.length ? (line.yc * line.length + yc) / (line.length + 1) : yc; line.push(o);
      });
      if (line.length) flush();
    });
    // 3) 같은 색 + 같은 크기끼리 묶기
    const groups = new Map();
    info.forEach(({ w, ink, color, size }) => {
      const key = color + '|' + size;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { key, color, size, sizeName: SIZE[size], hexSum: [0, 0, 0], words: [] });
      g.hexSum[0] += ink.r; g.hexSum[1] += ink.g; g.hexSum[2] += ink.b; g.words.push(w);
    });
    return [...groups.values()].map(g => {
      const n = g.words.length, ws = [...g.words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
      // 같은 스타일 글자를 줄로 묶기 (읽는 순서: 위→아래, 왼→오른)
      const lines = [];
      ws.forEach(w => {
        const yc = (w.y0 + w.y1) / 2, ln = lines[lines.length - 1];
        if (ln && Math.abs(yc - ln.yc) <= medH * 0.6) { ln.ws.push(w); ln.yc = (ln.yc * (ln.ws.length - 1) + yc) / ln.ws.length; }
        else lines.push({ ws: [w], yc });
      });
      const boxes = lines.map(ln => { ln.ws.sort((a, b) => a.x0 - b.x0); return { x0: Math.min(...ln.ws.map(w => w.x0)), y0: Math.min(...ln.ws.map(w => w.y0)), x1: Math.max(...ln.ws.map(w => w.x1)), y1: Math.max(...ln.ws.map(w => w.y1)) }; });
      return {
        key: g.key, color: g.color, size: g.size, name: `${g.color} · ${g.sizeName}`, hex: hex({ r: g.hexSum[0] / n, g: g.hexSum[1] / n, b: g.hexSum[2] / n }),
        count: n, lines: lines.map(ln => ln.ws.map(w => w.text.trim()).join(' ')).slice(0, 200), boxes: boxes.slice(0, 80)
      };
    }).sort((a, b) => b.count - a.count);
  }

  root.GSStyle = { classify, colorName };
})(window);

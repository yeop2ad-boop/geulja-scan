// 패턴 분석: OCR 단어(글자+위치) → 구간별 표
// words: [{text, x0, y0, x1, y1}]  →  { sections:[{type,title,headers,rows,note}], repeats:[{text,count}] }
(function (root) {
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const isNum = t => /^[-+₩$]?[\d,.]+\s*(원|%|개|건|명|kg|g|ml|L)?$/.test(String(t).trim());
  const norm = t => String(t).replace(/[\d\s,.:：()\-_/]/g, '');

  function buildLines(words, medH) {
    const ws = [...words].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    const lines = [];
    for (const w of ws) {
      const yc = (w.y0 + w.y1) / 2;
      let ln = lines.length ? lines[lines.length - 1] : null;
      if (ln && Math.abs(yc - ln.yc) <= medH * 0.6) {
        ln.words.push(w); ln.yc = (ln.yc * (ln.words.length - 1) + yc) / ln.words.length;
        ln.y0 = Math.min(ln.y0, w.y0); ln.y1 = Math.max(ln.y1, w.y1);
      } else lines.push({ words: [w], yc, y0: w.y0, y1: w.y1 });
    }
    for (const ln of lines) {
      ln.words.sort((a, b) => a.x0 - b.x0);
      const cells = [];
      for (const w of ln.words) {
        const c = cells[cells.length - 1];
        if (c && w.x0 - c.x1 <= medH * 1.2) { c.text += ' ' + w.text.trim(); c.x1 = Math.max(c.x1, w.x1); }
        else cells.push({ text: w.text.trim(), x0: w.x0, x1: w.x1 });
      }
      ln.cells = cells;
    }
    return lines;
  }

  // 표 구간의 세로 빈칸을 기준으로 열(band) 계산
  function buildBands(lines, medH) {
    const iv = [];
    for (const ln of lines) if (ln.cells.length >= 2) for (const c of ln.cells) iv.push([c.x0, c.x1]);
    iv.sort((a, b) => a[0] - b[0]);
    const bands = [];
    for (const [a, b] of iv) {
      const last = bands[bands.length - 1];
      if (last && a <= last[1] + medH * 0.3) last[1] = Math.max(last[1], b);
      else bands.push([a, b]);
    }
    return bands;
  }

  function bandOf(bands, c) {
    const xc = (c.x0 + c.x1) / 2;
    let best = 0, bd = Infinity;
    bands.forEach((b, i) => {
      const d = xc >= b[0] && xc <= b[1] ? 0 : Math.min(Math.abs(xc - b[0]), Math.abs(xc - b[1]));
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  // [{k,v}] 목록에서 첫 항목명이 반복되면 그 지점마다 레코드로 분리
  function recordsFromKV(kv) {
    if (kv.length < 4) return null;
    const k0 = norm(kv[0].k);
    if (!k0) return null;
    const starts = kv.map((e, i) => (norm(e.k) === k0 ? i : -1)).filter(i => i >= 0);
    if (starts.length < 2) return null;
    const distinct = new Set(kv.map(e => norm(e.k))).size;
    if (distinct > Math.ceil(kv.length / 2)) return null;
    const headers = [];
    const recs = [];
    starts.forEach((s, n) => {
      const rec = {};
      for (let i = s; i < (starts[n + 1] ?? kv.length); i++) {
        const key = kv[i].k.replace(/[:：]\s*$/, '').trim() || '항목';
        if (!headers.includes(key)) headers.push(key);
        rec[key] = rec[key] ? rec[key] + ' ' + kv[i].v : kv[i].v;
      }
      recs.push(rec);
    });
    return { headers, rows: recs.map(r => headers.map(h => r[h] || '')), count: starts.length };
  }

  function lineToKV(ln) {
    const full = ln.cells.map(c => c.text).join(' ');
    const m = full.match(/^(.{1,12}?)\s*[:：]\s*(.*)$/);
    if (m) return { k: m[1].trim(), v: m[2].trim() };
    if (ln.cells.length >= 2) return { k: ln.cells[0].text, v: ln.cells.slice(1).map(c => c.text).join(' ') };
    return null;
  }

  function tableFromRegion(region, medH) {
    const bands = buildBands(region, medH);
    const rows = region.map(ln => {
      const r = bands.map(() => '');
      for (const c of ln.cells) { const i = bandOf(bands, c); r[i] = r[i] ? r[i] + ' ' + c.text : c.text; }
      return r;
    });
    // 첫 줄이 제목줄인지: 숫자가 없고, 아래 줄들 같은 열에 숫자가 있으면 헤더
    const first = rows[0];
    const firstHasNum = first.some(t => isNum(t));
    const restNum = bands.some((_, c) => rows.slice(1).filter(r => isNum(r[c])).length >= Math.ceil((rows.length - 1) / 2));
    let headers, body;
    if (!firstHasNum && (restNum || rows.length >= 3)) { headers = first.map((t, i) => t || `열${i + 1}`); body = rows.slice(1); }
    else { headers = bands.map((_, i) => `열${i + 1}`); body = rows; }
    return { headers, rows: body, cols: bands.length };
  }

  function analyze(words) {
    words = words.filter(w => w.text && w.text.trim());
    if (!words.length) return { sections: [], repeats: [] };
    const medH = median(words.map(w => w.y1 - w.y0)) || 10;
    const lines = buildLines(words, medH);
    const n = lines.length;
    const multi = lines.map(l => l.cells.length >= 2);

    // 1) 표 구간 찾기: 여러 칸 줄이 이어지는 구간(사이에 한 줄 정도 빈 칸 줄 허용)
    const regions = [];
    const used = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (!multi[i] || used[i]) continue;
      let last = i, k = i + 1;
      while (k < n) {
        if (lines[k].y0 - lines[k - 1].y1 > medH * 1.5) break;
        if (multi[k]) { last = k; k++; }
        else if (k + 1 < n && multi[k + 1] && k - last <= 1 && lines[k + 1].y0 - lines[k].y1 <= medH * 1.5) k++;
        else break;
      }
      const cnt = lines.slice(i, last + 1).filter((_, j) => multi[i + j]).length;
      if (cnt >= 2) { regions.push({ from: i, to: last }); for (let j = i; j <= last; j++) used[j] = true; }
      i = last;
    }

    const sections = [];
    const placed = []; // [{order, section}]
    let tn = 0, rn = 0;
    for (const r of regions) {
      const rl = lines.slice(r.from, r.to + 1);
      // 항목명:값 이 반복되는 양식(명함·신청서 등)이면 레코드로
      const kv = rl.map(lineToKV).filter(Boolean);
      const rec = kv.length === rl.length ? recordsFromKV(kv) : null;
      if (rec) {
        placed.push({ order: r.from, s: { type: 'records', title: `반복 양식 ${++rn}`, headers: rec.headers, rows: rec.rows, note: `'${rec.headers[0]}' 항목이 ${rec.count}번 반복되어 ${rec.count}건으로 나눴어요` } });
      } else {
        const t = tableFromRegion(rl, medH);
        placed.push({ order: r.from, s: { type: 'table', title: `표 ${++tn}`, headers: t.headers, rows: t.rows, note: `${t.cols}개 열 · ${t.rows.length}줄이 같은 위치에 정렬되어 있어요` } });
      }
    }

    // 2) 표가 아닌 줄: 항목명:값 반복 → 레코드, 나머지 → 일반 글자
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const kv = buf.map(b => lineToKV(b.ln));
      let handled = false;
      if (kv.every(Boolean)) {
        const rec = recordsFromKV(kv);
        if (rec) {
          placed.push({ order: buf[0].i, s: { type: 'records', title: `반복 양식 ${++rn}`, headers: rec.headers, rows: rec.rows, note: `'${rec.headers[0]}' 항목이 ${rec.count}번 반복되어 ${rec.count}건으로 나눴어요` } });
          handled = true;
        }
      }
      if (!handled) placed.push({ order: buf[0].i, s: { type: 'text', title: '일반 글자', headers: ['내용'], rows: buf.map(b => [b.ln.cells.map(c => c.text).join(' ')]), note: '반복 패턴이 없는 줄이에요' } });
      buf = [];
    };
    for (let i = 0; i < n; i++) {
      if (used[i]) { flush(); continue; }
      if (buf.length && lines[i].y0 - lines[i - 1].y1 > medH * 1.5) flush();
      buf.push({ ln: lines[i], i });
    }
    flush();

    placed.sort((a, b) => a.order - b.order).forEach(p => sections.push(p.s));

    // 3) 반복 글자(3번 이상)
    const counts = {};
    for (const ln of lines) for (const c of ln.cells) { const k = norm(c.text); if (k) counts[k] = (counts[k] || 0) + 1; }
    const repeats = Object.entries(counts).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, count]) => ({ text, count }));

    return { sections, repeats };
  }

  root.GSAnalyze = { analyze, isNum };
})(typeof window !== 'undefined' ? window : globalThis);

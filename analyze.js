// 패턴 분석: OCR 단어(글자+위치) → 구간별 표
// words: [{text, x0, y0, x1, y1}]  →  { sections:[{type,title,headers,rows,note}], repeats:[{text,count}] }
(function (root) {
  const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const isNum = t => /^[-+₩$]?[\d,.]+\s*(원|%|개|건|명|kg|g|ml|L)?$/.test(String(t).trim());
  const norm = t => String(t).replace(/[\d\s,.:：()\-_/]/g, '');
  // 구간이 사진의 어디에 있는지 (OCR 이미지 좌표)
  const boxOf = ls => ({
    x0: Math.min(...ls.map(l => l.cells[0].x0)), x1: Math.max(...ls.map(l => l.cells[l.cells.length - 1].x1)),
    y0: Math.min(...ls.map(l => l.y0)), y1: Math.max(...ls.map(l => l.y1))
  });

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
  const lineBox = ln => ({ x0: ln.cells[0].x0, x1: ln.cells[ln.cells.length - 1].x1, y0: ln.y0, y1: ln.y1 });
  function recordsFromKV(kv, lines) {
    if (kv.length < 4) return null;
    const k0 = norm(kv[0].k);
    if (!k0) return null;
    const starts = kv.map((e, i) => (norm(e.k) === k0 ? i : -1)).filter(i => i >= 0);
    if (starts.length < 2) return null;
    const distinct = new Set(kv.map(e => norm(e.k))).size;
    if (distinct > Math.ceil(kv.length / 2)) return null;
    const headers = [];
    const recs = [], recBoxes = [];
    starts.forEach((s, n) => {
      const rec = {}, rb = {};
      for (let i = s; i < (starts[n + 1] ?? kv.length); i++) {
        const key = kv[i].k.replace(/[:：]\s*$/, '').trim() || '항목';
        if (!headers.includes(key)) headers.push(key);
        rec[key] = rec[key] ? rec[key] + ' ' + kv[i].v : kv[i].v;
        if (lines && !rb[key]) rb[key] = lineBox(lines[i]);
      }
      recs.push(rec); recBoxes.push(rb);
    });
    return { headers, rows: recs.map(r => headers.map(h => r[h] || '')), cellBoxes: lines ? recBoxes.map(r => headers.map(h => r[h] || null)) : null, count: starts.length };
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
    let headers, body, bodyLines, headLine = null;
    if (!firstHasNum && (restNum || rows.length >= 3)) { headers = first.map((t, i) => t || `열${i + 1}`); body = rows.slice(1); bodyLines = region.slice(1); headLine = region[0]; }
    else { headers = bands.map((_, i) => `열${i + 1}`); body = rows; bodyLines = region; }
    // 칸마다 사진 속 위치(열 구간 × 줄 높이) — 선택 추출에서 선이 지나간 칸을 찾는 데 사용
    const cellBoxes = bodyLines.map(ln => bands.map(b => ({ x0: b[0], x1: b[1], y0: ln.y0, y1: ln.y1 })));
    const headBoxes = headLine ? bands.map(b => ({ x0: b[0], x1: b[1], y0: headLine.y0, y1: headLine.y1 })) : null;
    return { headers, rows: body, cols: bands.length, cellBoxes, headBoxes };
  }

  // 한 구역 안의 글자를 표 / 반복 양식 / 일반 글자로 분석
  function coreSections(words, medH) {
    if (!words.length) return [];
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
      const rec = kv.length === rl.length ? recordsFromKV(kv, rl) : null;
      if (rec) {
        placed.push({ order: r.from, s: { type: 'records', title: `반복 양식 ${++rn}`, headers: rec.headers, rows: rec.rows, cellBoxes: rec.cellBoxes, note: `'${rec.headers[0]}' 항목이 ${rec.count}번 반복되어 ${rec.count}건으로 나눴어요` } });
      } else {
        const t = tableFromRegion(rl, medH);
        placed.push({ order: r.from, s: { type: 'table', title: `표 ${++tn}`, headers: t.headers, rows: t.rows, cellBoxes: t.cellBoxes, headBoxes: t.headBoxes, note: `${t.cols}개 열 · ${t.rows.length}줄이 같은 위치에 정렬되어 있어요` } });
      }
      placed[placed.length - 1].s.box = boxOf(rl);
    }

    // 2) 표가 아닌 줄: 항목명:값 반복 → 레코드, 나머지 → 일반 글자
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const kv = buf.map(b => lineToKV(b.ln));
      let handled = false;
      if (kv.every(Boolean)) {
        const rec = recordsFromKV(kv, buf.map(b => b.ln));
        if (rec) {
          placed.push({ order: buf[0].i, s: { type: 'records', title: `반복 양식 ${++rn}`, headers: rec.headers, rows: rec.rows, cellBoxes: rec.cellBoxes, note: `'${rec.headers[0]}' 항목이 ${rec.count}번 반복되어 ${rec.count}건으로 나눴어요` } });
          handled = true;
        }
      }
      if (!handled) placed.push({ order: buf[0].i, s: { type: 'text', title: '일반 글자', headers: ['내용'], rows: buf.map(b => [b.ln.cells.map(c => c.text).join(' ')]), cellBoxes: buf.map(b => [lineBox(b.ln)]), note: '반복 패턴이 없는 줄이에요' } });
      placed[placed.length - 1].s.box = boxOf(buf.map(b => b.ln));
      buf = [];
    };
    for (let i = 0; i < n; i++) {
      if (used[i]) { flush(); continue; }
      if (buf.length && lines[i].y0 - lines[i - 1].y1 > medH * 1.5) flush();
      buf.push({ ln: lines[i], i });
    }
    flush();

    placed.sort((a, b) => a.order - b.order).forEach(p => sections.push(p.s));
    return sections;
  }

  // ---------- 구역 나누기 (XY-cut): 빈 공간과 선으로 사진을 칸으로 자름 ----------
  const unionBox = its => ({ x0: Math.min(...its.map(i => i.x0)), y0: Math.min(...its.map(i => i.y0)), x1: Math.max(...its.map(i => i.x1)), y1: Math.max(...its.map(i => i.y1)) });
  const lineYs = (its, medH) => {
    const ys = its.filter(i => i.kind === 'w').map(i => (i.y0 + i.y1) / 2).sort((a, b) => a - b), out = [];
    for (const y of ys) if (!out.length || y - out[out.length - 1] > medH * 0.6) out.push(y);
    return out;
  };
  // 좌우가 "서로 어긋난 글줄 3줄 이상씩"이어야 다단(열 구분)으로 인정 — 줄이 맞춰진 표는 자르지 않음
  function colsIndependent(L, R, medH) {
    const a = lineYs(L, medH), b = lineYs(R, medH);
    if (a.length < 3 || b.length < 3) return false;
    return a.filter(y => b.some(z => Math.abs(z - y) < medH * 0.5)).length / a.length <= 0.6;
  }
  function cutZones(items, medH, depth = 0) {
    if (items.length < 2 || depth > 10) return [items];
    const box = unionBox(items), W = box.x1 - box.x0, H = box.y1 - box.y0;
    const hasWord = a => a.some(i => i.kind === 'w');
    // 1) 구역을 가르는 긴 선
    const rules = items.filter(i => (i.kind === 'rule-h' && i.x1 - i.x0 >= W * 0.5) || (i.kind === 'rule-v' && i.y1 - i.y0 >= H * 0.5));
    for (const r of rules) {
      const horiz = r.kind === 'rule-h', c = horiz ? (r.y0 + r.y1) / 2 : (r.x0 + r.x1) / 2;
      const rest = items.filter(i => i !== r);
      const A = rest.filter(i => (horiz ? (i.y0 + i.y1) / 2 : (i.x0 + i.x1) / 2) < c), B = rest.filter(i => (horiz ? (i.y0 + i.y1) / 2 : (i.x0 + i.x1) / 2) >= c);
      if (hasWord(A) && hasWord(B)) return [...cutZones(A, medH, depth + 1), ...cutZones(B, medH, depth + 1)];
    }
    // 2) 위아래 빈 공간
    const byY = [...items].sort((a, b) => a.y0 - b.y0);
    let maxY = byY[0].y1, best = 0, bi = -1;
    for (let k = 1; k < byY.length; k++) { if (byY[k].y0 - maxY > best) { best = byY[k].y0 - maxY; bi = k; } maxY = Math.max(maxY, byY[k].y1); }
    if (bi > 0 && best >= medH * 1.5) return [...cutZones(byY.slice(0, bi), medH, depth + 1), ...cutZones(byY.slice(bi), medH, depth + 1)];
    // 3) 좌우 빈 공간(다단)
    const byX = [...items].sort((a, b) => a.x0 - b.x0), gaps = [];
    let maxX = byX[0].x1;
    for (let k = 1; k < byX.length; k++) { if (byX[k].x0 - maxX >= medH * 2.5) gaps.push([byX[k].x0 - maxX, k]); maxX = Math.max(maxX, byX[k].x1); }
    gaps.sort((a, b) => b[0] - a[0]);
    for (const [, k] of gaps) {
      const L = byX.slice(0, k), R = byX.slice(k);
      if (colsIndependent(L, R, medH)) return [...cutZones(L, medH, depth + 1), ...cutZones(R, medH, depth + 1)];
    }
    return [items];
  }

  // ---------- 반복 구역 ----------
  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  const sim = (a, b) => { a = String(a).replace(/\s/g, ''); b = String(b).replace(/\s/g, ''); if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0; return 1 - lev(a, b) / Math.max(a.length, b.length); };

  function zoneSig(z, medH) {
    const lines = buildLines(z.words, medH);
    return { lines, n: lines.length, w: z.box.x1 - z.box.x0, h: z.box.y1 - z.box.y0, first: norm(lines.length ? lines[0].cells.map(c => c.text).join(' ').split(/[:：\s]/)[0] : ''), marks: z.items.filter(i => i.kind === 'mark' || i.kind === 'graphic').length };
  }
  function similarZones(a, b) {
    if (a.n < 2 || b.n < 2) return false;
    const close = (x, y, t) => Math.abs(x - y) <= t * Math.max(x, y);
    if (!close(a.w, b.w, 0.25) || !close(a.h, b.h, 0.3) || Math.abs(a.n - b.n) > 1) return false;
    // 첫 용어(항목명)가 같거나, 같은 줄 수 + 같은 개수의 표식(로고·무늬)이 반복될 때만 같은 구역으로 본다
    return (a.first && sim(a.first, b.first) >= 0.6) || (a.n === b.n && a.marks > 0 && a.marks === b.marks);
  }
  const cellsText = ln => ln.cells.map(c => c.text).join(' ');

  // 같은 모양의 구역 묶음 → 한 건씩 한 줄로
  function mergeGroup(zs, medH) {
    const k = zs.length;
    const kvAll = zs.map(z => z.sig.lines.map(lineToKV));
    let headers, rows;
    // 항목명이 같은 순서로 반복되는 구역이 절반 이상이면 그 항목명을 열 이름으로 쓰고,
    // 글자 인식이 틀린 줄도 같은 위치(몇 번째 줄)라면 같은 열에 넣는다
    const seqOf = list => list.map(e => norm(e.k)).join('|');
    const full = kvAll.filter(list => list.length && list.every(Boolean));
    if (full.length) {
      const cnt = new Map(); full.forEach(l => cnt.set(seqOf(l), (cnt.get(seqOf(l)) || 0) + 1));
      const [bestSeq, bestN] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
      if (bestN >= Math.ceil(k / 2) && bestSeq.split('|').length >= 2) {
        const ref = full.find(l => seqOf(l) === bestSeq);
        headers = ref.map(e => e.k.replace(/[:：]\s*$/, '').trim() || '항목');
        rows = zs.map((z, i) => [String(i + 1), ...headers.map((h, j) => {
          const e = kvAll[i][j], ln = z.sig.lines[j];
          if (e && sim(norm(e.k), norm(ref[j].k)) >= 0.5) return e.v;
          return ln ? cellsText(ln) : '';
        })]);
      }
    }
    if (!rows) {
      const maxN = Math.max(...zs.map(z => z.sig.n));
      headers = Array.from({ length: maxN }, (_, i) => `줄 ${i + 1}`);
      rows = zs.map((z, i) => [String(i + 1), ...headers.map((_, j) => (z.sig.lines[j] ? cellsText(z.sig.lines[j]) : ''))]);
    }
    // 칸 위치: 구역 번호 열은 없음(null), 나머지는 같은 순서의 줄 위치
    const cellBoxes = zs.map(z => [null, ...headers.map((_, j) => (z.sig.lines[j] ? lineBox(z.sig.lines[j]) : null))]);
    return { type: 'repeat', title: '반복 구역', headers: ['구역', ...headers], rows, cellBoxes, note: `같은 모양의 구역 ${k}개를 한 건씩 묶었어요`, boxes: zs.map(z => z.box), box: unionBox(zs.map(z => z.box)) };
  }

  // words: [{text,x0,y0,x1,y1}], opts.marks: 글자가 아닌 모양 [{x0,y0,x1,y1,kind,corner}]
  function analyze(words, opts) {
    words = words.filter(w => w.text && w.text.trim());
    if (!words.length) return { sections: [], repeats: [], zones: [], marks: [] };
    const marks = (opts && opts.marks) || [];
    const medH = median(words.map(w => w.y1 - w.y0)) || 10;

    const items = [...words.map(w => ({ x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, kind: 'w', ref: w })), ...marks.map(m => ({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, kind: m.kind, mk: m }))];
    let zones = cutZones(items, medH)
      .map(its => ({ items: its, words: its.filter(i => i.kind === 'w').map(i => i.ref), box: unionBox(its.filter(i => i.kind === 'w')) }))
      .filter(z => z.words.length);
    zones.forEach(z => { z.sig = zoneSig(z, medH); });

    // 같은 모양이 이어지면 반복 구역으로 묶기
    const out = [], zoneInfo = [];
    let tn = 0, rn = 0, gn = 0, zn = 0;
    const push = s => { if (/^표 /.test(s.title)) s.title = `표 ${++tn}`; else if (/^반복 양식 /.test(s.title)) s.title = `반복 양식 ${++rn}`; out.push(s); };
    for (let i = 0; i < zones.length;) {
      let j = i;
      while (j + 1 < zones.length && similarZones(zones[i].sig, zones[j + 1].sig)) j++;
      if (j > i) {
        const grp = zones.slice(i, j + 1), g = ++gn;
        const s = mergeGroup(grp, medH); s.title = `반복 구역 ${g}`; out.push(s);
        grp.forEach((z, p) => zoneInfo.push({ box: z.box, name: `반복 ${g} · ${p + 1}/${grp.length}`, group: g }));
      } else {
        const z = zones[i], secs = coreSections(z.words, medH);
        secs.forEach(push);
        const kinds = new Set(secs.map(s => s.type));
        const label = kinds.has('table') ? '표' : kinds.has('records') ? '양식' : '글';
        zoneInfo.push({ box: z.box, name: `구역 ${++zn} · ${label}`, group: 0 });
      }
      i = j + 1;
    }

    // 반복 글자(3번 이상)
    const counts = {};
    for (const ln of buildLines(words, medH)) for (const c of ln.cells) { const k = norm(c.text); if (k) counts[k] = (counts[k] || 0) + 1; }
    const repeats = Object.entries(counts).filter(([, v]) => v >= 3).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, count]) => ({ text, count }));

    return { sections: out, repeats, zones: zoneInfo, marks: marks.slice(0, 60) };
  }

  root.GSAnalyze = { analyze, isNum };
})(typeof window !== 'undefined' ? window : globalThis);

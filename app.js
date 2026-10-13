const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let sections = [];

function show(view) {
  $('#pickView').hidden = view !== 'pick';
  $('#workView').hidden = view !== 'work';
}
function setProgress(p, text) {
  $('#progress').hidden = false;
  $('#fill').style.width = Math.round(p * 100) + '%';
  $('#ptext').textContent = text;
}
function showErr(msg) { const e = $('#err'); e.textContent = msg; e.hidden = !msg; }

// 사진을 적당한 크기로 줄이고 흑백·대비를 올려 OCR 정확도를 높임
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 2200, k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d');
      g.filter = 'grayscale(1) contrast(1.35)';
      g.drawImage(img, 0, 0, c.width, c.height);
      resolve({ canvas: c, url });
    };
    img.onerror = () => reject(new Error('사진을 열 수 없어요'));
    img.src = url;
  });
}

function wordsFrom(data) {
  let ws = data.words;
  if (!ws && data.blocks) ws = data.blocks.flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)));
  return (ws || []).filter(w => w.confidence > 30).map(w => ({ text: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
}

async function handleFile(file) {
  if (!file) return;
  show('work'); showErr(''); $('#result').hidden = true;
  setProgress(0.02, '사진 준비 중…');
  try {
    const { canvas, url } = await loadImage(file);
    $('#photo').src = url;
    if (typeof Tesseract === 'undefined') throw new Error('글자 인식 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    const worker = await Tesseract.createWorker('kor+eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') setProgress(0.2 + m.progress * 0.75, `글자 읽는 중… ${Math.round(m.progress * 100)}%`);
        else if (m.progress != null) setProgress(0.05 + m.progress * 0.15, '인식 엔진 준비 중…');
      }
    });
    const { data } = await worker.recognize(canvas);
    await worker.terminate();
    const words = wordsFrom(data);
    if (!words.length) throw new Error('글자를 찾지 못했어요. 더 밝고 가까이에서 다시 찍어 주세요.');
    setProgress(0.98, '패턴 분석 중…');
    const res = GSAnalyze.analyze(words);
    render(res);
    $('#progress').hidden = true;
  } catch (e) {
    $('#progress').hidden = true;
    showErr(e.message || String(e));
  }
}

function render(res) {
  sections = res.sections;
  $('#repeats').innerHTML = res.repeats.length
    ? '<b>반복되는 글자</b> ' + res.repeats.map(r => `<span class="chip">${esc(r.text)} ×${r.count}</span>`).join('')
    : '';
  $('#sections').innerHTML = sections.map((s, si) => `
    <article class="card ${s.type}">
      <div class="card-head">
        <input class="title" data-s="${si}" value="${esc(s.title)}">
        <button class="x" data-del="${si}" title="이 구간 삭제">✕</button>
      </div>
      <div class="note">${esc(s.note)}</div>
      <div class="tbl-wrap"><table>
        <thead><tr>${s.headers.map((h, c) => `<th contenteditable data-s="${si}" data-h="${c}">${esc(h)}</th>`).join('')}</tr></thead>
        <tbody>${s.rows.map((r, ri) => `<tr>${r.map((v, c) => `<td contenteditable data-s="${si}" data-r="${ri}" data-c="${c}">${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </article>`).join('') || '<p class="hint">정리할 구간을 찾지 못했어요.</p>';
  $('#result').hidden = false;
}

// 화면 편집 → 데이터 반영
document.addEventListener('input', e => {
  const t = e.target, si = t.dataset.s;
  if (si == null) return;
  if (t.classList.contains('title')) sections[si].title = t.value;
  else if (t.dataset.h != null) sections[si].headers[t.dataset.h] = t.textContent;
  else if (t.dataset.r != null) sections[si].rows[t.dataset.r][t.dataset.c] = t.textContent;
});
document.addEventListener('click', e => {
  const d = e.target.dataset.del;
  if (d != null) { sections.splice(+d, 1); render({ sections, repeats: [] }); $('#repeats').innerHTML = ''; }
});

// ---- 내보내기 ----
const toCell = v => (/^-?[1-9]\d{0,14}(,\d{3})*(\.\d+)?$|^0(\.\d+)?$/.test(String(v).trim()) ? Number(String(v).replace(/,/g, '')) : v);
function sheetName(name, used) {
  let n = (name || '시트').replace(/[\\/?*[\]:]/g, '').slice(0, 28) || '시트', k = 2, base = n;
  while (used.has(n)) n = base + k++;
  used.add(n); return n;
}
function stamp() { const d = new Date(), p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

$('#xlsxBtn').onclick = () => {
  if (typeof XLSX === 'undefined') return alert('엑셀 엔진을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
  const wb = XLSX.utils.book_new(), used = new Set();
  sections.forEach(s => {
    const ws = XLSX.utils.aoa_to_sheet([s.headers, ...s.rows.map(r => r.map(toCell))]);
    ws['!cols'] = s.headers.map((h, c) => ({ wch: Math.min(40, Math.max(6, ...[h, ...s.rows.map(r => r[c] || '')].map(v => String(v).length * 1.6))) }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName(s.title, used));
  });
  XLSX.writeFile(wb, `글자스캔정리_${stamp()}.xlsx`);
};
$('#docBtn').onclick = () => {
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><style>table{border-collapse:collapse}td,th{border:1px solid #888;padding:4px 8px}th{background:#e8f3ee}</style></head><body>` +
    sections.map(s => `<h3>${esc(s.title)}</h3><table><tr>${s.headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>${s.rows.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table><br>`).join('') + '</body></html>';
  download(new Blob(['﻿', html], { type: 'application/msword' }), `글자스캔정리_${stamp()}.doc`);
};
$('#copyBtn').onclick = async () => {
  const tsv = sections.map(s => [s.title, s.headers.join('\t'), ...s.rows.map(r => r.join('\t'))].join('\n')).join('\n\n');
  try { await navigator.clipboard.writeText(tsv); $('#copyBtn').textContent = '복사됨 ✓'; setTimeout(() => $('#copyBtn').textContent = '복사', 1500); }
  catch { alert('복사에 실패했어요'); }
};

$('#camInput').onchange = $('#fileInput').onchange = e => { handleFile(e.target.files[0]); e.target.value = ''; };
$('#againBtn').onclick = () => { show('pick'); showErr(''); };

if ('serviceWorker' in navigator && location.protocol.startsWith('http') && location.hostname !== 'localhost') navigator.serviceWorker.register('sw.js').catch(() => {});

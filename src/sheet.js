// Minimal, dependency-free spreadsheet reading for imports:
//  - CSV (comma / semicolon / tab, quoted fields incl. line breaks, UTF-8 or Windows-1252)
//  - Excel .xlsx (first worksheet; shared strings, inline strings, numbers, booleans)
// Returns rows as arrays of trimmed strings.

export class SheetError extends Error { constructor(m) { super(m); this.name = 'SheetError'; } }

// Windows-1252 0x80–0x9F (decoded by hand: some runtimes treat it as Latin-1).
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
function decode1252(u8) {
  let s = '';
  for (const byte of u8) s += byte >= 0x80 && byte <= 0x9f ? CP1252[byte - 0x80] : String.fromCharCode(byte);
  return s;
}

/** Decode file bytes: UTF-8 if valid (BOM stripped), otherwise Windows-1252 (Excel "CSV" on Windows). */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(u8); }
  catch { text = decode1252(u8); }
  return text.replace(/^\uFEFF/, '');
}

/** RFC 4180-style CSV parser with delimiter auto-detection. */
export function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = ch => (firstLine.match(new RegExp('\\' + ch, 'g')) || []).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') { q = true; cur = ''; }
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  if (q) throw new SheetError('CSV has an unclosed quote');
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.map(r => r.map(c => c.trim()));
}

// ---------- XLSX ----------
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}
/** Read a ZIP archive's entries into { name: Uint8Array }. Only stored and deflate entries. */
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new SheetError('Not a valid .xlsx file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new SheetError('Corrupt .xlsx (central directory)');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!/^(xl\/|\[Content_Types\])/.test(name) || name.endsWith('/')) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    if (method === 0) files[name] = raw;
    else if (method === 8) files[name] = await inflateRaw(raw);
    else throw new SheetError('Unsupported compression in .xlsx');
  }
  return files;
}
const unescapeXml = s => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
});
const textOf = xml => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)].map(m => unescapeXml(m[1] ?? '')).join('');
const attr = (s, n) => (new RegExp(`\\b${n}="([^"]*)"`).exec(s) || [])[1];
const colIndex = ref => { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

/** Parse the first worksheet of an .xlsx file into rows of strings. */
export async function parseXlsx(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const files = await unzip(u8);
  const dec = new TextDecoder();
  const read = n => (files[n] ? dec.decode(files[n]) : null);
  // Locate first sheet via workbook relationships; fall back to sheet1.xml.
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = read('xl/workbook.xml'), rels = read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = /<sheet\b[^>]*>/.exec(wb)?.[0];
    const rid = first && (attr(first, 'r:id') || attr(first, 'id'));
    const rel = rid && [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(r => attr(r, 'Id') === rid);
    const target = rel && attr(rel, 'Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
  }
  const sheet = read(sheetPath);
  if (!sheet) throw new SheetError('Could not find a worksheet in the .xlsx file');
  const ssXml = read('xl/sharedStrings.xml');
  const shared = ssXml ? [...ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => textOf(m[1] ?? '')) : [];
  const rows = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowNo = Number(attr(rm[1] ?? rm[3], 'r')) || rows.length + 1;
    const cells = [];
    let next = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1], body = cm[2] ?? '';
      const ref = attr(a, 'r'); const idx = ref ? colIndex(ref) : next;
      next = idx + 1;
      const t = attr(a, 't');
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = textOf(body);
      else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v != null) val = unescapeXml(v);
      cells[idx] = val.trim();
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows.push(Array.from(cells, c => c ?? ''));
  }
  return rows;
}

/** Read an uploaded file (name + bytes) into rows. */
export async function readSpreadsheet(name, bytes) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith('.xlsx')) return parseXlsx(bytes);
  if (lower.endsWith('.xls')) throw new SheetError('Old .xls format is not supported. In Excel choose File → Save As → Excel Workbook (.xlsx) or CSV.');
  if (lower.endsWith('.numbers') || lower.endsWith('.ods')) throw new SheetError('Please export the sheet as .xlsx or CSV first.');
  return parseCsv(decodeText(bytes));
}

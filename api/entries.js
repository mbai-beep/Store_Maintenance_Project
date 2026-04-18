// api/entries.js - Sheet-backed list + append; IST timestamps.
const { getAuth, ensureHeaderRow, SHEET_HEADERS, SHEET_RANGE } = require('../lib/google');

function nowIST() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('day')}-${g('month')}-${g('year')} ${g('hour')}:${g('minute')}:${g('second')}`;
}
function parseIST(str) {
  if (!str) return 0;
  const m = String(str).match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, dd, mm, yyyy, h, mi, s] = m;
    return new Date(+yyyy, +mm - 1, +dd, +h, +mi, +s).getTime();
  }
  const d = new Date(str);
  return isNaN(d) ? 0 : d.getTime();
}
function sheetRowToEntry(row) {
  const obj = {};
  SHEET_HEADERS.forEach((h, i) => { obj[h] = row[i] != null ? row[i] : ''; });
  obj.photoUrls = obj.photoUrls
    ? String(obj.photoUrls).split(' | ').map(s => s.trim()).filter(Boolean)
    : [];
  obj.photoCount = Number(obj.photoCount) || obj.photoUrls.length;
  return obj;
}

function entryToSheetRow(e) {
  const urls = Array.isArray(e.photoUrls) ? e.photoUrls.join(' | ') : (e.photoUrls || '');
  return [
    e.id || '',
    e.createdAt || nowIST(),
    e.storeName || '',
    e.storeCode || '',
    e.requirements || '',
    e.employee || '',
    e.employeeId || '',
    e.status || 'new',
    String(e.photoCount != null ? e.photoCount : (Array.isArray(e.photoUrls) ? e.photoUrls.length : 0)),
    urls,
  ];
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'SHEET_ID env var is missing' });

  try {
    const { sheets } = getAuth();
    await ensureHeaderRow();

    if (req.method === 'GET') {
      const employee = (req.query && req.query.employee) || '';
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
      });
      const rows = (result.data.values || []).slice(1);
      let entries = rows.filter(r => r && r.length).map(sheetRowToEntry);
      if (employee) entries = entries.filter(e => e.employee === employee);
      entries.sort((a, b) => parseIST(a.createdAt) - parseIST(b.createdAt));
      return res.status(200).json({ entries });
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : await readJson(req);
      if (!body.id)           return res.status(400).json({ error: 'id is required' });
      if (!body.storeName)    return res.status(400).json({ error: 'storeName is required' });
      if (!body.storeCode)    return res.status(400).json({ error: 'storeCode is required' });
      if (!body.requirements) return res.status(400).json({ error: 'requirements is required' });

      const row = entryToSheetRow(body);
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      });
      return res.status(200).json({ success: true, entry: sheetRowToEntry(row) });
    }

    res.setHeader('Allow', 'GET, POST');
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/entries]', err);
    res.status(500).json({ error: err.message || 'internal_error' });
  }
};

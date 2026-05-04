// api/entries.js - list + append maintenance/customer entries.
// Returns a plain array on GET (matches frontend expectation).
const { getAuth, ensureHeaderRow, SHEET_HEADERS, SHEET_RANGE } = require('../lib/google');
const { getEmployeeByToken, tokenFromReq, readJson } = require('../lib/auth');
const { ensureSchema } = require('../lib/db');

function nowIST() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return g('day') + '-' + g('month') + '-' + g('year') + ' ' + g('hour') + ':' + g('minute') + ':' + g('second');
}
function parseIST(str) {
  if (!str) return 0;
  const m = String(str).match(/^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const dd = m[1], mm = m[2], yyyy = m[3], h = m[4], mi = m[5], s = m[6];
    return new Date(+yyyy, +mm - 1, +dd, +h, +mi, +s).getTime();
  }
  const d = new Date(str);
  return isNaN(d) ? 0 : d.getTime();
}
function dayOnly(str) {
  const ms = parseIST(str);
  if (!ms) return null;
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
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
  const requirementJson = e.requirement || e.requirements || '';
  return [
    e.id || '',
    e.createdAt && /^\d{2}-\d{2}-\d{4}/.test(e.createdAt) ? e.createdAt : nowIST(),
    e.storeName || '',
    e.storeCode || '',
    requirementJson,
    e.description || '',
    e.employee || '',
    String(e.employeeId || e.submittedBy || ''),
    e.status || 'new',
    e.fulfillmentStatus || 'Pending',
    String(e.photoCount != null ? e.photoCount : (Array.isArray(e.photoUrls) ? e.photoUrls.length : 0)),
    urls,
    e.audioUrl || '',
    e.voiceDuration || '',
    e.requestType || 'Store Maintenance',
    e.customerName || '',
    e.mobileNumber || '',
  ];
}

module.exports = async function handler(req, res) {
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'SHEET_ID env var is missing' });

  try {
    await ensureSchema();
    const { sheets } = getAuth();
    await ensureHeaderRow();

    if (req.method === 'GET') {
      const q = req.query || {};
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: SHEET_RANGE,
      });
      const rows = (result.data.values || []).slice(1);
      let entries = rows.filter(r => r && r.length).map(sheetRowToEntry);

      if (q.requestType) entries = entries.filter(e => (e.requestType || 'Store Maintenance') === q.requestType);
      if (q.storeCode) entries = entries.filter(e => String(e.storeCode) === String(q.storeCode));
      const role = String(q.role || '').toLowerCase();
      const PRIVILEGED = ['admin', 'owner', 'buyer', 'manager'];
      if (q.empCode && !PRIVILEGED.includes(role)) {
        entries = entries.filter(e => String(e.employeeId) === String(q.empCode));
      }
      if (q.dateFrom) {
        const from = new Date(q.dateFrom + 'T00:00:00').getTime();
        entries = entries.filter(e => {
          const d = dayOnly(e.createdAt);
          return d != null && d >= from;
        });
      }
      if (q.dateTo) {
        const to = new Date(q.dateTo + 'T23:59:59').getTime();
        entries = entries.filter(e => {
          const d = parseIST(e.createdAt);
          return d != null && d <= to;
        });
      }
      entries.sort((a, b) => parseIST(b.createdAt) - parseIST(a.createdAt));
      const limit = parseInt(q.limit, 10);
      if (Number.isFinite(limit) && limit > 0) entries = entries.slice(0, limit);

      return res.status(200).json(entries);
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (!body.id)        return res.status(400).json({ success: false, error: 'id is required' });
      if (!body.storeName) return res.status(400).json({ success: false, error: 'storeName is required' });
      if (!body.storeCode) return res.status(400).json({ success: false, error: 'storeCode is required' });
      const requirementJson = body.requirement || body.requirements;
      if (!requirementJson) return res.status(400).json({ success: false, error: 'requirement is required' });

      const photoCount = Array.isArray(body.photoUrls) ? body.photoUrls.length : Number(body.photoCount || 0);
      if ((body.requestType || 'Store Maintenance') === 'Store Maintenance' && photoCount < 2) {
        return res.status(400).json({ success: false, error: 'At least 2 photos are required for maintenance requests' });
      }

      const token = tokenFromReq(req);
      const emp = await getEmployeeByToken(token);
      if (emp) {
        body.employee = emp.emp_name;
        body.employeeId = String(emp.emp_code);
      }

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
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/entries]', err);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

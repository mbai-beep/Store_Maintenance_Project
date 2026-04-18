// api/entries/[id].js
// PATCH /api/entries/:id  body: { status: 'new'|'reviewed'|'resolved' }
const { getAuth, ensureHeaderRow, SHEET_TAB } = require('../../lib/google');

const ALLOWED = new Set(['new','reviewed','resolved']);

module.exports = async function handler(req, res) {
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ error: 'SHEET_ID env var is missing' });

  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id path param is required' });

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      body = await new Promise((resolve, reject) => {
        let d = '';
        req.on('data', c => { d += c; });
        req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
    } catch (e) { return res.status(400).json({ error: 'invalid json body' }); }
  }

  const status = body.status;
  if (!status || !ALLOWED.has(status)) {
    return res.status(400).json({ error: 'status must be one of: new, reviewed, resolved' });
  }

  try {
    const { sheets } = getAuth();
    await ensureHeaderRow();

    const idCol = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:A`,
    });
    const ids = (idCol.data.values || []).map(r => r[0]);
    const rowIndex = ids.findIndex((v, i) => i > 0 && v === id);
    if (rowIndex === -1) return res.status(404).json({ error: 'entry not found' });
    const sheetRow = rowIndex + 1;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!H${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });

    res.status(200).json({ success: true, id, status });
  } catch (err) {
    console.error('[api/entries/[id]]', err);
    res.status(500).json({ error: err.message || 'internal_error' });
  }
};

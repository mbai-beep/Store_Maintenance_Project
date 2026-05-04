// api/update-status.js - frontend posts { id, fulfillmentStatus }
const { getAuth, ensureHeaderRow, SHEET_TAB, SHEET_HEADERS } = require('../lib/google');
const { readJson } = require('../lib/auth');

const ALLOWED = new Set(['Pending', 'Fulfilled', 'Not_Fulfilled']);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ success: false, error: 'SHEET_ID env var is missing' });

  try {
    const body = await readJson(req);
    const id = String(body.id || '').trim();
    const status = String(body.fulfillmentStatus || '').trim();
    if (!id) return res.status(200).json({ success: false, error: 'id required' });
    if (!ALLOWED.has(status)) return res.status(200).json({ success: false, error: 'Invalid status' });

    const { sheets } = getAuth();
    await ensureHeaderRow();

    const idCol = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A:A`,
    });
    const ids = (idCol.data.values || []).map(r => r[0]);
    const rowIndex = ids.findIndex((v, i) => i > 0 && v === id);
    if (rowIndex === -1) return res.status(200).json({ success: false, error: 'entry not found' });
    const sheetRow = rowIndex + 1;

    // Locate fulfillmentStatus column from headers
    const colIdx = SHEET_HEADERS.indexOf('fulfillmentStatus');
    if (colIdx === -1) return res.status(500).json({ success: false, error: 'fulfillmentStatus column missing in sheet schema' });
    const colLetter = String.fromCharCode(65 + colIdx);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!${colLetter}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status]] },
    });

    return res.status(200).json({ success: true, id, fulfillmentStatus: status });
  } catch (err) {
    console.error('[api/update-status]', err);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

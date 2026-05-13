// api/delete-entries.js - admin/owner/manager only. Deletes rows from the
// Google Sheet by matching entry id (column A).
const { getAuth, ensureHeaderRow, SHEET_TAB } = require('../lib/google');
const { getEmployeeByToken, tokenFromReq, readJson } = require('../lib/auth');
const { ensureSchema } = require('../lib/db');

const DELETE_ROLES = new Set(['admin', 'owner', 'manager']);

async function getSheetGid(sheets, spreadsheetId, tabName) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' });
  const tab = (meta.data.sheets || []).find(s => s.properties && s.properties.title === tabName);
  return tab ? tab.properties.sheetId : 0;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return res.status(500).json({ success: false, error: 'SHEET_ID env var is missing' });

  try {
    await ensureSchema();
    const token = tokenFromReq(req);
    const emp = await getEmployeeByToken(token);
    if (!emp) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const role = String(emp.role || '').toLowerCase();
    if (!DELETE_ROLES.has(role)) {
      return res.status(403).json({ success: false, error: 'Admin / Owner / Manager role required to delete' });
    }

    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
    if (!ids || ids.length === 0) {
      return res.status(200).json({ success: false, error: 'No entry IDs provided' });
    }
    if (ids.length > 100) {
      return res.status(200).json({ success: false, error: 'Cannot delete more than 100 entries at once' });
    }

    const { sheets } = getAuth();
    await ensureHeaderRow();
    const gid = await getSheetGid(sheets, SHEET_ID, SHEET_TAB);

    // Read column A to locate row indices for each id (1-based with header)
    const idCol = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_TAB + '!A:A',
    });
    const allIds = (idCol.data.values || []).map(r => (r[0] || ''));

    // Compute 0-indexed row positions to delete (skip header at row 0).
    const targetRows = [];
    for (let i = 1; i < allIds.length; i++) {
      if (ids.includes(allIds[i])) targetRows.push(i);
    }
    if (targetRows.length === 0) {
      return res.status(200).json({ success: true, deleted: 0, note: 'No matching rows found' });
    }

    // Delete from the bottom up so indices don't shift mid-batch.
    targetRows.sort((a, b) => b - a);
    const requests = targetRows.map(rowIdx => ({
      deleteDimension: {
        range: {
          sheetId: gid,
          dimension: 'ROWS',
          startIndex: rowIdx,
          endIndex: rowIdx + 1,
        },
      },
    }));

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests },
    });

    return res.status(200).json({ success: true, deleted: targetRows.length });
  } catch (err) {
    console.error('[api/delete-entries]', err && err.message);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

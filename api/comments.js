// api/comments.js - remarks/comments for maintenance entries.
// Stored in Turso `comments` table. Combined string mirrored to the Sheet's
// `remarks` column for visibility outside the app.
const { getDB, ensureSchema } = require('../lib/db');
const { getAuth, ensureHeaderRow, SHEET_HEADERS, SHEET_TAB } = require('../lib/google');
const { getEmployeeByToken, tokenFromReq, readJson } = require('../lib/auth');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const DELETE_ROLES = new Set(['admin']); // only admin can delete remarks

function toColLetter(idx /* 0-based */) {
  let s = '';
  for (let n = idx + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

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

async function ensureCommentsTable() {
  const db = getDB();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS comments (
      id              TEXT PRIMARY KEY,
      entry_id        TEXT NOT NULL,
      commenter_name  TEXT NOT NULL,
      commenter_id    TEXT NOT NULL,
      commenter_role  TEXT DEFAULT 'employee',
      comment         TEXT NOT NULL,
      created_at      TEXT NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_id, created_at)`);
}

async function syncRemarksToSheet(entryId) {
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) return;
  try {
    const db = getDB();
    const r = await db.execute({
      sql: `SELECT commenter_name, comment, created_at FROM comments WHERE entry_id = ? ORDER BY created_at ASC`,
      args: [entryId],
    });
    const combined = r.rows.map(row => row.commenter_name + ': ' + row.comment).join(' | ');
    const remarksColIdx = SHEET_HEADERS.indexOf('remarks');
    if (remarksColIdx === -1) return;
    const remarksColLetter = toColLetter(remarksColIdx);

    const { sheets } = getAuth();
    await ensureHeaderRow();
    const idResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: SHEET_TAB + '!A:A',
    });
    const ids = (idResp.data.values || []).map(row => (row[0] || '').toString().trim());
    const rowIndex = ids.indexOf(String(entryId).trim());
    if (rowIndex < 0) return;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: SHEET_TAB + '!' + remarksColLetter + (rowIndex + 1),
      valueInputOption: 'RAW',
      requestBody: { values: [[combined]] },
    });
  } catch (e) {
    console.warn('[api/comments] sheet sync failed:', e.message);
  }
}

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    await ensureSchema();
    await ensureCommentsTable();
    const token = tokenFromReq(req);
    const emp = await getEmployeeByToken(token);
    if (!emp) return res.status(401).json({ success: false, error: 'Not authenticated' });
    const role = String(emp.role || '').toLowerCase();
    const db = getDB();

    if (req.method === 'GET') {
      const { entryId, action, ids } = req.query || {};
      if (action === 'counts' && ids) {
        const idList = String(ids).split(',').map(s => s.trim()).filter(Boolean).slice(0, 200);
        const counts = {};
        for (const id of idList) {
          const r = await db.execute({ sql: `SELECT COUNT(*) AS cnt FROM comments WHERE entry_id = ?`, args: [id] });
          counts[id] = Number((r.rows[0] && r.rows[0].cnt) || 0);
        }
        return res.status(200).json(counts);
      }
      if (!entryId) return res.status(200).json([]);
      const r = await db.execute({
        sql: `SELECT * FROM comments WHERE entry_id = ? ORDER BY created_at ASC`,
        args: [String(entryId)],
      });
      return res.status(200).json(r.rows);
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      const entryId = body.entryId;
      const comment = String(body.comment || '').trim();
      if (!entryId || !comment) {
        return res.status(200).json({ success: false, error: 'Entry ID and comment are required' });
      }
      const id = 'cmt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      const commenterName = emp.emp_name || ('User ' + emp.emp_code);
      await db.execute({
        sql: `INSERT INTO comments (id, entry_id, commenter_name, commenter_id, commenter_role, comment, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, String(entryId), commenterName, String(emp.emp_code), role, comment, nowIST()],
      });
      // Mirror to Sheet (fire and forget)
      syncRemarksToSheet(String(entryId)).catch(() => {});
      return res.status(200).json({ success: true, id });
    }

    if (req.method === 'DELETE') {
      if (!DELETE_ROLES.has(role)) {
        return res.status(403).json({ success: false, error: 'Admin role required to delete remarks' });
      }
      const id = (req.query && req.query.id) ? String(req.query.id) : '';
      if (!id) return res.status(200).json({ success: false, error: 'Comment ID required' });
      const existing = await db.execute({ sql: `SELECT entry_id FROM comments WHERE id = ?`, args: [id] });
      if (!existing.rows.length) return res.status(200).json({ success: false, error: 'Comment not found' });
      const entryId = existing.rows[0].entry_id;
      await db.execute({ sql: `DELETE FROM comments WHERE id = ?`, args: [id] });
      syncRemarksToSheet(entryId).catch(() => {});
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/comments]', err && err.message);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

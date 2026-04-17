const { getDB, ensureTable } = require('./_db');

function mapRow(r) {
  return {
    id:           r.id,
    customerName: r.customer_name,
    mobileNumber: r.mobile_number,
    storeName:    r.store_name,
    requirement:  r.requirement   || '',
    description:  r.description   || '',
    employee:     r.employee,
    employeeId:   r.employee_id  || '',
    createdAt:    r.created_at,
    status:       r.status       || 'new',
    hasVoice:     r.has_voice === 1,
    voiceDuration:r.voice_duration || '',
    photoCount:   typeof r.photo_count === 'number' ? r.photo_count : (parseInt(r.photo_count) || 0),
    synced:       true,
  };
}

module.exports = async function handler(req, res) {
  try {
    await ensureTable();
    const db = getDB();

    /* ── GET: list entries (all, or filtered by employee) ── */
    if (req.method === 'GET') {
      const { employee } = req.query;
      let result;
      if (employee) {
        result = await db.execute({
          sql:  'SELECT * FROM entries WHERE employee = ? ORDER BY created_at DESC',
          args: [employee],
        });
      } else {
        result = await db.execute('SELECT * FROM entries ORDER BY created_at DESC');
      }
      return res.json({ entries: result.rows.map(mapRow) });
    }

    /* ── POST: create entry ── */
    if (req.method === 'POST') {
      const b = req.body;
      if (!b.id || !b.customerName || !b.mobileNumber || !b.storeName || !b.employee || !b.createdAt) {
        return res.status(400).json({ error: 'Missing required fields' });
      }
      await db.execute({
        sql: `INSERT OR REPLACE INTO entries
              (id, customer_name, mobile_number, store_name, requirement, description, employee,
               employee_id, created_at, status, has_voice, voice_duration, photo_count, synced_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          b.id,
          b.customerName,
          b.mobileNumber,
          b.storeName,
          b.requirement    || '',
          b.description    || '',
          b.employee,
          b.employeeId     || '',
          b.createdAt,
          b.status         || 'new',
          b.hasVoice ? 1 : 0,
          b.voiceDuration  || '',
          b.photoCount     || 0,
          new Date().toISOString(),
        ],
      });
      return res.json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/entries]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

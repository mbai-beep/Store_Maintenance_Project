const { getDB } = require('../_db');

const VALID_STATUSES = ['new', 'reviewed', 'actioned'];

module.exports = async function handler(req, res) {
  try {
    const { id } = req.query;
    const db = getDB();

    /* ── PATCH: update status ── */
    if (req.method === 'PATCH') {
      const { status } = req.body;
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({ error: 'Invalid status value' });
      }
      const result = await db.execute({
        sql:  'UPDATE entries SET status = ? WHERE id = ?',
        args: [status, id],
      });
      if (result.rowsAffected === 0) {
        return res.status(404).json({ error: 'Entry not found' });
      }
      return res.json({ success: true });
    }

    res.setHeader('Allow', 'PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[api/entries/[id]]', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

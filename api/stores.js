// api/stores.js - simple store list. Pulls from Turso `stores` and falls back to distinct
// store_code/store_name pairs in `employees` so the admin filter is never empty.
const { getDB, ensureSchema } = require('../lib/db');

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const db = getDB();
    const fromTable = await db.execute({ sql: `SELECT code, name FROM stores ORDER BY code`, args: [] });
    let rows = fromTable.rows.map(r => ({ code: String(r.code), name: String(r.name) }));
    if (!rows.length) {
      const distinct = await db.execute({
        sql: `SELECT DISTINCT store_code AS code, store_name AS name
              FROM employees
              WHERE store_code IS NOT NULL AND store_code <> ''
              ORDER BY store_code`,
        args: [],
      });
      rows = distinct.rows.map(r => ({ code: String(r.code), name: String(r.name || '') }));
    }
    return res.status(200).json({ stores: rows });
  } catch (err) {
    console.error('[api/stores]', err);
    return res.status(500).json({ stores: [], error: err.message });
  }
};

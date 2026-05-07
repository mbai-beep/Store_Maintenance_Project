// api/admin.js - admin-only employee management
const { getDB, ensureSchema } = require('../lib/db');
const {
  hashPassword, getEmployeeByToken, tokenFromReq, readJson,
} = require('../lib/auth');

const ADMIN_ROLES = ['admin', 'owner', 'manager'];

async function requireAdmin(req, res) {
  const token = tokenFromReq(req);
  const emp = await getEmployeeByToken(token);
  if (!emp) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return null;
  }
  if (!ADMIN_ROLES.includes(String(emp.role || '').toLowerCase())) {
    res.status(403).json({ success: false, error: 'Admin / Owner / Manager role required' });
    return null;
  }
  return emp;
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const action = (req.query && req.query.action) || '';
    const admin = await requireAdmin(req, res);
    if (!admin) return; // already responded

    const db = getDB();

    if (action === 'get-employee' && req.method === 'GET') {
      const empCode = parseInt(req.query.empCode, 10);
      if (!empCode) return res.status(200).json({ success: false, error: 'empCode required' });
      const r = await db.execute({
        sql: `SELECT emp_code, emp_name, emp_designation, emp_mobile, store_name, store_code,
                     role, store_status, must_change_password, password_changed_at
              FROM employees WHERE emp_code = ?`,
        args: [empCode],
      });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });
      return res.status(200).json({ success: true, employee: r.rows[0] });
    }

    if (action === 'add-employee' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const empName = String(body.empName || '').trim();
      const role = String(body.role || 'employee').toLowerCase();
      const allowedRoles = new Set(['employee', 'manager', 'buyer', 'owner', 'admin']);
      if (!empCode || !empName) return res.status(200).json({ success: false, error: 'Employee ID and Name are required' });
      if (!allowedRoles.has(role)) return res.status(200).json({ success: false, error: 'Invalid role' });

      const exists = await db.execute({ sql: `SELECT 1 FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (exists.rows.length) return res.status(200).json({ success: false, error: 'Employee with this ID already exists' });

      const initialPassword = String(body.initialPassword || ('MB@' + empCode));
      const hash = await hashPassword(initialPassword);

      await db.execute({
        sql: `INSERT INTO employees
              (emp_code, emp_name, emp_designation, emp_mobile, store_name, store_code, role,
               password_hash, is_first_login, must_change_password, store_status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'Active')`,
        args: [
          empCode, empName,
          String(body.empDesignation || ''),
          String(body.empMobile || ''),
          String(body.storeName || ''),
          String(body.storeCode || ''),
          role,
          hash,
        ],
      });
      return res.status(200).json({ success: true, defaultPassword: initialPassword });
    }

    if (action === 'reset-password' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      if (!empCode) return res.status(200).json({ success: false, error: 'empCode required' });
      const newPassword = String(body.newPassword || ('MB@' + empCode));

      const exists = await db.execute({ sql: `SELECT emp_code FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (!exists.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });

      const hash = await hashPassword(newPassword);
      await db.execute({
        sql: `UPDATE employees
              SET password_hash = ?,
                  must_change_password = 1,
                  password_changed_at = NULL
              WHERE emp_code = ?`,
        args: [hash, empCode],
      });
      // Push reset password into history so user cannot pick the same default again
      await db.execute({
        sql: `INSERT INTO employee_password_history (emp_code, password_hash) VALUES (?, ?)`,
        args: [empCode, hash],
      });
      // Trim history
      await db.execute({
        sql: `DELETE FROM employee_password_history
              WHERE emp_code = ?
                AND id NOT IN (
                  SELECT id FROM employee_password_history
                  WHERE emp_code = ? ORDER BY created_at DESC LIMIT 3
                )`,
        args: [empCode, empCode],
      });
      // Invalidate any active sessions for that employee.
      await db.execute({ sql: `DELETE FROM auth_sessions WHERE emp_code = ?`, args: [empCode] });
      return res.status(200).json({ success: true, password: newPassword });
    }

    if (action === 'toggle-status' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const status = String(body.status || '').trim();
      if (!empCode || !['Active', 'Inactive'].includes(status)) {
        return res.status(200).json({ success: false, error: 'Invalid empCode or status' });
      }
      const exists = await db.execute({ sql: `SELECT emp_code FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (!exists.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });

      await db.execute({
        sql: `UPDATE employees SET store_status = ? WHERE emp_code = ?`,
        args: [status, empCode],
      });
      if (status === 'Inactive') {
        await db.execute({ sql: `DELETE FROM auth_sessions WHERE emp_code = ?`, args: [empCode] });
      }
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method or action not allowed' });
  } catch (err) {
    console.error('[api/admin]', err);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

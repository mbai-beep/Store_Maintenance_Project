// api/auth.js - login / verify / change-password / reset-password / accept-tc
const { getDB, ensureSchema } = require('../lib/db');
const {
  hashPassword, verifyPassword, createSession, getEmployeeByToken,
  tokenFromReq, isPasswordExpired, isPasswordReused, pushPasswordHistory,
  publicEmployee, readJson,
} = require('../lib/auth');

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const action = (req.query && req.query.action) || '';

    if (action === 'verify' && req.method === 'GET') {
      const token = tokenFromReq(req);
      const emp = await getEmployeeByToken(token);
      if (!emp || emp.store_status !== 'Active') return res.status(200).json({ valid: false });
      return res.status(200).json({ valid: true, user: publicEmployee(emp) });
    }

    if (action === 'login' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const password = String(body.password || '');
      const remember = !!body.remember;
      if (!empCode || !password) return res.status(200).json({ success: false, error: 'Employee ID and password are required' });

      const db = getDB();
      const r = await db.execute({ sql: `SELECT * FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'Invalid Employee ID or password' });
      const emp = r.rows[0];

      if (emp.store_status !== 'Active') {
        return res.status(200).json({ success: false, error: 'Account deactivated. Contact admin.' });
      }

      const ok = await verifyPassword(password, emp.password_hash);
      if (!ok) return res.status(200).json({ success: false, error: 'Invalid Employee ID or password' });

      const token = await createSession(empCode, remember);
      const expired = isPasswordExpired(emp);

      return res.status(200).json({
        success: true,
        token,
        employee: publicEmployee(emp),
        passwordExpired: expired,
        tcAccepted: !!emp.tc_accepted,
      });
    }

    if (action === 'change-password' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');

      if (!empCode || !currentPassword || !newPassword) {
        return res.status(200).json({ success: false, error: 'All fields are required' });
      }
      if (newPassword.length < 6) {
        return res.status(200).json({ success: false, error: 'Password must be at least 6 characters' });
      }
      if (newPassword === currentPassword) {
        return res.status(200).json({ success: false, error: 'New password cannot match current password' });
      }

      const db = getDB();
      const r = await db.execute({ sql: `SELECT * FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });
      const emp = r.rows[0];
      if (emp.store_status !== 'Active') {
        return res.status(200).json({ success: false, error: 'Account deactivated' });
      }

      const ok = await verifyPassword(currentPassword, emp.password_hash);
      if (!ok) return res.status(200).json({ success: false, error: 'Current password is incorrect' });

      if (await isPasswordReused(empCode, newPassword)) {
        return res.status(200).json({ success: false, error: 'You cannot reuse any of your last 3 passwords' });
      }

      const hash = await hashPassword(newPassword);
      await pushPasswordHistory(empCode, hash);
      await db.execute({
        sql: `UPDATE employees SET password_hash = ?, password_changed_at = datetime('now'),
                                   must_change_password = 0, is_first_login = 0
              WHERE emp_code = ?`,
        args: [hash, empCode],
      });

      return res.status(200).json({ success: true });
    }

    if (action === 'reset-password' && req.method === 'POST') {
      // OTP-driven forgot-password reset.
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const newPassword = String(body.newPassword || '');
      const resetToken = String(body.resetToken || '');
      if (!empCode || !newPassword || !resetToken) {
        return res.status(200).json({ success: false, error: 'All fields are required' });
      }
      if (newPassword.length < 6) {
        return res.status(200).json({ success: false, error: 'Password must be at least 6 characters' });
      }

      const db = getDB();
      const otp = await db.execute({
        sql: `SELECT * FROM otp_codes WHERE emp_code = ? AND reset_token = ? AND verified = 1`,
        args: [empCode, resetToken],
      });
      if (!otp.rows.length) return res.status(200).json({ success: false, error: 'Invalid or expired reset token' });
      if (new Date(otp.rows[0].expires_at).getTime() < Date.now()) {
        return res.status(200).json({ success: false, error: 'Reset token expired. Restart the forgot-password flow.' });
      }

      const r = await db.execute({ sql: `SELECT * FROM employees WHERE emp_code = ?`, args: [empCode] });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });

      if (await isPasswordReused(empCode, newPassword)) {
        return res.status(200).json({ success: false, error: 'You cannot reuse any of your last 3 passwords' });
      }

      const hash = await hashPassword(newPassword);
      await pushPasswordHistory(empCode, hash);
      await db.execute({
        sql: `UPDATE employees SET password_hash = ?, password_changed_at = datetime('now'),
                                   must_change_password = 0, is_first_login = 0
              WHERE emp_code = ?`,
        args: [hash, empCode],
      });
      // Burn the reset token
      await db.execute({ sql: `DELETE FROM otp_codes WHERE emp_code = ?`, args: [empCode] });
      return res.status(200).json({ success: true });
    }

    if (action === 'accept-tc' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      if (!empCode) return res.status(200).json({ success: false, error: 'empCode required' });
      const db = getDB();
      await db.execute({
        sql: `UPDATE employees SET tc_accepted = 1 WHERE emp_code = ?`,
        args: [empCode],
      });
      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method or action not allowed' });
  } catch (err) {
    console.error('[api/auth]', err);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

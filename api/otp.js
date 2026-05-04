// api/otp.js - OTP send + verify for forgot-password.
// Demo mode: returns OTP in response when SMS env vars are missing (Fast2SMS, MSG91, etc.).
const { getDB, ensureSchema } = require('../lib/db');
const { newToken, readJson } = require('../lib/auth');

const OTP_TTL_MIN = 5;

function genOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendSmsViaFast2SMS(mobile, otp) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return { sent: false, demo: true };
  const url = 'https://www.fast2sms.com/dev/bulkV2';
  const params = new URLSearchParams({
    authorization: apiKey,
    sender_id: 'TXTIND',
    message: 'Your MB Store Maintenance OTP is ' + otp + '. Valid for 5 minutes.',
    language: 'english',
    route: 'q',
    numbers: mobile,
  });
  try {
    const r = await fetch(url + '?' + params.toString());
    return { sent: r.ok, demo: false };
  } catch (e) {
    console.warn('[api/otp] Fast2SMS failed:', e.message);
    return { sent: false, demo: false };
  }
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const action = (req.query && req.query.action) || '';
    const db = getDB();

    if (action === 'send' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const mobile = String(body.mobile || '').trim();
      if (!empCode || !/^\d{10}$/.test(mobile)) {
        return res.status(200).json({ success: false, error: 'Valid Employee ID and 10-digit mobile required' });
      }
      const r = await db.execute({
        sql: `SELECT emp_code, emp_mobile, store_status FROM employees WHERE emp_code = ?`,
        args: [empCode],
      });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'Employee not found' });
      const emp = r.rows[0];
      if (emp.store_status !== 'Active') {
        return res.status(200).json({ success: false, error: 'Account deactivated. Contact admin.' });
      }
      if (emp.emp_mobile && String(emp.emp_mobile).replace(/\D/g, '').slice(-10) !== mobile) {
        return res.status(200).json({ success: false, error: 'Mobile number does not match our records' });
      }

      const otp = genOtp();
      const expires = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();
      await db.execute({
        sql: `INSERT INTO otp_codes (emp_code, mobile, otp, verified, expires_at)
              VALUES (?, ?, ?, 0, ?)
              ON CONFLICT(emp_code) DO UPDATE SET
                mobile = excluded.mobile,
                otp = excluded.otp,
                verified = 0,
                reset_token = NULL,
                created_at = datetime('now'),
                expires_at = excluded.expires_at`,
        args: [empCode, mobile, otp, expires],
      });

      const result = await sendSmsViaFast2SMS(mobile, otp);
      const payload = { success: true };
      if (result.demo || !result.sent) {
        payload.demo = true;
        payload.otp = otp; // surface OTP only when SMS was not actually sent
      }
      return res.status(200).json(payload);
    }

    if (action === 'verify' && req.method === 'POST') {
      const body = await readJson(req);
      const empCode = parseInt(body.empCode, 10);
      const otp = String(body.otp || '').trim();
      if (!empCode || !/^\d{6}$/.test(otp)) {
        return res.status(200).json({ success: false, error: 'Valid 6-digit OTP required' });
      }
      const r = await db.execute({
        sql: `SELECT * FROM otp_codes WHERE emp_code = ?`,
        args: [empCode],
      });
      if (!r.rows.length) return res.status(200).json({ success: false, error: 'No OTP requested. Restart the flow.' });
      const row = r.rows[0];
      if (new Date(row.expires_at).getTime() < Date.now()) {
        return res.status(200).json({ success: false, error: 'OTP expired. Request a new one.' });
      }
      if (String(row.otp) !== otp) {
        return res.status(200).json({ success: false, error: 'Invalid OTP' });
      }
      const resetToken = newToken();
      await db.execute({
        sql: `UPDATE otp_codes SET verified = 1, reset_token = ? WHERE emp_code = ?`,
        args: [resetToken, empCode],
      });
      return res.status(200).json({ success: true, resetToken });
    }

    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method or action not allowed' });
  } catch (err) {
    console.error('[api/otp]', err);
    return res.status(500).json({ success: false, error: err.message || 'internal_error' });
  }
};

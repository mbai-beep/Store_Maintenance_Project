// lib/auth.js - password hashing, token issuance, expiry checks.
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getDB } = require('./db');

const PASSWORD_EXPIRY_DAYS = 60;
const PASSWORD_HISTORY_DEPTH = 3;
const REMEMBER_DAYS = 30;
const SESSION_DAYS = 1; // when "remember me" is unchecked

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

async function verifyPassword(plain, hash) {
  if (!plain || !hash) return false;
  try { return await bcrypt.compare(String(plain), String(hash)); }
  catch { return false; }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(empCode, remember) {
  const db = getDB();
  const token = newToken();
  const days = remember ? REMEMBER_DAYS : SESSION_DAYS;
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  await db.execute({
    sql: `INSERT INTO auth_sessions (token, emp_code, expires_at, remember) VALUES (?, ?, ?, ?)`,
    args: [token, empCode, expires, remember ? 1 : 0],
  });
  return token;
}

async function getEmployeeByToken(token) {
  if (!token) return null;
  const db = getDB();
  const session = await db.execute({
    sql: `SELECT emp_code, expires_at FROM auth_sessions WHERE token = ?`,
    args: [token],
  });
  if (!session.rows.length) return null;
  const row = session.rows[0];
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.execute({ sql: `DELETE FROM auth_sessions WHERE token = ?`, args: [token] });
    return null;
  }
  const emp = await db.execute({
    sql: `SELECT * FROM employees WHERE emp_code = ?`,
    args: [row.emp_code],
  });
  if (!emp.rows.length) return null;
  return emp.rows[0];
}

async function deleteSession(token) {
  if (!token) return;
  const db = getDB();
  await db.execute({ sql: `DELETE FROM auth_sessions WHERE token = ?`, args: [token] });
}

function tokenFromReq(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

function isPasswordExpired(employee) {
  if (employee.must_change_password) return true;
  if (employee.is_first_login) return true;
  if (!employee.password_changed_at) return true;
  const ms = Date.now() - new Date(employee.password_changed_at).getTime();
  return ms > PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

// Returns true if newPassword matches any of the last N stored passwords.
async function isPasswordReused(empCode, newPassword) {
  const db = getDB();
  const r = await db.execute({
    sql: `SELECT password_hash FROM employee_password_history WHERE emp_code = ? ORDER BY created_at DESC LIMIT ?`,
    args: [empCode, PASSWORD_HISTORY_DEPTH],
  });
  for (const row of r.rows) {
    if (await verifyPassword(newPassword, row.password_hash)) return true;
  }
  return false;
}

async function pushPasswordHistory(empCode, hash) {
  const db = getDB();
  await db.execute({
    sql: `INSERT INTO employee_password_history (emp_code, password_hash) VALUES (?, ?)`,
    args: [empCode, hash],
  });
  // Trim to last N
  await db.execute({
    sql: `DELETE FROM employee_password_history
          WHERE emp_code = ?
            AND id NOT IN (
              SELECT id FROM employee_password_history
              WHERE emp_code = ? ORDER BY created_at DESC LIMIT ?
            )`,
    args: [empCode, empCode, PASSWORD_HISTORY_DEPTH],
  });
}

function publicEmployee(emp) {
  return {
    empCode: emp.emp_code,
    empName: emp.emp_name,
    designation: emp.emp_designation || '',
    mobile: emp.emp_mobile || '',
    storeName: emp.store_name || '',
    storeCode: emp.store_code || '',
    role: emp.role || 'employee',
    isFirstLogin: !!emp.is_first_login,
    mustChangePassword: !!emp.must_change_password,
    tcAccepted: !!emp.tc_accepted,
    storeStatus: emp.store_status || 'Active',
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let d = '';
    req.on('data', c => { d += c; });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

module.exports = {
  PASSWORD_EXPIRY_DAYS,
  PASSWORD_HISTORY_DEPTH,
  hashPassword,
  verifyPassword,
  createSession,
  getEmployeeByToken,
  deleteSession,
  tokenFromReq,
  isPasswordExpired,
  isPasswordReused,
  pushPasswordHistory,
  publicEmployee,
  readJson,
  newToken,
};

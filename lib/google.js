// lib/google.js
// Shared Google auth helper. Reads a Service Account JSON from the
// GOOGLE_SERVICE_ACCOUNT_JSON environment variable (stringified JSON),
// and returns authenticated Sheets + Drive clients.

const { google } = require('googleapis');

let cached = null;

function getAuth() {
  if (cached) return cached;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is missing');

  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }

  // Vercel env vars turn real newlines into the literal string "\n" — fix that.
  if (creds.private_key && creds.private_key.includes('\\n')) {
    creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  cached = {
    auth,
    sheets: google.sheets({ version: 'v4', auth }),
    drive:  google.drive({ version: 'v3', auth }),
  };
  return cached;
}

// Sheet layout (row 1 = headers). Keep column order stable.
const SHEET_HEADERS = [
  'id',
  'createdAt',
  'storeName',
  'storeCode',
  'requirements',
  'employee',
  'employeeId',
  'status',
  'photoCount',
  'photoUrls',
];

const SHEET_TAB = process.env.SHEET_TAB_NAME || 'Requests';
const SHEET_RANGE = `${SHEET_TAB}!A:J`;

async function ensureHeaderRow() {
  const { sheets } = getAuth();
  const SHEET_ID = process.env.SHEET_ID;
  if (!SHEET_ID) throw new Error('SHEET_ID env var is missing');

  // Read row 1
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_TAB}!1:1`,
  });
  const row1 = (res.data.values && res.data.values[0]) || [];
  const headersMatch = SHEET_HEADERS.every((h, i) => row1[i] === h);
  if (!headersMatch) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_TAB}!A1:J1`,
      valueInputOption: 'RAW',
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

module.exports = {
  getAuth,
  ensureHeaderRow,
  SHEET_HEADERS,
  SHEET_TAB,
  SHEET_RANGE,
};

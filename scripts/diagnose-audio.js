#!/usr/bin/env node
// scripts/diagnose-audio.js
// Reads audioUrl values from the latest Sheet entries, then for each one:
//   1. Calls Drive API to get file size + mimeType
//   2. Hits your live /api/file?id=X&debug=1 endpoint
//   3. Reports if the file is empty, healthy, or unreachable
//
// Usage:
//   $env:DEPLOY_URL="https://store-maintenance-project.vercel.app"
//   node scripts/diagnose-audio.js
//
// Reads .env.local automatically for GOOGLE_SERVICE_ACCOUNT_JSON, SHEET_ID, SHEET_TAB_NAME

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const https = require('https');

// Load .env.local
function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^﻿?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] = m[2];
  }
}
loadEnv();

const DEPLOY_URL = process.env.DEPLOY_URL || 'https://store-maintenance-project.vercel.app';

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

(async () => {
  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) { console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON'); process.exit(1); }
    const creds = JSON.parse(raw);
    if (creds.private_key.includes('\\n')) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const drive = google.drive({ version: 'v3', auth });

    const sheetId = process.env.SHEET_ID;
    const tab = process.env.SHEET_TAB_NAME || 'Requests';
    console.log('Reading Sheet ' + sheetId + ' / ' + tab);
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab + '!A:Q' });
    const rows = r.data.values || [];
    if (rows.length < 2) { console.log('No entries in sheet'); return; }
    const header = rows[0];
    const audioColIdx = header.indexOf('audioUrl');
    if (audioColIdx === -1) { console.log('No audioUrl column. Headers:', header); return; }

    // Find the last 3 rows with non-empty audioUrl
    const withAudio = [];
    for (let i = rows.length - 1; i > 0 && withAudio.length < 3; i--) {
      const audioUrl = rows[i][audioColIdx];
      if (audioUrl && audioUrl.trim()) {
        withAudio.push({ rowIdx: i, id: rows[i][0], audioUrl, employeeId: rows[i][7], createdAt: rows[i][1] });
      }
    }
    if (withAudio.length === 0) { console.log('No entries with audioUrl found'); return; }

    console.log('\nFound ' + withAudio.length + ' recent entries with audio. Diagnosing each:\n');
    for (const e of withAudio) {
      console.log('========================================================');
      console.log('Entry: ' + e.id + '  (' + e.createdAt + ', empId=' + e.employeeId + ')');
      const m = String(e.audioUrl).match(/[?&\/]id=([^&\/]+)/);
      const fileId = m ? m[1] : null;
      console.log('audioUrl: ' + e.audioUrl);
      console.log('extracted Drive fileId: ' + fileId);
      if (!fileId) { console.log('!! Could not extract Drive ID from audioUrl'); continue; }

      // Test 1: Drive API direct (server-to-server)
      try {
        const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType,size,trashed', supportsAllDrives: true });
        console.log('Drive API meta: name=' + meta.data.name + '  mimeType=' + meta.data.mimeType + '  size=' + meta.data.size + ' bytes  trashed=' + meta.data.trashed);
        if (parseInt(meta.data.size || '0', 10) === 0) console.log('  !! FILE IS 0 BYTES - upload was empty');
      } catch (err) { console.log('Drive API error: ' + (err.errors ? err.errors[0].message : err.message)); }

      // Test 2: Hit deployed /api/file?id=X&debug=1
      try {
        const resp = await httpGet(DEPLOY_URL + '/api/file?id=' + fileId + '&debug=1');
        console.log('Deployed /api/file?debug=1 status=' + resp.status);
        console.log('  body: ' + resp.body.slice(0, 400));
      } catch (err) { console.log('Deployed proxy debug call FAILED: ' + err.message); }

      // Test 3: HEAD-style probe of actual streaming endpoint (no debug)
      try {
        const resp2 = await new Promise((resolve, reject) => {
          https.get(DEPLOY_URL + '/api/file?id=' + fileId, { headers: { 'Range': 'bytes=0-1' }, timeout: 15000 }, (res) => {
            let body = '';
            let received = 0;
            res.on('data', (c) => { received += c.length; if (body.length < 500) body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytesReceived: received }));
          }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
        });
        console.log('Deployed /api/file streaming test: status=' + resp2.status + '  bytesReceived=' + resp2.bytesReceived);
        console.log('  Content-Type: ' + resp2.headers['content-type']);
        console.log('  Content-Length: ' + resp2.headers['content-length']);
        console.log('  Accept-Ranges: ' + resp2.headers['accept-ranges']);
        console.log('  Content-Range: ' + resp2.headers['content-range']);
      } catch (err) { console.log('Streaming probe FAILED: ' + err.message); }
      console.log('');
    }
    console.log('Done.');
  } catch (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
  }
})();

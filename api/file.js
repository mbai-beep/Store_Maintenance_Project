// api/file.js - audio/file proxy from Drive.
// Uses raw https streaming + Range forwarding + redirect handling (this is the
// pattern that works reliably in Vercel functions; the googleapis library
// buffers responses in ways that break <audio> playback).
const { google } = require('googleapis');
const https = require('https');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONAL',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range'
};

module.exports = async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing file id' });

  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var');
    let serviceAccount;
    try { serviceAccount = JSON.parse(raw); }
    catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
    if (serviceAccount.private_key && serviceAccount.private_key.includes('\\n')) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    const [accessToken, meta] = await Promise.all([
      auth.getAccessToken(),
      drive.files.get({ fileId: id, fields: 'mimeType,name,size', supportsAllDrives: true })
    ]);

    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const fileSize = parseInt(meta.data.size || '0', 10);
    const rangeHeader = req.headers['range'];

    // Debug mode: return JSON metadata
    if (req.query.debug) {
      return res.status(200).json({
        id, name: meta.data.name, mimeType,
        sizeBytes: fileSize,
        sizeHuman: fileSize > 1024 * 1024
          ? (fileSize / (1024 * 1024)).toFixed(2) + ' MB'
          : (fileSize / 1024).toFixed(2) + ' KB',
      });
    }

    // Always advertise Range support so audio elements can seek
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');

    const driveUrl = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true';
    const reqHeaders = { Authorization: 'Bearer ' + accessToken };
    let statusCode = 200;

    if (rangeHeader && fileSize) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : fileSize - 1;
        reqHeaders['Range'] = 'bytes=' + start + '-' + end;
        res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + fileSize);
        res.setHeader('Content-Length', String(end - start + 1));
        statusCode = 206;
      }
    } else if (fileSize) {
      res.setHeader('Content-Length', String(fileSize));
    }

    // Stream via raw HTTPS so Range headers and 30x redirects propagate correctly
    await new Promise((resolve, reject) => {
      function stream(url, attempt) {
        https.get(url, { headers: reqHeaders }, (driveRes) => {
          if ((driveRes.statusCode === 301 || driveRes.statusCode === 302) && attempt < 5) {
            driveRes.resume();
            return stream(driveRes.headers.location, attempt + 1);
          }
          res.writeHead(statusCode);
          driveRes.pipe(res);
          driveRes.on('end', resolve);
          driveRes.on('error', reject);
        }).on('error', reject);
      }
      stream(driveUrl, 0);
    });

  } catch (err) {
    console.error('[api/file]', err && err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message || 'file_error' });
  }
};

// api/upload.js
// POST /api/upload  (application/json: { photo: base64, filename, mimeType, storeCode, employeeId })
// Decodes base64 payload, streams to Google Drive. Zero external parser deps.

const { getAuth } = require('../lib/google');
const { Readable } = require('stream');

// Allow up to 15 MB JSON body (base64 inflates ~33% vs raw bytes, so ~11 MB raw photo).
module.exports.config = {
  api: { bodyParser: { sizeLimit: '15mb' } },
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
  if (!DRIVE_FOLDER_ID) return res.status(500).json({ error: 'DRIVE_FOLDER_ID env var is missing' });

  try {
    let body = req.body;
    if (!body || typeof body !== 'object') {
      body = await new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', c => { raw += c; });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
      });
    }

    const { photo, filename, mimeType, storeCode, employeeId } = body || {};
    if (!photo) return res.status(400).json({ error: 'photo (base64) is required' });

    const buf = Buffer.from(photo, 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'photo payload decoded to 0 bytes' });

    const origName = filename || 'photo.jpg';
    const ext      = (origName.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
    const stamp    = new Date().toISOString().replace(/[:.]/g, '-');
    const driveName = `${storeCode || 'UNKNOWN'}__${employeeId || 'UNKNOWN'}__${stamp}${ext}`;

    const { drive } = getAuth();
    const mt = mimeType || 'image/jpeg';

    const createRes = await drive.files.create({
      requestBody: { name: driveName, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType: mt, body: Readable.from(buf) },
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    const fileId = createRes.data.id;

    try {
      await drive.permissions.create({
        fileId, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true,
      });
    } catch (permErr) { console.warn('[api/upload] permission set failed:', permErr.message); }

    const viewUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
    const openUrl = createRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    res.status(200).json({ success: true, id: fileId, name: driveName, url: viewUrl, openUrl });
  } catch (err) {
    console.error('[api/upload]', err);
    res.status(500).json({ error: err.message || 'upload_error' });
  }
};

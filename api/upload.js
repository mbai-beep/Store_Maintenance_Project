// api/upload.js
// POST /api/upload  (multipart: photo, storeCode, employeeId)
const { getAuth } = require('../lib/google');
const { formidable } = require('formidable');
const fs = require('fs');

module.exports.config = { api: { bodyParser: false } };

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: false, maxFileSize: 15 * 1024 * 1024, keepExtensions: true });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}
function pickFirst(v) { return Array.isArray(v) ? v[0] : v; }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
  if (!DRIVE_FOLDER_ID) return res.status(500).json({ error: 'DRIVE_FOLDER_ID env var is missing' });

  try {
    const { fields, files } = await parseForm(req);
    const photo = pickFirst(files.photo);
    if (!photo) return res.status(400).json({ error: 'photo file is required' });

    const storeCode  = pickFirst(fields.storeCode)  || 'UNKNOWN';
    const employeeId = pickFirst(fields.employeeId) || 'UNKNOWN';
    const origName   = photo.originalFilename || 'photo.jpg';
    const ext        = (origName.match(/\.[a-z0-9]+$/i) || ['.jpg'])[0];
    const stamp      = new Date().toISOString().replace(/[:.]/g, '-');
    const driveName  = `${storeCode}__${employeeId}__${stamp}${ext}`;

    const { drive } = getAuth();
    const mimeType = photo.mimetype || 'image/jpeg';
    const fileStream = fs.createReadStream(photo.filepath);

    const createRes = await drive.files.create({
      requestBody: { name: driveName, parents: [DRIVE_FOLDER_ID] },
      media: { mimeType, body: fileStream },
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    const fileId = createRes.data.id;

    try {
      await drive.permissions.create({
        fileId, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true,
      });
    } catch (permErr) { console.warn('[api/upload] permission set failed:', permErr.message); }

    try { fs.unlinkSync(photo.filepath); } catch (e) {}

    const viewUrl = `https://drive.google.com/uc?export=view&id=${fileId}`;
    const openUrl = createRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

    res.status(200).json({ success: true, id: fileId, name: driveName, url: viewUrl, openUrl });
  } catch (err) {
    console.error('[api/upload]', err);
    res.status(500).json({ error: err.message || 'upload_error' });
  }
};

// api/upload.js - photo/audio upload to Drive, one subfolder per storeCode.
// Accepts both legacy (photo, filename) and new (fileData, fileName) field names.
const { getAuth } = require('../lib/google');
const { Readable } = require('stream');

module.exports.config = {
  api: { bodyParser: { sizeLimit: '15mb' } },
};

const _folderCache = new Map();

function sanitizeFolderName(raw) {
  const s = String(raw || 'UNKNOWN').trim().replace(/[^\w\-]/g, '_').toUpperCase();
  return s || 'UNKNOWN';
}

async function getOrCreateStoreFolder(drive, parentId, storeCode) {
  const name = sanitizeFolderName(storeCode);
  const cacheKey = parentId + ':' + name;
  if (_folderCache.has(cacheKey)) return _folderCache.get(cacheKey);

  const safeForQuery = name.replace(/'/g, "\\'");
  const q = "'" + parentId + "' in parents and name='" + safeForQuery + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";

  const list = await drive.files.list({
    q,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    pageSize: 1,
  });

  let id;
  if (list.data.files && list.data.files.length > 0) {
    id = list.data.files[0].id;
  } else {
    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    id = created.data.id;
  }
  _folderCache.set(cacheKey, id);
  return id;
}

function stripDataUrl(s) {
  if (typeof s !== 'string') return s;
  const m = s.match(/^data:[^;]+;base64,(.*)$/);
  return m ? m[1] : s;
}

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

    const data     = body.fileData || body.photo;
    const fileName = body.fileName || body.filename || ('upload_' + Date.now() + '.bin');
    const mimeType = body.mimeType || 'application/octet-stream';
    const storeCode = body.storeCode || body.store || 'UNKNOWN';
    const employeeId = body.employeeId || body.empCode || 'UNKNOWN';

    if (!data) return res.status(400).json({ error: 'fileData (or photo) is required' });

    const buf = Buffer.from(stripDataUrl(data), 'base64');
    if (buf.length === 0) return res.status(400).json({ error: 'payload decoded to 0 bytes' });

    const ext   = (fileName.match(/\.[a-z0-9]+$/i) || ['.bin'])[0];
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const driveName = sanitizeFolderName(storeCode) + '__' + employeeId + '__' + stamp + ext;

    const { drive } = getAuth();
    const storeFolderId = await getOrCreateStoreFolder(drive, DRIVE_FOLDER_ID, storeCode);

    const createRes = await drive.files.create({
      requestBody: { name: driveName, parents: [storeFolderId] },
      media: { mimeType, body: Readable.from(buf) },
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    const fileId = createRes.data.id;

    try {
      await drive.permissions.create({
        fileId, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true,
      });
    } catch (permErr) { console.warn('[api/upload] permission set failed:', permErr.message); }

    const viewUrl = 'https://drive.google.com/uc?export=view&id=' + fileId;
    const openUrl = createRes.data.webViewLink || ('https://drive.google.com/file/d/' + fileId + '/view');

    res.status(200).json({ success: true, id: fileId, name: driveName, url: viewUrl, openUrl, folder: sanitizeFolderName(storeCode) });
  } catch (err) {
    console.error('[api/upload]', err);
    res.status(500).json({ error: err.message || 'upload_error' });
  }
};

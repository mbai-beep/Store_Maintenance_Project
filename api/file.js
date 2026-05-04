// api/file.js - audio/file proxy from Drive (used because the frontend hits /api/file?id=...)
const { getAuth } = require('../lib/google');

module.exports = async function handler(req, res) {
  const id = req.query && req.query.id;
  if (!id) return res.status(400).json({ error: 'id query param required' });
  try {
    const { drive } = getAuth();
    const meta = await drive.files.get({ fileId: id, fields: 'id, name, mimeType', supportsAllDrives: true });
    const stream = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    stream.data.on('error', err => {
      console.error('[api/file] stream error', err);
      try { res.status(500).end(); } catch {}
    }).pipe(res);
  } catch (err) {
    console.error('[api/file]', err);
    res.status(500).json({ error: err.message || 'file_error' });
  }
};

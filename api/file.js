// api/file.js - audio/file proxy from Drive with HTTP Range support.
// Audio elements need 206 Partial Content responses to play/seek properly.
const { getAuth } = require('../lib/google');

module.exports = async function handler(req, res) {
  const id = req.query && req.query.id;
  if (!id) { res.status(400).json({ error: 'id query param required' }); return; }

  try {
    const { drive } = getAuth();

    // Get metadata for mime + size
    const meta = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true,
    });
    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const totalSize = parseInt(meta.data.size, 10);

    // Forward Range header to Drive if present
    const rangeHeader = req.headers && req.headers.range;
    const driveHeaders = {};
    if (rangeHeader) driveHeaders.Range = rangeHeader;

    const driveResp = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream', headers: driveHeaders }
    );

    // Pass through useful headers from Drive's response
    const upstreamStatus = driveResp.status || 200;
    const upstreamRange  = driveResp.headers && driveResp.headers['content-range'];
    const upstreamLen    = driveResp.headers && driveResp.headers['content-length'];

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (upstreamLen) res.setHeader('Content-Length', upstreamLen);
    if (upstreamRange) res.setHeader('Content-Range', upstreamRange);
    if (Number.isFinite(totalSize) && !upstreamLen && !rangeHeader) {
      res.setHeader('Content-Length', String(totalSize));
    }

    res.status(upstreamStatus === 206 ? 206 : 200);

    driveResp.data
      .on('error', err => {
        console.error('[api/file] stream error', err && err.message);
        try { res.status(500).end(); } catch (_) {}
      })
      .pipe(res);
  } catch (err) {
    console.error('[api/file]', err && err.message);
    if (!res.headersSent) {
      res.status(err && err.code === 404 ? 404 : 500).json({ error: err.message || 'file_error' });
    }
  }
};

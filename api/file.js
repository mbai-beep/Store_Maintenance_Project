// api/file.js - audio/file proxy from Drive.
// Buffers the file in memory (OK for short voice notes < 4MB), then handles
// HTTP Range requests manually. This avoids Vercel's serverless streaming quirks
// that cause audio elements to show 0:00 duration.
//
// Debug: append &debug=1 to see metadata as JSON instead of file bytes.
const { getAuth } = require('../lib/google');

module.exports = async function handler(req, res) {
  const id = req.query && req.query.id;
  if (!id) { res.status(400).json({ error: 'id query param required' }); return; }

  try {
    const { drive } = getAuth();

    // 1. Metadata
    const meta = await drive.files.get({
      fileId: id,
      fields: 'id, name, mimeType, size',
      supportsAllDrives: true,
    });
    const mimeType = meta.data.mimeType || 'application/octet-stream';
    const declaredSize = parseInt(meta.data.size, 10) || 0;

    // 2. Debug mode - just return metadata for troubleshooting
    if (req.query && req.query.debug) {
      return res.status(200).json({
        id: meta.data.id,
        name: meta.data.name,
        mimeType,
        sizeBytes: declaredSize,
        sizeHuman: declaredSize > 1024 * 1024
          ? (declaredSize / (1024 * 1024)).toFixed(2) + ' MB'
          : (declaredSize / 1024).toFixed(2) + ' KB',
        directLink: 'https://drive.google.com/uc?export=download&id=' + meta.data.id,
      });
    }

    // 3. Fetch entire file as a Buffer (avoids Vercel streaming issues)
    const fileResp = await drive.files.get(
      { fileId: id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const fullBuf = Buffer.from(fileResp.data);

    // 4. Handle HTTP Range request manually
    const rangeHeader = req.headers && req.headers.range;
    if (rangeHeader) {
      const m = String(rangeHeader).match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : fullBuf.length - 1;
        if (start >= fullBuf.length) {
          res.status(416).setHeader('Content-Range', 'bytes */' + fullBuf.length).end();
          return;
        }
        const chunk = fullBuf.slice(start, end + 1);
        res.statusCode = 206;
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + fullBuf.length);
        res.setHeader('Content-Length', String(chunk.length));
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.end(chunk);
      }
    }

    // 5. No Range header: full response
    res.statusCode = 200;
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(fullBuf.length));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(fullBuf);

  } catch (err) {
    console.error('[api/file]', err && err.message);
    if (!res.headersSent) {
      const status = err && (err.code === 404 || err.response && err.response.status === 404) ? 404 : 500;
      res.status(status).json({ error: err.message || 'file_error' });
    }
  }
};

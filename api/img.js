// Vercel serverless function: serves a character image from this site's own domain,
// so the editor can draw it on the canvas and export/print it.
//   /api/img?id=<Google Drive file id>
//   /api/img?u=<image URL>   only from the allowed hosts below (not an open proxy)
const ALLOWED = [
  /^https:\/\/static\.wikia\.nocookie\.net\/zombicide\/images\/[0-9a-f]\/[0-9a-f]{2}\/[^/?#]+\/revision\/latest(\/scale-to-width-down\/\d+)?(\?[A-Za-z0-9=&_-]*)?$/,
];
const ALLOWED_FINAL_HOSTS = ['static.wikia.nocookie.net', 'drive.google.com', 'lh3.googleusercontent.com', 'drive.usercontent.google.com'];

module.exports = async (req, res) => {
  const q = req.query || {};
  let src;
  if (q.u !== undefined) {
    const u = String(q.u);
    if (u.length > 400 || !ALLOWED.some(re => re.test(u))) { res.status(400).send('URL de imagen no permitida'); return; }
    src = u;
  } else {
    const id = String(q.id || '');
    if (!/^[A-Za-z0-9_-]{10,120}$/.test(id)) { res.status(400).send('ID de Drive no válido'); return; }
    src = `https://drive.google.com/thumbnail?sz=w2400&id=${id}`;
  }
  try {
    const r = await fetch(src, { redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    let host = '';
    try { host = new URL(r.url || src).hostname; } catch (e) {}
    if (!r.ok || !type.startsWith('image/') || !ALLOWED_FINAL_HOSTS.includes(host)) {
      res.status(404).send(q.u !== undefined ? 'Imagen no disponible.' : 'Imagen no disponible: comprueba que el archivo de Drive esté compartido con "cualquier persona con el enlace".');
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) { res.status(413).send('Imagen demasiado grande.'); return; }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).send('No se pudo descargar la imagen.');
  }
};

// Vercel serverless function: serves a Google Drive image from this site's own domain,
// so the editor can draw it on the canvas and export/print it.
// Only Drive file IDs are accepted (not arbitrary URLs).
module.exports = async (req, res) => {
  const id = String((req.query && req.query.id) || '');
  if (!/^[A-Za-z0-9_-]{10,120}$/.test(id)) {
    res.status(400).send('ID de Drive no válido');
    return;
  }
  try {
    const r = await fetch(`https://drive.google.com/thumbnail?sz=w2400&id=${id}`, { redirect: 'follow' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) {
      res.status(404).send('Imagen no disponible: comprueba que el archivo de Drive esté compartido con "cualquier persona con el enlace".');
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=2592000');
    res.status(200).send(buf);
  } catch (e) {
    res.status(502).send('No se pudo contactar con Google Drive.');
  }
};

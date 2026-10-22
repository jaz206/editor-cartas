// Private area API (only for the site owner).
// Reads the character database straight from GitHub and saves changes as a single commit
// (texts + uploaded images + default logo). Vercel redeploys the site after each commit.
//
// Environment variables (Vercel → Project → Settings → Environment Variables):
//   ADMIN_PASSWORD  password for the private area
//   GITHUB_TOKEN    fine-grained token with "Contents: Read and write" on this repository only
//   GITHUB_REPO     optional, default "jaz206/editor-cartas"
//   GITHUB_BRANCH   optional, default "main"
const crypto = require('crypto');

const DB_PATH = 'assets/personajes.json';
const LOGO_PATH = 'assets/logo_default.png';
const IMG_RE = /^assets\/pj\/[a-z0-9][a-z0-9-]{0,80}\.(png|webp|jpg)$/;
const MAX_FILE = 3.2 * 1024 * 1024; // bytes after decoding (Vercel accepts ~4.5 MB per request)

function cfg() {
  return {
    pass: process.env.ADMIN_PASSWORD || '',
    token: process.env.GITHUB_TOKEN || '',
    repo: process.env.GITHUB_REPO || 'jaz206/editor-cartas',
    branch: process.env.GITHUB_BRANCH || 'main',
  };
}

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function gh(c, path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${c.repo}${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: opts.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'editor-cartas-admin',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (opts.allow404 && r.status === 404) return null;
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    const err = new Error(`GitHub ${r.status}: ${txt.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return opts.accept && opts.accept.includes('raw') ? r.text() : r.json();
}

function imageKind(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  return null;
}

function checkDb(db) {
  if (!db || typeof db !== 'object' || !Array.isArray(db.hero) || !Array.isArray(db.zombie)) return 'La base debe tener las listas "hero" y "zombie".';
  for (const k of ['hero', 'zombie']) {
    for (const c of db[k]) {
      if (!c || typeof c !== 'object' || typeof c.n !== 'string' || !c.n.trim()) return 'Hay un personaje sin nombre.';
      for (const [f, v] of Object.entries(c)) {
        if (!['string', 'boolean', 'number'].includes(typeof v)) return `Campo no válido en ${c.n}: ${f}`;
        if (typeof v === 'string' && v.length > 2000) return `Texto demasiado largo en ${c.n}: ${f}`;
      }
      if (c.file && !IMG_RE.test(c.file)) return `Ruta de imagen no válida en ${c.n}.`;
    }
  }
  return null;
}

async function commitFiles(c, files, message, remove = []) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ref = await gh(c, `/git/ref/heads/${c.branch}`);
    const head = ref.object.sha;
    const commit = await gh(c, `/git/commits/${head}`);
    const tree = [];
    for (const f of files) {
      const blob = await gh(c, '/git/blobs', { method: 'POST', body: { content: f.content, encoding: f.encoding } });
      tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (const path of remove) {
      const exists = await gh(c, `/contents/${path}?ref=${head}`, { allow404: true });
      if (exists) tree.push({ path, mode: '100644', type: 'blob', sha: null });
    }
    const newTree = await gh(c, '/git/trees', { method: 'POST', body: { base_tree: commit.tree.sha, tree } });
    const newCommit = await gh(c, '/git/commits', { method: 'POST', body: { message, tree: newTree.sha, parents: [head] } });
    try {
      await gh(c, `/git/refs/heads/${c.branch}`, { method: 'PATCH', body: { sha: newCommit.sha, force: false } });
      return newCommit.sha;
    } catch (e) {
      if (e.status !== 422 || attempt) throw e; // branch moved meanwhile: retry once on top of it
    }
  }
}

module.exports = async (req, res) => {
  const c = cfg();
  res.setHeader('Cache-Control', 'no-store');
  if (!c.pass || !c.token) {
    res.status(503).json({ error: 'Falta configurar ADMIN_PASSWORD y GITHUB_TOKEN en Vercel.' });
    return;
  }
  const key = req.headers['x-admin-key'] || '';
  if (!key || !sameSecret(key, c.pass)) {
    await new Promise(r => setTimeout(r, 600)); // slows down password guessing
    res.status(401).json({ error: 'Contraseña incorrecta.' });
    return;
  }
  try {
    if (req.method === 'GET') {
      const raw = await gh(c, `/contents/${DB_PATH}?ref=${c.branch}`, { accept: 'application/vnd.github.raw+json' });
      const logo = await gh(c, `/contents/${LOGO_PATH}?ref=${c.branch}`, { allow404: true });
      res.status(200).json({ personajes: JSON.parse(raw), logo: !!logo });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Método no permitido.' });
      return;
    }
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body || '{}');
    body = body || {};
    const files = [];
    if (body.personajes !== undefined) {
      const err = checkDb(body.personajes);
      if (err) { res.status(400).json({ error: err }); return; }
      files.push({ path: DB_PATH, content: JSON.stringify(body.personajes), encoding: 'utf-8' });
    }
    for (const f of Array.isArray(body.files) ? body.files : []) {
      const path = String(f && f.path || '');
      if (path !== LOGO_PATH && !IMG_RE.test(path)) { res.status(400).json({ error: `Ruta no permitida: ${path}` }); return; }
      const buf = Buffer.from(String(f.data || ''), 'base64');
      if (!buf.length || buf.length > MAX_FILE) { res.status(400).json({ error: `Imagen vacía o demasiado grande: ${path}` }); return; }
      const kind = imageKind(buf);
      if (!kind || (path === LOGO_PATH && kind !== 'png') || (path !== LOGO_PATH && !path.endsWith('.' + kind))) {
        res.status(400).json({ error: `El archivo no es una imagen válida: ${path}` }); return;
      }
      files.push({ path, content: buf.toString('base64'), encoding: 'base64' });
    }
    const remove = [];
    for (const r of Array.isArray(body.remove) ? body.remove : []) {
      const path = String(r || '');
      if (!IMG_RE.test(path)) { res.status(400).json({ error: `Solo se pueden borrar imágenes subidas: ${path}` }); return; }
      if (!files.some(f => f.path === path)) remove.push(path);
    }
    if (!files.length && !remove.length) { res.status(400).json({ error: 'No hay nada que guardar.' }); return; }
    const message = String(body.message || 'Cambios desde el área privada').replace(/[\r\n]+/g, ' ').slice(0, 120);
    const sha = await commitFiles(c, files, message, remove);
    res.status(200).json({ ok: true, commit: sha });
  } catch (e) {
    const auth = e.status === 401 || e.status === 403 || e.status === 404;
    res.status(502).json({ error: auth ? 'GitHub ha rechazado el acceso: revisa que GITHUB_TOKEN tenga permiso de escritura (Contents) en el repositorio.' : 'Error al hablar con GitHub: ' + e.message });
  }
};

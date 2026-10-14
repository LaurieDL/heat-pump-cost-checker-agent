// Response compression for the static files, using Node's built-in zlib (no extra dependency).
// Brotli when the browser accepts it, otherwise gzip. Only text types, only successful bodies.
import zlib from 'node:zlib';

const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg\+xml)/i;
const MIN_BYTES = 1024; // tiny files cost more to compress than they save

/** The best encoding the browser's Accept-Encoding header allows: 'br', 'gzip' or null. */
export function pickEncoding(header = '') {
  const allowed = new Map();
  for (const part of String(header).split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    allowed.set(name, q ? Number.parseFloat(q.slice(2)) : 1);
  }
  const ok = (name) => (allowed.get(name) ?? allowed.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/** Express middleware: compress the body of a response if it is worth it. Use before static routes. */
export function compress() {
  return (req, res, next) => {
    if (req.method !== 'GET') return next();
    res.vary('Accept-Encoding'); // caches must keep one copy per encoding
    const encoding = pickEncoding(req.get('accept-encoding'));
    if (!encoding) return next();

    const write = res.write.bind(res);
    const end = res.end.bind(res);
    let stream = null;
    let decided = false;

    const decide = () => {
      decided = true;
      const length = Number(res.getHeader('Content-Length') ?? Infinity);
      if (res.statusCode !== 200 || res.getHeader('Content-Encoding') || length < MIN_BYTES
        || !COMPRESSIBLE.test(String(res.getHeader('Content-Type') ?? ''))) return;
      stream = encoding === 'br'
        ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
        : zlib.createGzip({ level: 6 });
      stream.on('data', (chunk) => write(chunk));
      stream.on('end', () => end());
      stream.on('drain', () => res.emit('drain'));
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length'); // no longer true
    };

    res.write = (chunk, enc, cb) => {
      if (!decided) decide();
      return stream ? stream.write(chunk, enc, cb) : write(chunk, enc, cb);
    };
    res.end = (chunk, enc, cb) => {
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
      if (!decided && chunk != null && chunk.length) decide(); // a bare end() is a 304 or HEAD: no body
      if (!stream) return end(chunk, enc, cb);
      stream.end(chunk ?? undefined, enc, cb);
      return res;
    };
    res.on('close', () => stream?.destroy());
    return next();
  };
}

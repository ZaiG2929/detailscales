/* POST /api/upload-url
   Hands the browser a one-time Supabase upload link, so voice recordings
   and contact files go straight to storage instead of through this
   function (which caps request bodies at 4.5 MB).

   body: { kind: "voice" | "contacts", name, type, size, clientId, email, business } */

const L = require('./_lib');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use POST' });
  if (!L.configured()) return L.send(res, 503, { error: 'Uploads are not switched on yet' });

  let body;
  try { body = await L.readJson(req); } catch (e) { return L.send(res, 400, { error: 'Bad request' }); }

  const kind = body.kind;
  const rule = L.BUCKETS[kind];
  if (!rule) return L.send(res, 400, { error: 'Unknown upload type' });

  const w = L.who(body);
  if (!w.key) return L.send(res, 400, { error: 'Missing email' });

  const size = Number(body.size) || 0;
  const type = L.cleanText(body.type, 100) || 'application/octet-stream';
  if (size <= 0) return L.send(res, 400, { error: 'Empty file' });
  if (size > rule.maxBytes) return L.send(res, 413, { error: 'File is larger than ' + Math.round(rule.maxBytes / 1048576) + ' MB' });
  if (!rule.types.test(type)) return L.send(res, 415, { error: 'That file type is not accepted here' });

  const safe = L.cleanText(body.name, 120).replace(/[^\w.\-]+/g, '_').replace(/^_+/, '') || 'file';
  const folder = L.slug(w.business) + '-' + (w.clientId || L.slug(w.email)).slice(0, 8);
  const path = folder + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '-' + safe;

  try {
    const url = await L.signedUploadUrl(kind, path);
    return L.send(res, 200, { url: url, path: path });
  } catch (e) {
    console.error(e);
    return L.send(res, 502, { error: 'Could not start the upload. Try again in a minute.' });
  }
};

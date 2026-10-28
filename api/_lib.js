/* Shared helpers for the onboarding API. Files that start with "_" are
   bundled with the functions but never exposed as their own route.

   Everything talks to Supabase, Slack and Google Sheets over plain
   HTTPS, so there are no packages to install.

   Environment variables (set in Vercel, never in the page):
     SUPABASE_URL                https://<project>.supabase.co
     SUPABASE_SERVICE_ROLE_KEY   service_role key, server only
     SLACK_WEBHOOK_URL           Slack incoming webhook
     SHEETS_WEBHOOK_URL          Google Apps Script web app URL
     SHEETS_SECRET               shared secret the Apps Script checks
*/

const BUCKETS = {
  voice: { maxBytes: 25 * 1024 * 1024, types: /^audio\// },
  contacts: { maxBytes: 45 * 1024 * 1024, types: /.*/ }
};

/* links in Slack and the spreadsheets stay usable for a year */
const LINK_SECONDS = 365 * 24 * 60 * 60;

function env(name) {
  return (process.env[name] || '').trim();
}

function configured() {
  return Boolean(env('SUPABASE_URL') && env('SUPABASE_SERVICE_ROLE_KEY'));
}

function sbHeaders(extra) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return Object.assign({ apikey: key, Authorization: 'Bearer ' + key }, extra || {});
}

async function sbFetch(path, init) {
  const res = await fetch(env('SUPABASE_URL').replace(/\/$/, '') + path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Supabase ' + res.status + ' on ' + path.split('?')[0] + ': ' + body.slice(0, 300));
  }
  return res;
}

async function insertRows(table, rows) {
  const res = await sbFetch('/rest/v1/' + table, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
    body: JSON.stringify(rows)
  });
  return res.json();
}

async function updateRow(table, id, fields) {
  await sbFetch('/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(fields)
  });
}

async function signedUploadUrl(bucket, path) {
  const res = await sbFetch('/storage/v1/object/upload/sign/' + bucket + '/' + encodePath(path), {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: '{}'
  });
  const out = await res.json();
  return env('SUPABASE_URL').replace(/\/$/, '') + '/storage/v1' + out.url;
}

async function signedDownloadUrl(bucket, path) {
  const res = await sbFetch('/storage/v1/object/sign/' + bucket + '/' + encodePath(path), {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: LINK_SECONDS })
  });
  const out = await res.json();
  return env('SUPABASE_URL').replace(/\/$/, '') + '/storage/v1' + (out.signedURL || out.signedUrl);
}

/* confirm an uploaded file really landed, using the long-standing list call */
async function objectInfo(bucket, path) {
  const cut = path.lastIndexOf('/');
  const prefix = cut > -1 ? path.slice(0, cut) : '';
  const name = path.slice(cut + 1);
  const res = await fetch(env('SUPABASE_URL').replace(/\/$/, '') + '/storage/v1/object/list/' + bucket, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix: prefix, search: name, limit: 5, offset: 0 })
  });
  if (!res.ok) return null;
  const items = await res.json();
  return (Array.isArray(items) ? items : []).find(i => i.name === name) || null;
}

async function downloadText(bucket, path) {
  const res = await sbFetch('/storage/v1/object/' + bucket + '/' + encodePath(path), { headers: sbHeaders() });
  return res.text();
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/* ---------- Slack ---------- */

async function slack(text, fields, link) {
  const url = env('SLACK_WEBHOOK_URL');
  if (!url) return { skipped: true };
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: text } }];
  const pairs = (fields || []).filter(f => f[1]);
  for (let i = 0; i < pairs.length; i += 10) {
    blocks.push({
      type: 'section',
      fields: pairs.slice(i, i + 10).map(f => ({ type: 'mrkdwn', text: '*' + f[0] + '*\n' + clip(String(f[1]), 280) }))
    });
  }
  if (link) {
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: link[0] }, url: link[1] }] });
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.replace(/\*/g, ''), blocks: blocks })
  });
  if (!res.ok) throw new Error('Slack ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return { ok: true };
}

/* ---------- Google Sheets, through the Apps Script web app ---------- */

async function sheets(action, payload) {
  const url = env('SHEETS_WEBHOOK_URL');
  if (!url) return { skipped: true };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ action: action, secret: env('SHEETS_SECRET') }, payload)),
    redirect: 'follow'
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch (e) { throw new Error('Sheets returned non-JSON: ' + text.slice(0, 200)); }
  if (!out.ok) throw new Error('Sheets: ' + (out.error || 'unknown error'));
  return out;
}

/* ---------- request helpers ---------- */

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new Error('Body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function cleanText(v, n) {
  return clip(String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim(), n || 2000);
}

/* who is sending: the same email links answers, voice and contacts */
function who(body) {
  const email = cleanText(body.email, 200).toLowerCase();
  const business = cleanText(body.business, 200);
  const owner = cleanText(body.owner, 200);
  const clientId = cleanText(body.clientId, 64).replace(/[^a-zA-Z0-9-]/g, '');
  return { email: email, business: business, owner: owner, clientId: clientId, key: email || clientId };
}

function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function slug(s) {
  return String(s || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
}

module.exports = {
  BUCKETS, env, configured, insertRows, updateRow, signedUploadUrl, signedDownloadUrl,
  objectInfo, downloadText, slack, sheets, send, readJson, clip, cleanText, who, validEmail, slug
};

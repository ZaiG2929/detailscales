/* GET /api/keepalive
   Supabase pauses a free project after a week with no database activity,
   and onboarding traffic can be quieter than that. A Vercel cron calls
   this once a day so the project stays awake.

   It also doubles as a health check: it answers yes or no for each
   piece the onboarding needs, without returning any data or secrets. */

const L = require('./_lib');

module.exports = async function (req, res) {
  const has = {
    supabase: L.configured(),
    slack: Boolean(L.env('SLACK_WEBHOOK_URL')),
    sheets: Boolean(L.env('SHEETS_WEBHOOK_URL') && L.env('SHEETS_SECRET'))
  };
  if (!has.supabase) return L.send(res, 200, { ok: false, has: has });

  const base = L.env('SUPABASE_URL').replace(/\/$/, '');
  const probe = async path => {
    try { return (await fetch(base + path, { headers: L.sbHeaders() })).ok; } catch (e) { return false; }
  };
  const tables = {};
  for (const t of ['onboarding_responses', 'voice_recordings', 'contact_uploads', 'contacts']) {
    tables[t] = await probe('/rest/v1/' + t + '?select=id&limit=1');
  }
  const buckets = { voice: await probe('/storage/v1/bucket/voice'), contacts: await probe('/storage/v1/bucket/contacts') };
  const ok = Object.values(tables).every(Boolean) && buckets.voice && buckets.contacts;
  return L.send(res, 200, { ok: ok, has: has, tables: tables, buckets: buckets });
};

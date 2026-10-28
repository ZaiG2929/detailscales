/* GET /api/keepalive
   Supabase pauses a free project after a week with no database activity,
   and onboarding traffic can be quieter than that. A Vercel cron calls
   this once a day so the project stays awake. */

const L = require('./_lib');

module.exports = async function (req, res) {
  if (!L.configured()) return L.send(res, 200, { ok: true, skipped: 'not configured' });
  try {
    await fetch(L.env('SUPABASE_URL').replace(/\/$/, '') + '/rest/v1/onboarding_responses?select=id&limit=1', {
      headers: L.sbHeaders()
    });
    return L.send(res, 200, { ok: true });
  } catch (e) {
    return L.send(res, 502, { ok: false });
  }
};

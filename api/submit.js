/* POST /api/submit
   One endpoint for the three things a new client hands over:

     type "onboarding"  their answers        -> Supabase, Slack, master sheet
     type "voice"       their voice recording -> Supabase, Slack, master sheet
     type "contacts"    their contact files   -> Supabase, Slack, master sheet,
                                                and their own contacts sheet

   Supabase is the record. If it saves, the client is told it worked even
   when Slack or Sheets hiccup; those failures are written back onto the
   row so nothing is silently lost. */

const L = require('./_lib');
const C = require('./_contacts');

module.exports = async function (req, res) {
  if (req.method !== 'POST') return L.send(res, 405, { error: 'Use POST' });
  if (!L.configured()) return L.send(res, 503, { error: 'Submissions are not switched on yet' });

  let body;
  try { body = await L.readJson(req); } catch (e) { return L.send(res, 400, { error: 'Bad request' }); }

  // bots fill every field; people never see this one
  if (body.company_website) return L.send(res, 200, { ok: true });

  const w = L.who(body);
  if (!L.validEmail(w.email)) return L.send(res, 400, { error: 'Add a valid email so we can match everything you send.' });
  if (!w.business) return L.send(res, 400, { error: 'Add your business name.' });

  try {
    if (body.type === 'onboarding') return await onboarding(body, w, res);
    if (body.type === 'voice') return await voice(body, w, res);
    if (body.type === 'contacts') return await contacts(body, w, res);
    return L.send(res, 400, { error: 'Unknown submission type' });
  } catch (e) {
    console.error(e);
    return L.send(res, 502, { error: 'We could not save that. Your answers are still on this page, so try again in a minute.' });
  }
};

/* run Slack and Sheets side by side; collect failures instead of throwing */
async function deliver(jobs) {
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(names.map(n => jobs[n]()));
  const out = {}, errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') out[names[i]] = r.value;
    else { errors[names[i]] = String(r.reason && r.reason.message || r.reason); console.error(names[i], r.reason); }
  });
  return { out: out, errors: errors };
}

/* ---------- 1. onboarding answers ---------- */

async function onboarding(body, w, res) {
  const answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 150).map(a => ({
    id: L.cleanText(a.id, 60),
    section: L.cleanText(a.section, 80),
    label: L.cleanText(a.label, 200),
    value: L.cleanText(a.value, 4000)
  })).filter(a => a.id && a.label);
  if (!answers.length) return L.send(res, 400, { error: 'No answers came through' });

  const by = {};
  answers.forEach(a => { by[a.id] = a.value; });
  const submittedAt = new Date().toISOString();

  const [row] = await L.insertRows('onboarding_responses', [{
    client_key: w.key, client_id: w.clientId || null, business_name: w.business,
    owner_name: w.owner || null, email: w.email, phone: by.phone || null, answers: answers
  }]);

  // the sheet goes first, so the Slack message can link to the full answers
  const s = await deliver({ sheets: () => L.sheets('onboarding', { who: w, answers: answers, submittedAt: submittedAt, id: row.id }) });
  const sheetUrl = s.out.sheets && s.out.sheets.sheetUrl;
  const d = await deliver({
    slack: () => L.slack(
      ':clipboard: *New onboarding answers* from *' + w.business + '*',
      [
        ['Owner', w.owner], ['Email', w.email], ['Phone', by.phone], ['Best way to reach', by.reach],
        ['Target area', [by.city, by.radius].filter(Boolean).join(', ')], ['Services', by.services],
        ['Most want to book', by.top_services], ['Average ticket', by.ticket],
        ['Monthly revenue (promoted services)', by.revenue], ['Leads a month', by.leads],
        ['Current ad spend', by.ad_spend], ['Success in 90 days', by.success_90]
      ],
      sheetUrl ? ['See every answer', sheetUrl] : null
    )
  });
  const errors = Object.assign({}, s.errors, d.errors);
  if (Object.keys(errors).length) await L.updateRow('onboarding_responses', row.id, { delivery_errors: errors }).catch(() => {});

  return L.send(res, 200, { ok: true, id: row.id });
}

/* ---------- 2. voice recording ---------- */

async function voice(body, w, res) {
  const path = L.cleanText(body.path, 300);
  if (!path) return L.send(res, 400, { error: 'The recording did not upload. Try again.' });
  if (!body.consent) return L.send(res, 400, { error: 'Tick the permission box so we can use the recording.' });

  const info = await L.objectInfo('voice', path);
  if (!info) return L.send(res, 400, { error: 'The recording did not finish uploading. Try again.' });

  const duration = Math.max(0, Math.min(3600, Math.round(Number(body.duration) || 0)));
  const mime = L.cleanText(body.mime, 80) || 'audio/webm';
  const link = await L.signedDownloadUrl('voice', path);

  const [row] = await L.insertRows('voice_recordings', [{
    client_key: w.key, client_id: w.clientId || null, business_name: w.business,
    owner_name: w.owner || null, email: w.email, storage_path: path, mime_type: mime,
    duration_seconds: duration, consent: true
  }]);

  const length = duration ? Math.floor(duration / 60) + ':' + String(duration % 60).padStart(2, '0') : 'unknown length';
  const d = await deliver({
    sheets: () => L.sheets('voice', { who: w, link: link, duration: duration, mime: mime, submittedAt: new Date().toISOString() }),
    slack: () => L.slack(
      ':microphone: *Voice recording* from *' + w.business + '* (' + length + ')',
      [['Owner', w.owner], ['Email', w.email], ['Format', mime], ['Consent for ads and voice agent', 'Yes']],
      ['Listen to the recording', link]
    )
  });
  if (Object.keys(d.errors).length) await L.updateRow('voice_recordings', row.id, { delivery_errors: d.errors }).catch(() => {});

  return L.send(res, 200, { ok: true, id: row.id });
}

/* ---------- 3. contact files ---------- */

async function contacts(body, w, res) {
  const files = (Array.isArray(body.files) ? body.files : []).slice(0, 30).map(f => ({
    path: L.cleanText(f.path, 300), name: L.cleanText(f.name, 200), size: Number(f.size) || 0, type: L.cleanText(f.type, 100)
  })).filter(f => f.path);
  if (!files.length) return L.send(res, 400, { error: 'Add at least one file.' });

  let all = [];
  for (const f of files) {
    const info = await L.objectInfo('contacts', f.path);
    if (!info) return L.send(res, 400, { error: f.name + ' did not finish uploading. Try again.' });
    f.link = await L.signedDownloadUrl('contacts', f.path);
    f.read = 0;
    if (C.parsable(f.name) && f.size <= 15 * 1024 * 1024) {
      try {
        const rows = C.parseFile(f.name, await L.downloadText('contacts', f.path));
        rows.forEach(r => { r.source = f.name; });
        f.read = rows.length;
        all = all.concat(rows);
      } catch (e) { console.error('parse', f.name, e); }
    }
  }
  const list = C.dedupe(all);
  const note = L.cleanText(body.note, 2000);

  const [upload] = await L.insertRows('contact_uploads', [{
    client_key: w.key, client_id: w.clientId || null, business_name: w.business,
    owner_name: w.owner || null, email: w.email, note: note || null,
    files: files.map(f => ({ name: f.name, path: f.path, size: f.size, type: f.type, contacts_read: f.read })),
    contacts_count: list.length
  }]);
  for (let i = 0; i < list.length; i += 500) {
    await L.insertRows('contacts', list.slice(i, i + 500).map(c => ({
      upload_id: upload.id, client_key: w.key, business_name: w.business,
      name: c.name || null, phone: c.phone || null, email: c.email || null,
      company: c.company || null, notes: c.notes || null, source_file: c.source
    })));
  }

  // the client's own sheet comes first, so the Slack message can link to it
  let sheetUrl = '', sheetError = '';
  try {
    const out = await L.sheets('contacts', {
      who: w, note: note, submittedAt: new Date().toISOString(),
      contacts: list.map(c => [c.name, c.phone, c.email, c.company, c.notes, c.source]),
      files: files.map(f => [f.name, f.type, f.link, f.read])
    });
    sheetUrl = out.sheetUrl || '';
  } catch (e) { sheetError = String(e.message || e); console.error('sheets', e); }

  const unread = files.filter(f => !f.read).map(f => f.name);
  const d = await deliver({
    slack: () => L.slack(
      ':busts_in_silhouette: *Contact list* from *' + w.business + '*: ' + list.length + ' contacts from ' + files.length + (files.length === 1 ? ' file' : ' files'),
      [['Owner', w.owner], ['Email', w.email],
       ['Files to read by hand', unread.length ? unread.join(', ') : ''], ['Their note', note]],
      sheetUrl ? ['Open their contacts sheet', sheetUrl] : ['Open the first file', files[0].link]
    )
  });
  const errors = Object.assign({}, d.errors, sheetError ? { sheets: sheetError } : {});
  await L.updateRow('contact_uploads', upload.id, Object.assign({ sheet_url: sheetUrl || null }, Object.keys(errors).length ? { delivery_errors: errors } : {})).catch(() => {});

  return L.send(res, 200, { ok: true, contacts: list.length, files: files.length, unread: unread.length });
}

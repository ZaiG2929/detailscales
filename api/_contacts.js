/* Reads the contact files clients export from their phones and booking
   apps into plain rows. Handles vCard (.vcf, what iPhone and Android
   export) and CSV (Google Contacts, booking software, spreadsheets).
   Anything else, a photo of a notebook say, is kept as a file link. */

function parseFile(name, text) {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.vcf') || lower.endsWith('.vcard') || /BEGIN:VCARD/i.test(text.slice(0, 2000))) {
    return parseVcf(text);
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt') || lower.endsWith('.tsv')) {
    return parseCsv(text);
  }
  return [];
}

function parsable(name) {
  return /\.(vcf|vcard|csv|tsv|txt)$/i.test(name || '');
}

/* ---------- vCard ---------- */

function parseVcf(text) {
  // unfold: a line starting with a space or tab continues the previous one,
  // and quoted-printable soft breaks end with "="
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1);
    else if (unfolded.length && /=$/.test(unfolded[unfolded.length - 1]) && /QUOTED-PRINTABLE/i.test(unfolded[unfolded.length - 1])) unfolded[unfolded.length - 1] = unfolded[unfolded.length - 1].slice(0, -1) + line;
    else unfolded.push(line);
  }

  const out = [];
  let card = null;
  for (const raw of unfolded) {
    const line = raw.trim();
    if (!line) continue;
    if (/^BEGIN:VCARD$/i.test(line)) { card = { name: '', first: '', last: '', phones: [], emails: [], company: '', notes: '' }; continue; }
    if (/^END:VCARD$/i.test(line)) { if (card) out.push(finishCard(card)); card = null; continue; }
    if (!card) continue;

    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const parts = head.split(';');
    const prop = parts[0].replace(/^item\d+\./i, '').toUpperCase();
    const params = parts.slice(1).join(';');
    if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) value = decodeQP(value);
    value = unescapeVcf(value);

    if (prop === 'FN') card.name = value;
    else if (prop === 'N') {
      const n = value.split(';');
      card.last = (n[0] || '').trim();
      card.first = (n[1] || '').trim();
    }
    else if (prop === 'TEL') { if (value.trim()) card.phones.push(value.trim()); }
    else if (prop === 'EMAIL') { if (value.trim()) card.emails.push(value.trim()); }
    else if (prop === 'ORG') card.company = value.split(';').filter(Boolean).join(' ').trim();
    else if (prop === 'NOTE') card.notes = value.trim();
  }
  return out.filter(c => c.name || c.phone || c.email);
}

function finishCard(c) {
  return {
    name: (c.name || [c.first, c.last].filter(Boolean).join(' ')).trim(),
    phone: c.phones.join(', '),
    email: c.emails.join(', '),
    company: c.company,
    notes: c.notes
  };
}

function unescapeVcf(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
}

function decodeQP(v) {
  const bytes = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '=' && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) { bytes.push(parseInt(v.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(v.charCodeAt(i) & 0xff);
  }
  return Buffer.from(bytes).toString('utf8');
}

/* ---------- CSV ---------- */

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t'
    : (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = csvRows(text, delim).filter(r => r.some(c => c.trim()));
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim().toLowerCase());
  const find = (re, not) => header.reduce((acc, h, i) => (re.test(h) && !(not && not.test(h)) ? acc.concat(i) : acc), []);

  const full = find(/^(name|full name|display name|customer( name)?|client( name)?|contact( name)?)$/);
  const first = find(/(^first|given name|first name)/);
  const last = find(/(^last|family name|last name|surname)/);
  const phone = find(/(phone|mobile|cell|tel)/, /(type|label)/);
  const email = find(/(e-?mail)/, /(type|label)/);
  const company = find(/(company|organi[sz]ation|business)/, /(title|type|label)/);
  const notes = find(/(notes?|vehicle|service|last visit|last job)/);

  // no recognisable header: treat the first column as name, then sniff phone/email by shape
  const recognised = full.length || first.length || phone.length || email.length;
  const body = recognised ? rows.slice(1) : rows;

  return body.map(r => {
    const get = idxs => idxs.map(i => (r[i] || '').trim()).filter(Boolean);
    let name = get(full)[0] || [get(first)[0], get(last)[0]].filter(Boolean).join(' ');
    let phones = get(phone);
    let emails = get(email);
    if (!recognised) {
      name = (r[0] || '').trim();
      phones = r.filter(c => /^[+()\d][\d\s().-]{6,}$/.test(c.trim()));
      emails = r.filter(c => /@/.test(c));
    }
    const noteParts = notes.map(i => header[i] && r[i] && r[i].trim() ? rows[0][i].trim() + ': ' + r[i].trim() : '').filter(Boolean);
    return {
      name: name,
      phone: Array.from(new Set(phones)).join(', '),
      email: Array.from(new Set(emails)).join(', '),
      company: get(company)[0] || '',
      notes: noteParts.join(' | ')
    };
  }).filter(c => c.name || c.phone || c.email);
}

function csvRows(text, delim) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/* ---------- de-duplication across all files in one upload ---------- */

function dedupe(contacts) {
  const seen = new Set();
  const out = [];
  for (const c of contacts) {
    const phoneKey = (c.phone || '').split(',')[0].replace(/\D/g, '').slice(-10);
    const emailKey = (c.email || '').split(',')[0].trim().toLowerCase();
    const key = phoneKey || emailKey || (c.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

module.exports = { parseFile, parsable, parseVcf, parseCsv, dedupe };

/**
 * DetailScales onboarding -> Google Sheets
 *
 * Paste this into the Apps Script editor of your master spreadsheet
 * (Extensions > Apps Script), set SECRET below, then
 * Deploy > New deployment > Web app, Execute as: Me, Who has access: Anyone.
 * Copy the web app URL into Vercel as SHEETS_WEBHOOK_URL, and the same
 * secret as SHEETS_SECRET.
 *
 * Master spreadsheet tabs it keeps up to date:
 *   Onboarding  one row per answers submission, one column per question
 *   Voice       one row per recording, with a listen link
 *   Contacts    one row per upload, with a link to that client's own sheet
 *   Clients     which client got which contacts sheet (do not edit by hand)
 *
 * Each client's contacts land in their own spreadsheet, created on their
 * first upload inside a Drive folder called FOLDER_NAME, and appended to
 * on every upload after that.
 */

var SECRET = 'paste-the-same-long-random-secret-you-put-in-vercel';
var FOLDER_NAME = 'DetailScales client contacts';

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (!SECRET || body.secret !== SECRET) return json({ ok: false, error: 'bad secret' });

    var master = SpreadsheetApp.getActiveSpreadsheet();
    var out;
    if (body.action === 'onboarding') out = onboarding(master, body);
    else if (body.action === 'voice') out = voice(master, body);
    else if (body.action === 'contacts') out = contacts(master, body);
    else return json({ ok: false, error: 'unknown action' });

    out.ok = true;
    return json(out);
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Onboarding: question labels become columns ---------- */
function onboarding(master, body) {
  var sheet = tab(master, 'Onboarding', ['Submitted', 'Business', 'Owner', 'Email']);
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var labels = body.answers.map(function (a) { return a.label; });
  var missing = labels.filter(function (l) { return header.indexOf(l) < 0; });
  if (missing.length) {
    sheet.getRange(1, header.length + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    header = header.concat(missing);
  }
  var row = header.map(function () { return ''; });
  row[0] = new Date(body.submittedAt);
  row[1] = body.who.business;
  row[2] = body.who.owner;
  row[3] = body.who.email;
  body.answers.forEach(function (a) { row[header.indexOf(a.label)] = a.value; });
  sheet.appendRow(row);
  return { sheetUrl: master.getUrl() + '#gid=' + sheet.getSheetId() };
}

/* ---------- Voice ---------- */
function voice(master, body) {
  var sheet = tab(master, 'Voice', ['Submitted', 'Business', 'Owner', 'Email', 'Length (sec)', 'Format', 'Listen']);
  sheet.appendRow([new Date(body.submittedAt), body.who.business, body.who.owner, body.who.email, body.duration, body.mime, body.link]);
  return { sheetUrl: master.getUrl() + '#gid=' + sheet.getSheetId() };
}

/* ---------- Contacts: one spreadsheet per client ---------- */
function contacts(master, body) {
  var client = clientSheet(master, body.who);
  var ss = SpreadsheetApp.openById(client.id);
  var when = new Date(body.submittedAt);

  var list = tab(ss, 'Contacts', ['Name', 'Phone', 'Email', 'Company', 'Notes', 'From file', 'Uploaded']);
  if (body.contacts.length) {
    var rows = body.contacts.map(function (c) { return c.concat([when]); });
    list.getRange(list.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  }

  var files = tab(ss, 'Files', ['File', 'Type', 'Link', 'Contacts read', 'Uploaded']);
  if (body.files.length) {
    var frows = body.files.map(function (f) { return f.concat([when]); });
    files.getRange(files.getLastRow() + 1, 1, frows.length, frows[0].length).setValues(frows);
  }
  if (body.note) {
    var notes = tab(ss, 'Notes', ['Uploaded', 'Note']);
    notes.appendRow([when, body.note]);
  }

  var log = tab(master, 'Contacts', ['Submitted', 'Business', 'Owner', 'Email', 'Contacts', 'Files', 'Their sheet']);
  log.appendRow([when, body.who.business, body.who.owner, body.who.email, body.contacts.length, body.files.length, ss.getUrl()]);
  return { sheetUrl: ss.getUrl() };
}

function clientSheet(master, who) {
  var map = tab(master, 'Clients', ['Client key', 'Business', 'Email', 'Sheet ID', 'Sheet', 'Created']);
  var key = String(who.key || who.email).toLowerCase();
  var data = map.getLastRow() > 1 ? map.getRange(2, 1, map.getLastRow() - 1, 4).getValues() : [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === key) {
      try { SpreadsheetApp.openById(data[i][3]); return { id: data[i][3] }; } catch (e) { /* deleted: make a new one */ }
    }
  }
  var ss = SpreadsheetApp.create(who.business + ' - Contacts | DetailScales');
  ss.getSheets()[0].setName('Contacts');
  DriveApp.getFileById(ss.getId()).moveTo(folder());
  map.appendRow([key, who.business, who.email, ss.getId(), ss.getUrl(), new Date()]);
  return { id: ss.getId() };
}

/* ---------- helpers ---------- */
function folder() {
  var found = DriveApp.getFoldersByName(FOLDER_NAME);
  return found.hasNext() ? found.next() : DriveApp.createFolder(FOLDER_NAME);
}

function tab(ss, name, header) {
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* Run this once from the editor (select setup, press Run) to approve
   Drive and Sheets access and create the tabs before the first client. */
function setup() {
  var master = SpreadsheetApp.getActiveSpreadsheet();
  tab(master, 'Onboarding', ['Submitted', 'Business', 'Owner', 'Email']);
  tab(master, 'Voice', ['Submitted', 'Business', 'Owner', 'Email', 'Length (sec)', 'Format', 'Listen']);
  tab(master, 'Contacts', ['Submitted', 'Business', 'Owner', 'Email', 'Contacts', 'Files', 'Their sheet']);
  tab(master, 'Clients', ['Client key', 'Business', 'Email', 'Sheet ID', 'Sheet', 'Created']);
  var blank = master.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && master.getSheets().length > 1) master.deleteSheet(blank);
  folder();
}

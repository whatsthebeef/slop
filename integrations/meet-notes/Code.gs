/**
 * Sends new Google Meet notes (the "Notes by Gemini" docs) to a slop board's inbox.
 *
 * Run `installTrigger` once; `syncMeetNotes` then runs every 10 minutes. Setup is in README.md.
 * Script Properties: SLOP_URL, SLOP_BOARD, SLOP_TOKEN. The script keeps LAST_RUN there too.
 *
 * Delivery is idempotent: the doc's ID is the source reference slop dedupes on, so a re-run, an overlap between runs
 * or a retry after a failure never duplicates an item.
 */

var DOC_MIME = 'application/vnd.google-apps.document';
var MEET_FOLDER = 'Meet Recordings';
/** Gemini names its notes "<meeting> - 2026/10/06 10:00 BST - Notes by Gemini". */
var NOTES_TITLE = /notes by gemini\s*$/i;
var TITLE_SUFFIX = /\s+-\s+\d{4}\/\d{2}\/\d{2}[^-]*-\s*notes by gemini\s*$/i;
var TITLE_DATE = /(\d{4})\/(\d{2})\/(\d{2})/;
/** What slop takes of one item's text. */
var TEXT_LIMIT = 100000;
var FIRST_RUN_DAYS = 2;
/** Moves each run's window back a little, so a doc saved while a run was listing isn't missed (dedupe makes the overlap free). */
var OVERLAP_MS = 5 * 60 * 1000;

/** A Gemini notes doc: titled like one, or sitting in the "Meet Recordings" folder. */
function isMeetNotesDoc(name, folderNames) {
  if (NOTES_TITLE.test(name || '')) return true;
  return (folderNames || []).indexOf(MEET_FOLDER) >= 0;
}

/** The meeting's title: the doc's title without Gemini's date and "Notes by Gemini" tail. */
function meetingTitle(name) {
  var title = String(name || '').replace(TITLE_SUFFIX, '').trim();
  return title === '' ? String(name || '').trim() : title;
}

/** The meeting's day as an ISO date: from the doc's title when it has one, else the day the doc was created. */
function meetingDate(name, createdIso) {
  var m = TITLE_DATE.exec(String(name || ''));
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return String(createdIso || '').slice(0, 10);
}

/** Drive's search for Google docs modified after `sinceIso`. */
function driveQuery(sinceIso) {
  return "mimeType = '" + DOC_MIME + "' and trashed = false and modifiedDate > '" + sinceIso + "'";
}

/** The window's start: the last run's, else a couple of days back; always a little earlier than recorded. */
function windowStart(lastRunIso, nowMs) {
  var base = lastRunIso ? Date.parse(lastRunIso) : nowMs - FIRST_RUN_DAYS * 86400000;
  if (isNaN(base)) base = nowMs - FIRST_RUN_DAYS * 86400000;
  return new Date(base - OVERLAP_MS).toISOString();
}

/** The body slop's ingest takes for one notes doc. */
function buildDelivery(doc, text) {
  var body = String(text || '').trim();
  if (body.length > TEXT_LIMIT) body = body.slice(0, TEXT_LIMIT - 1) + '…';
  return {
    source: 'meet',
    sourceRef: doc.id,
    sourceLabel: 'Google Meet notes',
    title: meetingTitle(doc.name).slice(0, 200),
    occurredAt: meetingDate(doc.name, doc.createdIso),
    // The doc's URL is the reference a person follows back to the notes.
    text: body + '\n\nSource: ' + doc.url,
  };
}

/** Oldest first, so a failure part way leaves the window start just before the first undelivered doc. */
function inModifiedOrder(docs) {
  return docs.slice().sort(function (a, b) {
    return a.modifiedMs - b.modifiedMs;
  });
}

// ---- Apps Script side: nothing below runs in the unit tests ----

function settings_() {
  var p = PropertiesService.getScriptProperties();
  var s = { url: p.getProperty('SLOP_URL'), board: p.getProperty('SLOP_BOARD'), token: p.getProperty('SLOP_TOKEN') };
  if (!s.url || !s.board || !s.token) throw new Error('Set SLOP_URL, SLOP_BOARD and SLOP_TOKEN in Script Properties');
  s.url = s.url.replace(/\/+$/, '');
  return s;
}

function foldersOf_(file) {
  var names = [];
  var parents = file.getParents();
  while (parents.hasNext()) names.push(parents.next().getName());
  return names;
}

function exportText_(id) {
  var res = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain', {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Export of ' + id + ' failed: HTTP ' + res.getResponseCode());
  return res.getContentText();
}

function post_(s, delivery) {
  var res = UrlFetchApp.fetch(s.url + '/integrations/boards/' + encodeURIComponent(s.board) + '/inbox', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + s.token },
    payload: JSON.stringify(delivery),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('slop answered HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
}

/** The time trigger's entry point. */
function syncMeetNotes() {
  var s = settings_();
  var props = PropertiesService.getScriptProperties();
  var startedMs = Date.now();
  var since = windowStart(props.getProperty('LAST_RUN'), startedMs);
  var docs = [];
  var files = DriveApp.searchFiles(driveQuery(since));
  while (files.hasNext()) {
    var file = files.next();
    if (!isMeetNotesDoc(file.getName(), foldersOf_(file))) continue;
    docs.push({
      id: file.getId(),
      name: file.getName(),
      url: file.getUrl(),
      createdIso: file.getDateCreated().toISOString(),
      modifiedMs: file.getLastUpdated().getTime(),
    });
  }
  var delivered = 0;
  var ordered = inModifiedOrder(docs);
  for (var i = 0; i < ordered.length; i++) {
    var doc = ordered[i];
    try {
      var text = exportText_(doc.id);
      if (text.trim() !== '') post_(s, buildDelivery(doc, text));
      delivered++;
    } catch (e) {
      // Stop here: the next run starts from before this doc, and docs already delivered are skipped by slop.
      console.error(String(e));
      props.setProperty('LAST_RUN', new Date(Math.max(Date.parse(since) + OVERLAP_MS, doc.modifiedMs - 1)).toISOString());
      return;
    }
  }
  props.setProperty('LAST_RUN', new Date(startedMs).toISOString());
  console.log('Delivered ' + delivered + ' of ' + ordered.length + ' notes docs');
}

/** Run once from the editor: a trigger that runs `syncMeetNotes` every 10 minutes (replacing an earlier one). */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncMeetNotes') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncMeetNotes').timeBased().everyMinutes(10).create();
}

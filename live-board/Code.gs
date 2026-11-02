/**
 * The Bergenshire - live board.
 *
 * Paste this whole file into the Apps Script editor of a Google Sheet you own
 * (Extensions > Apps Script), set PASSWORD below, and deploy it as a web app.
 * live-board/SETUP.md has the steps.
 *
 * The survey page sends two kinds of request, both POST with a JSON body:
 *   {action:"save", pw, id, name, code}  - store one person's share code
 *   {action:"read", pw}                  - return every stored code
 * Nothing is accepted or returned without the right password, and the password
 * lives only here, never in the public page.
 *
 * One row per phone: "id" is a random value each phone makes for itself, so a
 * person who retakes the quiz on the same phone replaces their earlier answer.
 * Delete a row in the sheet to remove somebody; nothing else needs to change.
 *
 * Version 2 (2 Nov 2026) adds moving codes in from the old board:
 *   {action:"save", mode:"import", pw, name, code}
 * stores a row with id "import:<name>", unless somebody of that name is already
 * on the live board, in which case it is skipped and says so. When that person
 * later saves from their own phone, their answer takes over the imported row.
 */
const PASSWORD = "CHANGE-ME";     // the group password - choose your own
const TAB = "Answers";
const VERSION = 2;
const key_ = n => String(n || "").toLowerCase().trim().replace(/\s+/g, " ");

function tab_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  if (sh.getLastRow() === 0) sh.appendRow(["phone", "name", "code", "saved"]);
  return sh;
}

function reply_(obj) {
  obj.v = VERSION;
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let d = {};
  try { d = JSON.parse(e.postData.contents); } catch (err) { return reply_({ok: false, error: "bad"}); }
  if (PASSWORD === "CHANGE-ME" || d.pw !== PASSWORD) return reply_({ok: false, error: "password"});

  if (d.action === "read") {
    const rows = tab_().getDataRange().getValues().slice(1)
      .filter(r => r[2])
      .map(r => ({name: r[1], code: r[2], saved: r[3]}));
    return reply_({ok: true, rows: rows});
  }

  if (d.action === "save") {
    const imp = d.mode === "import";
    const name = String(d.name || "").slice(0, 40), k = key_(name), code = String(d.code || "");
    const id = imp ? "import:" + k : String(d.id || "").slice(0, 64);
    if (!id || !code || code.length > 8000 || (imp && !k)) return reply_({ok: false, error: "bad"});
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sh = tab_(), values = sh.getDataRange().getValues();
      const rec = [id, name, code, new Date()];
      let row = -1;
      if (imp) {
        // Somebody of this name is already here: the live answer stays.
        for (let i = 1; i < values.length; i++) if (key_(values[i][1]) === k) return reply_({ok: true, skipped: true});
      } else {
        for (let i = 1; i < values.length; i++) if (values[i][0] === id) { row = i + 1; break; }
        // A phone saving for the first time takes over an imported row of its name.
        if (row < 0 && k) for (let i = 1; i < values.length; i++) if (values[i][0] === "import:" + k) { row = i + 1; break; }
      }
      if (row > 0) sh.getRange(row, 1, 1, 4).setValues([rec]); else sh.appendRow(rec);
    } finally {
      lock.releaseLock();
    }
    return reply_({ok: true});
  }

  return reply_({ok: false, error: "bad"});
}

/* Opening the web address in a browser just says it is running. */
function doGet() {
  return reply_({ok: true, note: "The Bergenshire live board is running."});
}

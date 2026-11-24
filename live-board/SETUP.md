# Setting up the live board

About ten minutes, once. You need a Google account; nobody else does.

1. Open **sheets.new** in a browser to make a new Google Sheet. Name it something like
   *Bergenshire live board*. It stays private to you.
2. In the sheet: **Extensions > Apps Script**. Delete whatever is in the editor and paste in
   the whole of `Code.gs` from this folder.
3. Near the top, change `CHANGE-ME` to the group password you want, keeping the quote marks.
   This is the password your friends will type once on their phone. Press the save icon.
4. **Deploy > New deployment**. Click the gear next to *Select type* and choose **Web app**.
   - *Execute as*: **Me**
   - *Who has access*: **Anyone**
   Press **Deploy**.
5. Google asks you to authorise it. Choose your account. If it says the app isn't verified,
   press **Advanced**, then **Go to (your project name)**, then **Allow**. This is your own
   script talking to your own sheet.
6. Copy the **Web app URL** (it ends in `/exec`) and send it to Claude. It goes into the page
   as `LIVE_URL`; until then the live board stays hidden.

Afterwards:

- Every answer appears as a row in the *Answers* tab. Delete a row to remove somebody.
- When somebody who answered on one phone saves again from another, the page asks "Is that
  you?". On yes, their older row moves to a *Replaced* tab (the script makes it the first
  time). Nothing is deleted: to undo one, cut the row from *Replaced* and paste it back into
  *Answers* (its first four columns). This needs script version 3 (24 Nov 2026); with an
  older one the page doesn't ask and both rows stay, as before.
- To change the password, edit it in the script, then **Deploy > Manage deployments >
  Edit > New version > Deploy**. The web address stays the same. Everyone types the new one
  once.
- **Updating the script** (when `Code.gs` here changes, as it did on 2 Nov 2026 for moving
  codes in from the old board and on 24 Nov 2026 for "Is that you?"): in the Apps Script editor, select everything, paste the new
  `Code.gs`, put your password back on the `PASSWORD` line, save, then **Deploy > Manage
  deployments > Edit (pencil) > Version: New version > Deploy**. Same web address. The page
  says so if it needs a newer script than the one deployed.
- "Anyone" access means anyone can reach the script's address, but without the password it
  refuses to read or save anything. The address is visible in the page's source; the
  password is not.

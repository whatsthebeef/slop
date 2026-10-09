# Meet notes into the slop inbox

A Google Apps Script that sends the notes Gemini writes after a Google Meet to a slop board's inbox. From the inbox a person attaches a note to a glob, keeps it, or discards it.

Every 10 minutes the script looks in your Drive for Google docs changed since its last run, keeps the Gemini notes docs (titled "… - Notes by Gemini", or anywhere in a "Meet Recordings" folder), exports each as plain text, and posts it to slop with the source `meet`, the doc's link, the meeting title and its date.

Delivery is idempotent: the doc's ID is the item's source reference, so running again never duplicates an item. A doc that was delivered once is not updated if it is edited later, and one you discarded in the inbox stays discarded.

## You need

- A Google Workspace account with Gemini notes on for Meet.
- Admin rights on the slop board, to create its integration token.
- A slop server Apps Script can reach: the deployed URL, not `localhost`.

## Set up

1. In slop, open the board's **Settings**, find **Integration token** and press **Create token**. Copy it now: it is shown once, and slop keeps only its hash. Creating a new token revokes the old one; **Revoke** stops the script at once.
2. Go to [script.google.com](https://script.google.com), create a project, and copy `Code.gs` into it. Under **Project Settings**, tick *Show "appsscript.json" manifest file in editor* and replace its contents with `appsscript.json` from this folder.
3. Under **Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `SLOP_URL` | the server's address, e.g. `https://slop.example.com` |
   | `SLOP_BOARD` | the board's number (the number in a glob ID: `s15f22` is on board 15) |
   | `SLOP_TOKEN` | the token from step 1 |

4. Select `installTrigger` in the editor and press **Run**. Authorise the Drive scope (read-only), the external-request scope and the trigger scope when Google asks. This sets up the every-10-minutes trigger.
5. Optionally run `syncMeetNotes` once by hand. The first run looks back two days; later runs start where the last one ended (`LAST_RUN` in Script Properties). Executions and errors are under **Executions**.

## What it can do

The token can only add inbox items to its own board: it cannot read anything, and it is refused for any other board. The script needs read-only Drive access, and only fetches docs that look like Meet notes.

## Troubleshooting

- `slop answered HTTP 401`: the token is wrong, was revoked or belongs to another board.
- `HTTP 422` or `413`: slop refused the request; the error in **Executions** shows its message. (Text over 100,000 characters is cut by the script first.)
- Nothing arrives: check the doc's title ends "Notes by Gemini" or that it is in a "Meet Recordings" folder, and that it was modified after the last run.

The doc-selection logic (`isMeetNotesDoc`, `meetingTitle`, `meetingDate`, `windowStart`, `buildDelivery`) is plain JavaScript, tested by `apps/server/test/meet-notes-script.test.ts`.

---
name: slop-attach
description: Put an image, screenshot, PDF or other file on a slop glob (a new one or an existing one). Use when the user shares a file, or you made one, that belongs with a glob.
---

# Attach files to a slop glob

Slop stores files in a private bucket. The bytes never go through a tool call: slop hands you an upload link and you send the file from the code sandbox.

## Steps

1. **New glob:** call slop's `create_glob` with `files: [{fileName, contentType?, label?}]` (names and types only). **Existing glob:** call `attachment_upload_url({id, fileName, contentType?, label?})` once per file.
2. The reply has `uploads`: one entry per file with `url`, `fields`, `expiresAt` and a `curl` command. Links last 15 minutes.
3. For each file, run `scripts/upload.sh <path> '<upload json>'`, where the JSON is that entry of `uploads` exactly as returned.
4. The script prints one line: `uploaded <name>` or why it failed. Slop sees the arrival by itself; there is no completion call.

## Rules

- Never base64 a file or paste its content into a tool call.
- Accepted types: png, jpeg, gif, webp, svg, pdf, txt, md, json, csv, log, zip. The default limit is 10 MiB per file.
- If the upload fails, say so. The glob shows a note for files that never arrived, and a person can upload them in the glob view. Don't retry after the link expires; ask for a new one with `attachment_upload_url`.
- If the script says the sandbox can't reach the bucket, the user must allow the bucket's host in Claude's code execution network settings (Settings → Capabilities → Code execution → allowed domains).

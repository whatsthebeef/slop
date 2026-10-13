#!/bin/sh
# Upload one file with a presigned POST from slop: upload.sh <path> '<upload json>'
# The JSON is one entry of `uploads` from create_glob or attachment_upload_url ({"url": ..., "fields": {...}}).
# Prints one line: "uploaded <name>" or why it failed. Exit status 0 only on success.
set -u

if [ "$#" -ne 2 ]; then
  echo "failed: usage: upload.sh <path> '<upload json>'"
  exit 2
fi
path=$1
json=$2

if [ ! -f "$path" ]; then
  echo "failed: $path is not a file"
  exit 1
fi
if ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
  echo "failed: this script needs curl and python3"
  exit 1
fi

# One -K config line per form field, so values with quotes or spaces need no shell quoting.
config=$(mktemp) || exit 1
trap 'rm -f "$config"' EXIT
url=$(printf '%s' "$json" | python3 -c '
import json, sys
def q(s):
    return s.replace("\\", "\\\\").replace("\"", "\\\"")
try:
    upload = json.load(sys.stdin)
    url = upload["url"]
    fields = upload["fields"]
except Exception as e:
    sys.stderr.write("bad upload json: %s\n" % e)
    sys.exit(3)
with open(sys.argv[1], "a") as cfg:
    for name, value in fields.items():
        cfg.write("form = \"%s\"\n" % q("%s=%s" % (name, value)))
print(url)
' "$config") || { echo "failed: the upload json is not valid (pass one entry of uploads as returned)"; exit 1; }

printf 'form = "file=@%s"\n' "$(printf '%s' "$path" | sed 's/\\/\\\\/g; s/"/\\"/g')" >>"$config"

name=$(basename "$path")
out=$(mktemp) || exit 1
code=$(curl -sS -o "$out" -w '%{http_code}' -K "$config" "$url" 2>"$out.err")
status=$?
if [ "$status" -ne 0 ]; then
  err=$(tr '\n' ' ' <"$out.err")
  rm -f "$out" "$out.err"
  case "$status" in
    5|6|7|28|35|56|60)
      echo "failed: could not reach the upload host ($err). In Claude: Settings > Capabilities > Code execution, allow the bucket's host ($url) as a network domain, then try again with a fresh link." ;;
    *)
      echo "failed: $name: curl error $status: $err" ;;
  esac
  exit 1
fi
rm -f "$out.err"
case "$code" in
  2??) echo "uploaded $name"; rm -f "$out"; exit 0 ;;
  *)
    why=$(sed -n 's/.*<Message>\(.*\)<\/Message>.*/\1/p' "$out" | head -n 1)
    rm -f "$out"
    echo "failed: $name: upload refused (HTTP $code${why:+: $why}); the link may have expired or the file is too big or the wrong type"
    exit 1 ;;
esac

#!/usr/bin/env sh
# Every exception in .trivyignore names an expiry (exp:YYYY-MM-DD) and the issue tracking it.
set -eu
bad=$(grep -vE '^[[:space:]]*(#|$)' .trivyignore | grep -vE '^[A-Za-z0-9._:-]+ exp:[0-9]{4}-[0-9]{2}-[0-9]{2} # #[0-9]+ .+' || true)
if [ -n "$bad" ]; then
  echo "Each .trivyignore entry needs an expiry and an issue, as in:" >&2
  echo "  CVE-2026-12345 exp:2026-12-31 # #170 why it cannot be fixed yet" >&2
  echo "$bad" >&2
  exit 1
fi
echo ".trivyignore: every exception has an expiry and an issue"

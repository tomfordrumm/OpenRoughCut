#!/bin/bash
set -euo pipefail
app="${1:?Usage: scripts/verify-macos.sh /path/App.app [--gatekeeper]}"
codesign --verify --deep --strict --verbose=2 "$app"
signature=$(codesign -dv --verbose=4 "$app" 2>&1)
printf '%s\n' "$signature"
[[ "$signature" == *'Authority=Developer ID Application:'* ]] || { echo 'Developer ID required' >&2; exit 1; }
[[ "$signature" == *'runtime'* ]] || { echo 'Hardened runtime required' >&2; exit 1; }
[[ "$signature" == *'Timestamp='* ]] || { echo 'Secure signing timestamp required' >&2; exit 1; }
if codesign -d --entitlements :- "$app" 2>/dev/null | grep -E 'get-task-allow|disable-library-validation|allow-unsigned-executable-memory'; then
  echo 'Unexpected release entitlement' >&2; exit 1
fi
team=$(printf '%s\n' "$signature" | sed -n 's/^TeamIdentifier=//p')
while IFS= read -r -d '' binary; do
  if file -b "$binary" | grep -q 'Mach-O'; then
    codesign --verify --strict "$binary"
    details=$(codesign -dv --verbose=4 "$binary" 2>&1)
    [[ "$details" == *"TeamIdentifier=$team"* ]] || { echo "Wrong nested Team ID: $binary" >&2; exit 1; }
    if otool -L "$binary" | grep -E '/(opt/homebrew|usr/local|Users|Volumes)/'; then
      echo "Developer-machine dependency: $binary" >&2; exit 1
    fi
  fi
done < <(find "$app/Contents" -type f -print0)
if [[ "${2:-}" == --gatekeeper ]]; then
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=4 "$app"
fi

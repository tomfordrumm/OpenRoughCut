#!/bin/bash
# Local signing only. No notarization, publication, tags or uploads.
set -euo pipefail
cd "$(dirname "$0")/.."
arch="${1:?Usage: scripts/macos-candidate.sh arm64|x64}"
case "$arch" in arm64|x64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
: "${CSC_NAME:?Set CSC_NAME to your Developer ID Application identity}"
[[ "$CSC_NAME" == 'Developer ID Application:'* ]] || { echo 'Developer ID Application required' >&2; exit 1; }
git diff --exit-code HEAD -- src electron ui scripts build package.json package-lock.json
revision=$(git rev-parse HEAD)
export CSC_IDENTITY_AUTO_DISCOVERY=true
# File Provider may add FinderInfo to .app bundles in Documents and invalidate signing.
export ORC_RELEASE_DIR="${ORC_RELEASE_DIR:-$HOME/Library/Caches/OpenRoughCut-release/$(git rev-parse --short=12 HEAD)}"
mkdir -p "$ORC_RELEASE_DIR"
npm test
npm run app:build
node scripts/verify-runtime.mjs darwin "$arch"
node scripts/stage-release.mjs darwin
CSC_NAME="${CSC_NAME#Developer ID Application: }" npx --no-install electron-builder --projectDir .release-stage --mac --"$arch" --publish never -c.mac.notarize=false -c.forceCodeSigning=true
app="$ORC_RELEASE_DIR/mac-arm64/OpenRoughCut.app"
if [[ "$arch" == x64 ]]; then app="$ORC_RELEASE_DIR/mac/OpenRoughCut.app"; fi
scripts/verify-macos.sh "$app"
shasum -a 256 "$ORC_RELEASE_DIR"/OpenRoughCut-*-mac-"$arch".dmg "$ORC_RELEASE_DIR"/OpenRoughCut-*-mac-"$arch".zip > "$ORC_RELEASE_DIR/SHA256SUMS-$arch.txt"
printf "%s\n" "$revision" > "$ORC_RELEASE_DIR/REVISION-$arch.txt"
git diff --exit-code "$revision" -- src electron ui scripts build package.json package-lock.json
printf "Candidate directory: %s\n" "$ORC_RELEASE_DIR"

#!/bin/bash
# Local signing only. No notarization, publication, tags or uploads.
set -euo pipefail
cd "$(dirname "$0")/.."
arch="${1:?Usage: scripts/macos-candidate.sh arm64|x64}"
case "$arch" in arm64|x64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
: "${CSC_NAME:?Set CSC_NAME to your Developer ID Application identity}"
[[ "$CSC_NAME" == 'Developer ID Application:'* ]] || { echo 'Developer ID Application required' >&2; exit 1; }
git diff --exit-code HEAD -- src electron ui scripts build package.json package-lock.json
export CSC_IDENTITY_AUTO_DISCOVERY=true
npm test
npm run app:build
node scripts/verify-runtime.mjs darwin "$arch"
node scripts/stage-release.mjs darwin
npx --no-install electron-builder --projectDir .release-stage --mac --"$arch" --publish never -c.mac.notarize=false -c.forceCodeSigning=true
app="release/mac${arch/arm64/-arm64}/OpenRoughCut.app"
if [[ "$arch" == x64 ]]; then app='release/mac/OpenRoughCut.app'; fi
scripts/verify-macos.sh "$app"
shasum -a 256 release/OpenRoughCut-*-mac-"$arch".dmg release/OpenRoughCut-*-mac-"$arch".zip > "release/SHA256SUMS-$arch.txt"
git rev-parse HEAD > "release/REVISION-$arch.txt"
git diff --exit-code HEAD -- src electron ui scripts build package.json package-lock.json

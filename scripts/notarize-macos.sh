#!/bin/bash
# Owner-only external submission, never called by candidate or CI checks.
set -euo pipefail
[[ "${1:-}" == --submit ]] || { echo 'Usage: scripts/notarize-macos.sh --submit App.app output-directory' >&2; exit 1; }
: "${ORC_NOTARY_PROFILE:?Set an existing notarytool Keychain profile}"
app="${2:?App path required}"
out="${3:?New output directory required}"
[[ ! -e "$out" ]] || { echo 'Output directory already exists' >&2; exit 1; }
scripts/verify-macos.sh "$app"
mkdir -p "$out"
ditto -c -k --keepParent "$app" "$out/submission.zip"
xcrun notarytool submit "$out/submission.zip" --keychain-profile "$ORC_NOTARY_PROFILE" --wait --output-format json > "$out/notary-app.json"
node -e 'if(JSON.parse(require("fs").readFileSync(process.argv[1])).status!=="Accepted")process.exit(1)' "$out/notary-app.json"
xcrun stapler staple "$app"
scripts/verify-macos.sh "$app" --gatekeeper
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
arch=$(lipo -archs "$app/Contents/MacOS/OpenRoughCut")
[[ "$arch" != x86_64 ]] || arch=x64
base="OpenRoughCut-$version-mac-$arch"
ditto -c -k --keepParent "$app" "$out/$base.zip"
mkdir "$out/dmg-root"
ditto "$app" "$out/dmg-root/OpenRoughCut.app"
ln -s /Applications "$out/dmg-root/Applications"
hdiutil create -volname OpenRoughCut -srcfolder "$out/dmg-root" -format UDZO "$out/$base.dmg"
: "${CSC_NAME:?Set Developer ID Application identity for DMG signing}"
codesign --sign "$CSC_NAME" --timestamp "$out/$base.dmg"
xcrun notarytool submit "$out/$base.dmg" --keychain-profile "$ORC_NOTARY_PROFILE" --wait --output-format json > "$out/notary-dmg.json"
node -e 'if(JSON.parse(require("fs").readFileSync(process.argv[1])).status!=="Accepted")process.exit(1)' "$out/notary-dmg.json"
xcrun stapler staple "$out/$base.dmg"
xcrun stapler validate "$out/$base.dmg"
spctl --assess --type open --context context:primary-signature --verbose=4 "$out/$base.dmg"
shasum -a 256 "$out/$base.zip" "$out/$base.dmg" > "$out/SHA256SUMS.txt"
echo 'Notarized artifacts prepared. Publication remains manual.'

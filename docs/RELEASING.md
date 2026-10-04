# Releasing OpenRoughCut

OpenRoughCut uses one normal app installer and a one-click first-run setup. The installer bundles whisper.cpp, but it does **not** distribute FFmpeg or FFprobe. After the user approves setup, OpenRoughCut downloads the pinned editing-engine archives directly from their upstream build provider, verifies their exact size and SHA-256 digest, extracts only the required executables, and stores them in OpenRoughCut's user-data directory. No Terminal or package manager is involved.

## Runtime layout

Populate the bundled runtime for every architecture you publish:

```text
vendor/
  darwin-arm64/bin/whisper-cli
  darwin-x64/bin/whisper-cli
  win32-x64/bin/{whisper-cli.exe,whisper.dll,ggml*.dll}
  win32-x64/prerequisites/vc_redist.x64.exe
```

The bundled binaries must be redistributable, executable, and include any dynamically linked libraries they require. Each target has a `runtime-manifest.json` containing the pinned upstream versions, source URLs, SHA-256 digests, build details, and distribution method. The installer packaging rules explicitly include whisper.cpp files and exclude FFmpeg/FFprobe. whisper.cpp is distributed under the MIT license.

The currently pinned FFmpeg 8.1.2 downloads include libx264 and are GPL builds. The download-on-approval design means OpenRoughCut's installer does not convey those executables, but it is still important to retain the upstream license/source information and obtain legal review before a broad commercial release. Do not change the pinned URLs, archive sizes, hashes, or packaging filters independently.

The official Windows whisper.cpp release uses the Microsoft Visual C++ runtime. OpenRoughCut's NSIS installer checks the x64 runtime registry entry and, when it is missing, installs the pinned Microsoft redistributable from `vendor/win32-x64/prerequisites`. The redistributable is an installer prerequisite only and is not copied into the installed app.

Transcription model files are not placed in the installer. Setup downloads the user's selected multilingual Base, Small, or Large-v3 Turbo model plus the Silero VAD model into OpenRoughCut's user-data directory. Only the selected Whisper tier is downloaded; installed tiers remain available when the preference changes. Every download is pinned and integrity checked, and cancelled or failed setup removes its staging files.

## Build commands

```sh
npm ci
npm test
npm run dist:mac
npm run dist:win
```

`dist:mac` creates DMG and ZIP artifacts. `dist:win` creates a one-click, per-user NSIS installer. When the Microsoft Visual C++ runtime is missing, the installer explains why it is needed and asks before launching the pinned Microsoft prerequisite. Each command verifies only the components actually conveyed by that installer; FFmpeg/FFprobe are obtained during first-run setup.

## Candidate and publication boundary

Push and pull request run `.github/workflows/checks.yml` without signing credentials.
The existing `release.yml` is now an explicitly dispatched **unsigned candidate** build.
It uploads CI artifacts only. Neither workflow notarizes or publishes a GitHub release.
Do not distribute these unsigned CI artifacts as a production download.

Use Node 24.17.0 and `npm ci` with the committed lockfile. To reconstruct the native runtime:

```sh
node scripts/prepare-release-runtime.mjs darwin arm64
node scripts/prepare-release-runtime.mjs darwin x64
```

This downloads checksum-pinned archives, including the previous 0.1.1 macOS release,
and validates each extracted executable. Preserve those upstream archives for long-term
reproducibility. This is reproducible dependency selection, not a claim of bit-identical
signed output: signing timestamps and disk image metadata vary.

For a local Developer ID candidate, from a committed application revision:

```sh
npm ci
export CSC_NAME='Developer ID Application: YOUR NAME (YOURTEAMID)'
scripts/macos-candidate.sh arm64
scripts/macos-candidate.sh x64
```

These commands run tests, build, verify runtime inputs, package DMG/ZIP, require signing,
verify nested signatures and dynamic libraries, record revision and checksums. They explicitly
disable notarization and publishing. The packager signs Electron frameworks/helpers and the
additional `Contents/Resources/runtime/bin/whisper-cli`. The app and helpers use the project's
`allow-jit` entitlement; they do not copy Qipli's entitlements. No native Node addons are shipped.

Minimum declared macOS is 12.0, matching the inspected Electron and whisper-cli binaries.
Separate arm64/x64 packages are supported; clean-machine acceptance on both architectures
and the minimum OS is still required. First-run internet access is required for FFmpeg/FFprobe
and the selected transcription model. The installer intentionally does not contain those tools.

## Owner-only notarization and publication

Do not run the following until the candidate passes the acceptance matrix below.
Create or select a notarytool Keychain credential profile for the same team. Credentials
are entered by the owner and never placed in repository files. An existing CI deployment
would need its own protected environment and scoped secrets; Qipli repository secrets do
not automatically become available to this repository. No key export is needed for local signing.

```sh
export ORC_NOTARY_PROFILE='your-existing-profile'
export CSC_NAME='Developer ID Application: YOUR NAME (YOURTEAMID)'
scripts/notarize-macos.sh --submit release/mac-arm64/OpenRoughCut.app release/notarized-arm64
scripts/notarize-macos.sh --submit release/mac/OpenRoughCut.app release/notarized-x64
```

The separate script submits an app ZIP, requires Accepted status, staples and assesses
the app, rebuilds the distribution ZIP, builds/signs/submits/staples a DMG, assesses it,
and writes final checksums. A failed stage stops publication. Inspect notary JSON and
retrieve Apple's log with `xcrun notarytool log ID --keychain-profile "$ORC_NOTARY_PROFILE"`
when a submission is rejected. Never upload the pre-stapling candidate ZIP by mistake.

Mount the final DMG, install into a test account, launch through Finder under Gatekeeper,
complete first-run setup without Homebrew or developer PATH, then test replacement of
the previous app while preserving `~/Library/Application Support/OpenRoughCut` and projects.
Do not remove quarantine to make this check pass. Record actual results for each architecture.

Choose a new version before public release; 0.1.3 already exists. Update package.json and
lockfile together, add reviewed release notes, rebuild and repeat acceptance. The owner
then manually uploads only the final notarized DMG/ZIP, checksums, revision and notes to
a draft release and publishes it after review. No publication command is run by these scripts.
There is no in-app updater; replacement of the .app is the update mechanism.

## Pre-publish checklist

- Pin and review every native tool version and checksum.
- Confirm that the final installer contains whisper.cpp but contains no `ffmpeg` or `ffprobe` executable.
- Retain applicable FFmpeg download/source information and the bundled whisper.cpp license notice.
- Run `npm audit`, `npm test`, and `npm run app:build` from a clean checkout.
- Smoke-test first launch, model approval/cancellation, recovery after forced quit, Save versus Save As, playback, analysis, timeline edits, proxy deletion/rebuild, and every export target.
- Test a large source and a path containing spaces and non-ASCII characters on each supported platform.
- Sign, notarize where applicable, and scan the final installer artifacts.

## Export reproduction and automated desktop smoke

Use a copy of the saved `.roughcut` or recovery session. The following preserves its
retained ranges and uses the actual exporter with an explicit timeline choice:

```sh
FFPROBE="$PWD/vendor/darwin-arm64/bin/ffprobe" node scripts/export-session.mjs \
  /path/to/project.roughcut /path/to/new-full-hd.fcpxml full-hd
npm run app:build
npx --no-install electron scripts/smoke-electron.mjs
```

The exporter refuses an existing output path. The smoke script generates synthetic media,
uses an isolated temporary user-data/cache directory and stubs file dialogs. It checks real
Electron IPC for project creation, analysis, preview cancellation, save/open/recovery,
Full HD export, export failure, missing/restored media and Unicode paths. It does not prove
Finder installation, human playback/audio perception, real file-dialog behavior or Final Cut import.
Temporary smoke data is left at the printed path for diagnosis. FFmpeg/FFprobe in the local
vendor directory are test prerequisites, not installer contents.

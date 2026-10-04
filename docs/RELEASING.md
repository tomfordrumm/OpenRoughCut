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

The candidate directory is printed at completion. By default it is
`~/Library/Caches/OpenRoughCut-release/<revision>`. Set `ORC_RELEASE_DIR` to that printed
absolute path before the notarization commands below. Use an unsynced local directory;
File Provider added FinderInfo to bundles under Documents and caused a real signing failure.
Do not move a raw .app into a synced directory before signing verification.

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
scripts/notarize-macos.sh --submit "$ORC_RELEASE_DIR/mac-arm64/OpenRoughCut.app" "$ORC_RELEASE_DIR/notarized-arm64"
scripts/notarize-macos.sh --submit "$ORC_RELEASE_DIR/mac/OpenRoughCut.app" "$ORC_RELEASE_DIR/notarized-x64"
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

## Audit record, 2026-10-04

Canonical source is `/Users/tomfordrumm/Documents/VideoEditor`, branch
`feature/macos-release-audit`. At the start both directories had identical application,
website, lockfile and workflow bytes. `/Volumes/Code/VideoEditor` has no own `.git` and
resolves to an unrelated empty parent repository at `/Volumes/Code`; it is not a second
Git history. The Documents copy has the project's history from `6feab49` and more local
runtime binaries. Neither copy was removed. Six pre-existing application/test changes
were preserved in local snapshot commit `d61f11b`, not attributed to this audit.
Three pre-existing website changes remain uncommitted with byte-identical diffs; the
untracked `.impeccable` directory and earlier fixed XML remain untouched. No gitlinks,
credentials, real media or recovery sessions were committed.

### FCPXML finding

The saved recovery session for the September 30 recording says `projectResolution: source`
at `2026-09-30T16:50:13.355Z`. The original XML has both source and timeline at 3840×1080.
The renderer defaults to `source`, saves this field through `sessionDocument`, restores it
through `loadSessionFile`, and passes it directly into export. The exporter resolves the
chosen size separately from asset metadata. There is no evidence that a Full HD choice
was lost. It is not possible to prove whether the user explicitly selected Source or left
its default. The export button now shows the resolved timeline dimensions, and source
metadata is labelled separately.

The historical screenshot says the XML **was imported with warnings**, not rejected.
It reports `Encountered an unexpected value (format="r3")` on the compound and project
sequences. The cause established by the saved state is a source-size timeline contrary
to the intended Full HD output. Why this particular custom format produces Final Cut's
warning remains an import compatibility question. No generator format/color patch was
made, and the earlier `FFVideoFormat1080p30`/3840×1080 patch was not adopted.

Current ffprobe evidence: source 3840×1080, 30/1 fps, SAR 1:1, DAR 32:9, progressive,
BT.709 matrix/transfer/primaries, stereo 48 kHz. Re-export using `full-hd` produces source
format 3840×1080 and named timeline format `FFVideoFormat1080p30` for both compound and
project. All 120 ordered ref-clip attributes, source audio metadata and original media URL
match the original export. Timeline length is `6107/6s`, 16:57:25 at 30 fps.
The new XML passes the installed FCPXML 1.10 DTD.

Local test file: `release/audit/2026-09-30-full-hd-v2.fcpxml`. It contains private source
paths and is deliberately excluded from Git. The original export and recovery are untouched.
The exporter adds no crop, transform, conform or color-space override. Expected Fit display
is a 1920×540 picture with 270-pixel bars above/below in the 1920×1080 frame; this is an
expectation from spatial conform, not an observed Final Cut result. Color management is
left to Final Cut and source metadata. The generic probe currently does not retain color,
field-order or pixel-aspect metadata, so HDR/anamorphic/rotated-source support needs separate
validation before making wider support claims.

### Findings and release gates

| Priority | Finding / status |
| --- | --- |
| Blocks release | Real Full HD import, visual framing and audio playback remain unverified. Final Cut 12.3 is installed but Computer Use reported the Mac locked. Must inspect a separate test library and round-trip XML, all 120 ranges, source/compound/project sizing, ordering, timing and sound. |
| Blocks release | Notarization, stapling and Gatekeeper acceptance intentionally not executed. Credentials/profile selection remains owner work. |
| Blocks release | Installed-artifact launch, first-run downloads without developer tools, and replacement of an earlier version preserving user data remain unverified. No running user app was replaced or stopped. |
| Blocks release | Minimum macOS 12 and native Intel acceptance remain unverified. Host is macOS 26.6.2 arm64. Electron 43 supports Monterey but reaches EOL January 5, 2027; plan an OS/support decision before then. |
| Fixed | Tag push previously published unsigned releases. Workflows now separate PR checks from manual unsigned candidate builds; publication is owner-only. |
| Fixed | Full dependency audit initially found 11 high and 1 moderate vulnerability, including Electron. Electron 43.7.7 and compatible lockfile updates produce zero current npm audit findings. `--omit=dev` is insufficient because Electron ships in the app. |
| Fixed | Packaged code could honor a developer URL environment variable; now disabled when packaged. IPC handlers check the exact main frame and renderer URL. Context isolation, sandbox, disabled Node integration, blocked navigation/windows and bounded media tokens were already present. |
| Fixed | Missing source during recovery was swallowed as if recovery did not exist. Now reports the missing path and restoration action without deleting the saved session. A relink UI remains desirable. |
| Fixed | Explicit MIT notices for React/React DOM and Electron/Chromium notices were missing from the packaging configuration; added alongside the existing whisper.cpp notice. |
| Fixed | Application tests accidentally depended on untracked website build output; now explicitly run `test/*.test.js`. Clean source install/tests/build pass. |
| Desirable | Review product license and rights/provenance of app icons before distribution. No root product LICENSE was found; do not infer an open-source license from the name. FFmpeg downloads are GPL builds and remain outside the installer; retain upstream license/source information. This is a distribution inventory, not legal clearance. |
| Desirable | Add a user-driven media relink workflow and test disk-full/partial export writes. File dialogs and session writes are bounded; successful IPC recovery tests do not prove every storage failure path. |
| Can defer | In-app updater, universal binary and broad refactoring. Separate arm64/x64 packages and manual app replacement meet the current delivery model. |

Automated evidence: 89 application tests pass; full npm audit reports zero vulnerabilities;
clean `git archive` + `npm ci` + tests + Vite build passes without local dist files.
Real Electron IPC smoke passed preview cancellation, create/analyse, save/reopen/recovery,
Full HD export, export write failure, dialog cancellation, missing/restored media and paths
with spaces/Cyrillic. It uses synthetic media and stubbed dialogs, not the installed artifact.
No native Node modules are in the app payload. Inspected whisper and FFmpeg/FFprobe Mach-O
minimum OS is 12.0, and whisper links only system frameworks/libraries. Runtime manifests
and local bundled binaries passed SHA-256 verification for both macOS architectures.

### Qipli reuse and ownership

Qipli was inspected read-only: its release workflow uses a protected `release` environment,
a temporary CI Keychain, Developer ID and App Store Connect secrets, explicit notarization
and artifact verification. Its Sparkle pipeline is unrelated to OpenRoughCut and was not copied.
The reusable parts are the stage separation and credential isolation, not bundle identity,
Swift build commands, entitlements or updater configuration.

`security find-identity -v -p codesigning` finds Developer ID Application for Sviatoslav
Zhilichev, Team `3N2R5K4J63`, fingerprint `6C2AE064708B7EABC3BA88BE82616310765F23A0`.
Certificate validity is August 26, 2026 through February 1, 2027. This certificate type is
appropriate for direct macOS distribution of another app by the same team. Apple Development
identities are also present but are not used for this candidate. Actual successful nested
Developer ID signatures confirm private-key usability; merely listing identities was not
treated as signing proof. No keys were exported, certificates changed or global Keychain ACLs modified.

No notary credential variables were present in this shell and no known usable profile was
identified. This does not prove that no profile exists in any Keychain. Owner must supply an
existing notarytool profile name or configure credentials for this team. Qipli CI secret names
were inspected, not secret values; their availability in an OpenRoughCut CI environment is
not established. No Apple submission, public upload, push, merge or live infrastructure change occurred.

### Draft release notes for the next version

- Show the timeline dimensions before export and identify source dimensions separately.
- Explain missing media when opening or recovering a project.
- Restrict packaged renderer loading and IPC senders.
- Update Electron and vulnerable build dependencies; include bundled library notices.
- Separate local signed candidates from notarization and manual publication.
- Preserve the earlier silence/nonverbal changes in their own commit for owner review.

Do not claim Final Cut acceptance, minimum-OS support or installation/update acceptance in
public release notes until those gates have evidence.

### Official references checked during the audit

- [Apple Developer ID](https://developer.apple.com/help/account/certificates/create-developer-id-certificates)
- [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)
- [electron-builder 26 macOS options](https://www.electron.build/v26/docs/mac/)
- [Final Cut spatial conform](https://support.apple.com/en-ca/guide/final-cut-pro/ver3363b44e/mac)
- [Electron release support schedule](https://releases.electronjs.org/schedule)

The installed electron-builder 26.15.3 implementation was also inspected because its default
entitlements differ from newer documentation. The project explicitly grants only `allow-jit`
instead of inheriting broad unsigned-memory/library-validation exceptions.

### Completed candidate evidence

Application/pipeline revision: `8755bfdfc08170cbab8b12c7e30900afb586cbfa`.
Later documentation-only commits do not change these binaries.
Artifacts: `~/Library/Caches/OpenRoughCut-release/8755bfdfc081/`.

| Stage | Observed result |
| --- | --- |
| Clean dependency install, 89 tests, renderer build | Passed from a fresh archive of this revision |
| Runtime reconstruction | Both macOS runtimes downloaded into the fresh source tree from pinned upstream release archives; archive/executable hashes verified |
| Electron IPC smoke | Passed again at this revision with isolated user data |
| arm64 and x64 packaging | Both candidate commands exited successfully; DMG and ZIP produced for each architecture |
| App signatures | Developer ID, team `3N2R5K4J63`, secure timestamp, hardened runtime, only `allow-jit` app entitlement; strict/deep validation passed |
| Nested code and linking | All 16 Mach-O files per architecture verified, same team, no developer-machine library paths |
| Bundled payload | No `.node` modules, embedded node_modules, private session or secret files in ASAR; no ffmpeg/ffprobe executables in installer |
| DMG and ZIP verification | Both DMGs passed hdiutil verification, mounted read-only, contained valid signed apps and were detached. Extracted ZIP apps passed strict/deep codesign. All four recorded SHA-256 checksums match |
| Signed native tool | arm64 bundled whisper-cli `--help` exited 0 |
| DMG outer signature | Candidate DMG containers are unsigned; owner notarization script builds/signs the final containers after app stapling |
| Gatekeeper | arm64 app assessment rejected with `source=Unnotarized Developer ID`, expected before notarization; never bypassed |
| Notarization / stapling | Not submitted / not performed |
| Installed app launch / upgrade | Not performed; GUI was locked. IPC smoke is not this acceptance gate |
| Final Cut import / playback | Not performed; GUI was locked. XML and range comparisons are not this acceptance gate |

Qipli environment secret **metadata** was checked with `gh secret list --repo tomfordrumm/Qipli --env release`.
All expected Developer ID P12/password, team, identity and notary key/issuer/ID names are
present. Values and operational validity were not read or exercised. Additional local
Apple Development certificates expire August 7, 2027 for team `97869YN5V9` and August 26,
2027 for team `3N2R5K4J63`. They are development identities, not direct-distribution substitutes.

Checksums and full application revision are alongside the artifacts in `SHA256SUMS-arm64.txt`,
`SHA256SUMS-x64.txt`, `REVISION-arm64.txt` and `REVISION-x64.txt`. Local diagnostic logs and
Full HD XML are under the ignored `release/audit/` directory. These artifacts remain
candidates, not a new public 0.1.3 release.

### Remaining owner actions in order

1. Unlock the Mac for a real Final Cut check. Import the Full HD XML into a separate test
   library; verify no warnings, 1920×1080/30p, all 120 clips and 16:57:25 duration. Inspect
   first/middle/last cuts and transitions, listen for audio/sync, inspect Source spatial
   conform and framing, and export XML back to compare every source range and timeline offset.
2. Test the signed app from each architecture's DMG in a test account without developer
   tools. Exercise first-run setup, preview/analysis/transcription, save/reopen/recovery,
   cancellation and export. On appropriate hardware, test macOS 12 and native Intel.
   Install an earlier release first and replace only the app, checking sessions, settings,
   downloaded models and media remain intact. Do not reset the user's actual profile.
3. Confirm icon/product licensing, choose a new public version, update version/lockfile and
   release notes, commit locally and rebuild both candidates. The existing version 0.1.3
   must not be silently replaced by different bytes.
4. Select/configure an Apple notarization Keychain profile for team `3N2R5K4J63`, set
   `ORC_NOTARY_PROFILE`, `CSC_NAME` and the printed `ORC_RELEASE_DIR`, then run the two
   `notarize-macos.sh --submit` commands documented above. This is the first external upload.
5. Verify Accepted responses, stapling, Gatekeeper and final installer launch. Review final
   SHA-256 files and publish the notarized DMG/ZIP, source revision and notes manually.
   Do not publish the unsigned candidate DMG containers or pre-stapling candidate ZIPs.

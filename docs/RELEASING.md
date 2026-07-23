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

Transcription model files are not placed in the installer. The same first-run approval downloads the multilingual base model and Silero VAD model into OpenRoughCut's user-data directory. Every download is pinned and integrity checked, and cancelled or failed setup removes its staging files.

## Build commands

```sh
npm ci
npm test
npm run dist:mac
npm run dist:win
```

`dist:mac` creates DMG and ZIP artifacts. `dist:win` creates a one-click, per-user NSIS installer. When the Microsoft Visual C++ runtime is missing, the installer explains why it is needed and asks before launching the pinned Microsoft prerequisite. Each command verifies only the components actually conveyed by that installer; FFmpeg/FFprobe are obtained during first-run setup.

## Automated releases

Push a version commit to `main`, then push the matching annotated tag (for example, `v0.1.2`). `.github/workflows/release.yml` validates that the tag matches `package.json`, runs the application and website tests, reconstructs the ignored native runtime from pinned checksum-verified sources, and builds each installer on its native operating system. After every target succeeds, the workflow publishes the tag as a GitHub Release with all five platform artifacts and `SHA256SUMS.txt`.

The Apple Silicon and Intel `whisper-cli` binaries are recovered from the checksum-pinned 0.1.1 release packages because whisper.cpp does not publish standalone macOS CLI archives. The Windows runtime and Visual C++ prerequisite are fetched from their pinned upstream URLs. `scripts/prepare-release-runtime.mjs` verifies the archive and every extracted binary before packaging.

Build and sign macOS artifacts on macOS, including separate arm64 and x64 releases or a deliberately assembled universal runtime. Build and sign the Windows installer on Windows. Configure Apple notarization and Windows code-signing identities in the release environment; do not publish unsigned installers as production downloads.

## Pre-publish checklist

- Pin and review every native tool version and checksum.
- Confirm that the final installer contains whisper.cpp but contains no `ffmpeg` or `ffprobe` executable.
- Retain applicable FFmpeg download/source information and the bundled whisper.cpp license notice.
- Run `npm audit`, `npm test`, and `npm run app:build` from a clean checkout.
- Smoke-test first launch, model approval/cancellation, recovery after forced quit, Save versus Save As, playback, analysis, timeline edits, proxy deletion/rebuild, and every export target.
- Test a large source and a path containing spaces and non-ASCII characters on each supported platform.
- Sign, notarize where applicable, and scan the final installer artifacts.

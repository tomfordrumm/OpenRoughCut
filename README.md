# OpenRoughCut

`openroughcut` finds long silences in a video and creates an editable timeline that skips most of each silence. It references the original media, so it does not render, transcode, or duplicate the recording.

Timeline export supports:

- Final Cut Pro — FCPXML (`.fcpxml`)
- Adobe Premiere Pro — Final Cut Pro 7 interchange XML (`.xml`)
- DaVinci Resolve — OpenTimelineIO (`.otio`)

The imported event contains two editable items:

- `<recording> — Source` — a compound clip containing the full original recording.
- `<recording> — Rough Cut` — a project whose edits reference ranges of that compound clip.

Open the Source compound clip to crop, reposition, transform, or otherwise adjust the original video once. Those changes flow through to every retained range in the Rough Cut project.

## CLI requirements

- Node.js 20.19 or newer
- `ffmpeg` and `ffprobe` available on `PATH`
- Final Cut Pro with FCPXML 1.10 support, Premiere Pro, or DaVinci Resolve 18.5+

## Run it

No package installation is needed:

```bash
node src/cli.js /path/to/recording.mov
```

If the source has a non-standard resolution, the CLI asks which Final Cut project resolution to use:

```text
Non-standard source resolution detected: 3840x1080
Choose the Final Cut project resolution:
  1) Source (3840x1080)
  2) UHD 4K (3840x2160)
  3) Full HD (1920x1080)
Selection [1]:
```

The source asset always keeps its real dimensions. The choice only controls the project timeline. For scripts, skip the prompt with `--project-resolution source`, `4k`, or `full-hd`.

The defaults are intentionally conservative:

```bash
node src/cli.js recording.mov \
  --threshold -35 \
  --minimum-silence 0.7 \
  --keep-pause 0.18
```

This writes:

- `recording.roughcut.fcpxml` — import with **File → Import → XML** in Final Cut Pro.
- `recording.roughcut.json` — settings, duration summary, and the exact removed ranges.

Choose another editor with `--format`:

```bash
node src/cli.js recording.mov --format premiere
node src/cli.js recording.mov --format resolve
```

Premiere exports `.roughcut.xml`; import it with **File → Import**. Resolve exports `.roughcut.otio`; import it with **File → Import → Timeline**. Both formats preserve the editable cut points, embedded source timecode, and reference the untouched original recording. OTIO does not apply timeline resolution, so set the displayed target size in Resolve after importing.

Run `node src/cli.js --help` for all options.

## Desktop app

Install the interface dependencies once, then launch the development app:

```bash
npm install
npm run app
```

The interface keeps every edit in the original recording's source time:

1. Choose a local video. OpenRoughCut creates and caches a lightweight H.264/AAC playback proxy automatically; the original media is never replaced.
2. Optionally enable **Find false starts and repeated takes** to run local Whisper analysis.
3. Click **Analyse source**. Progress is visible and the operation can be cancelled.
4. Adjust silence threshold, minimum silence, pause to keep, or transcript confidence, then re-analyse explicitly. Changed settings mark old results as out of date and disable export until analysis is refreshed.
5. Click any red silence or purple transcript region to inspect the decision. Choose **Keep this region** to override an applied removal, or **Remove this take** to accept a transcript suggestion.
6. Drag across the timeline to add a manual removal. Manual keep/remove decisions always override automatic decisions.
7. Enable **Edited preview** to play the final edit plan, skipping all currently removed ranges.
8. Save the work as a small `.roughcut` file, choose Final Cut Pro, Premiere Pro, or DaVinci Resolve in the toolbar, and export the editable timeline. After a session has a path, **Save** overwrites that file instead of opening Save As again.

Use `⌘Z` / `⇧⌘Z` for undo/redo, Space for play/pause, `R`/`K` to classify the selected range, and Delete to clear it. Session files contain the source path, settings, analysis ranges, and manual overrides; they never embed media. OpenRoughCut also keeps an atomic recovery copy in its user-data directory and restores it after a restart or unexpected exit.

For a production renderer build:

```bash
npm run app:build
npm run app:preview
```

Sources use a bounded 720p H.264/AAC proxy with frequent keyframes for predictable Chromium playback and fast jumps across large cuts. Proxies are stored in the operating-system cache and reused while the source path, size, and modification time remain unchanged. Every timeline export still references the untouched original recording.

Public macOS and Windows packages use `electron-builder` and bundle the private whisper.cpp runtime. On first launch, one setup approval downloads and verifies the editing engine and on-device speech models; users do not need Terminal or a package manager. FFmpeg and FFprobe are deliberately excluded from the app installer. See [docs/RELEASING.md](docs/RELEASING.md) for runtime layout, signing, licensing, and installer commands.

Use **Storage** in the top toolbar to inspect that cache. The storage manager shows every proxy, its source name when known, modification date, size, and whether it belongs to the currently open source. Proxies can be deleted individually or all at once. Deleting the current proxy only disables playback until **Rebuild preview** is clicked; analysis, manual decisions, sessions, originals, and exported timelines are never removed.

Use **Logs** in the toolbar or setup screen to reveal `logs/openroughcut.log` in the operating system's file manager. The app records startup/runtime checks, selected-media inspection results, operation failures, and renderer crashes. The structured log rotates at 2 MB and retains one previous file. It includes selected file paths and system/runtime details, but never video or audio content; review it before sharing if paths are sensitive.

## Experimental transcription edits

Install the local runtime and download the multilingual base model:

```bash
brew install whisper-cpp
mkdir -p .models
curl -L -o .models/ggml-base.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin
curl -L -o .models/ggml-silero-v6.2.0.bin \
  https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin
```

Then enable transcript-based editing:

```bash
node src/cli.js recording.mov --transcribe
```

Whisper runs locally, uses voice-activity detection to reject silence, and automatically detects the spoken language. Exact repeated takes and strong false starts are added to the timeline cuts. Ambiguous matches are preserved and written as suggestions in the JSON report.

Use `--text-suggestions-only` to generate a transcript and suggestions without applying text edits. Adjust the conservative auto-remove threshold with `--text-confidence 0.9`, or pass a specific model with `--whisper-model /path/to/model.bin`.

## Calibrating a recording

- Speech is treated as silence: lower the threshold, for example from `-35` to `-42` dB.
- Room noise is treated as speech: raise the threshold, for example from `-35` to `-30` dB.
- Natural pauses are cut too often: increase `--minimum-silence`.
- The edit feels too abrupt: increase `--keep-pause`.

OpenRoughCut analyses the first audio stream and assumes a constant-rate video. Review the generated timeline before using it as an edit base.

## Tests

```bash
npm test
```

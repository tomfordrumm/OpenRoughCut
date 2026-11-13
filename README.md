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

## Repository layout

One repository, three npm workspaces. The CLI and the desktop app run the same pipeline from `packages/core`, so on the same recording and settings they produce the same edit plan.

| Workspace | Contents |
| --- | --- |
| `packages/core` (`@openroughcut/core`) | The pipeline: pauses (FFmpeg `silencedetect`), whisper.cpp transcription and word timing, `last-take`/`rules` take detection, non-verbal sounds, agent review, edit plan and cleanup, FCPXML/Premiere/OTIO export, FFmpeg rendering, media/process helpers. No console output, prompts, `process.exit` or Electron. |
| `packages/cli` (`@openroughcut/cli`) | Argument parsing, the terminal resolution prompt, the JSON report and the `openroughcut` binary. |
| `apps/desktop` | Electron main process and preload, the React UI (`ui/`), IPC policy, logging, playback proxies, waveform, runtime downloads, packaging and signing scripts (`scripts/`, `build/`). |

The core API, used by both front ends (and usable from a server worker):

```js
import { analyze, applyDecisions, buildPlan, exportPlan, createReport } from "@openroughcut/core";

const analysis = await analyze("talk.mov", { transcribe: true }, {
  signal, onProgress: ({ stage, message, percent }) => {}, models: { whisper, vad },
});
const plan = buildPlan(analysis, manualOverrides);          // keep/remove overrides in seconds
await exportPlan(plan, { format: "final-cut", inputPath: "talk.mov", outputPath, media: analysis.media, projectResolution });
```

`applyDecisions(reviewPacket, decisions)` turns an agent's review decisions into the `speech` option of `analyze`, which then reuses the packet's transcript instead of running Whisper. `vendor/` (bundled runtimes) and `.models/` (Whisper models for the CLI) stay at the repository root.

## CLI requirements

- Node.js 20.19 or newer
- `ffmpeg` and `ffprobe` available on `PATH`
- Final Cut Pro with FCPXML 1.10 support, Premiere Pro, or DaVinci Resolve 18.5+

## Run it

Install once from the repository root (this links the workspaces), then run the CLI:

```bash
npm install
```

```bash
node packages/cli/src/cli.js /path/to/recording.mov
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
node packages/cli/src/cli.js recording.mov \
  --threshold -35 \
  --minimum-silence 0.7 \
  --keep-pause 0.18
```

This writes:

- `recording.roughcut.fcpxml` — import with **File → Import → XML** in Final Cut Pro.
- `recording.roughcut.json` — settings, duration summary, and the exact removed ranges.

Choose another editor with `--format`:

```bash
node packages/cli/src/cli.js recording.mov --format premiere
node packages/cli/src/cli.js recording.mov --format resolve
```

Premiere exports `.roughcut.xml`; import it with **File → Import**. Resolve exports `.roughcut.otio`; import it with **File → Import → Timeline**. Both formats preserve the editable cut points, embedded source timecode, and reference the untouched original recording. OTIO does not apply timeline resolution, so set the displayed target size in Resolve after importing.

To get the cut video itself instead of a timeline, render it:

```bash
node packages/cli/src/cli.js recording.mov --transcribe --format mp4
```

This writes `recording.roughcut.mp4`:

- Video is H.264, encoded with VideoToolbox on macOS and x264 elsewhere.
- Audio is AAC, with a 5 ms fade at every join so cuts do not click.
- The frame rate is the source's.
- The frame size is `--project-resolution`, with the source fitted inside it.

The desktop app offers the same output as **Video MP4** in the export menu.

Run `node packages/cli/src/cli.js --help` for all options.

## Desktop app

Install the dependencies once from the repository root, then launch the development app (the root scripts delegate to `apps/desktop`):

```bash
npm install
npm run app
```

The interface keeps every edit in the original recording's source time:

1. Choose a local video. OpenRoughCut creates and caches a lightweight H.264/AAC playback proxy automatically; the original media is never replaced.
2. Enable **Remove sounds without words** to automatically cut isolated sighs, clicks, and humming. Optionally enable **Find false starts and repeated takes**; Whisper transcribes speech locally.
3. Click **Analyse source**. Progress is visible and the operation can be cancelled.
4. Adjust silence threshold, minimum silence, pause to keep, or transcript confidence, then re-analyse explicitly. Changed settings mark old results as out of date and disable export until analysis is refreshed.
5. Click any red silence or purple transcript region to inspect the decision. Choose **Keep this region** to override an applied removal, or **Remove this take** to accept a transcript suggestion.
6. Drag across the timeline to add a manual removal. Manual keep/remove decisions always override automatic decisions.
7. Enable **Edited preview** to play the final edit plan, skipping all currently removed ranges.
8. Save the work as a small `.roughcut` file, choose Final Cut Pro, Premiere Pro, or DaVinci Resolve in the toolbar, and export the editable timeline. After a session has a path, **Save** overwrites that file instead of opening Save As again.

### Repeated takes and sound cleanup

Enable **Find false starts and repeated takes** and pick a detector under **Fine-tune** (`last-take` by default, or `rules`; see [Duplicate detection modes](#duplicate-detection-modes)). Both run locally and instantly; no extra model download is needed beyond Whisper.

After take selection, non-word sound detection checks isolated sounds of any duration, protects recognized speech, and trims cuts before neighboring words. Fine quiet intervals are joined across gaps of up to one video frame when no retained word crosses the gap, before applying the minimum-silence threshold. The shared preview/export plan removes empty pause handles next to deleted speech, including longer empty gaps between deleted attempts. Explicit manual keeps and intervening retained speech remain protected. Progress is visible and analysis can be cancelled.

Partial cuts require an exact match between the transcript and Whisper word timing. When timing is missing, contradictory or overlaps retained words, the app shows a text-only suggestion and disables **Remove take** for that suggestion. Full-region cuts require coverage of every sentence in that region. Review the edited preview before exporting; matching source words do not establish that all useful thoughts are retained.

The mode is saved with the project. Older projects retain the rules mode; changing the mode invalidates previous analysis. Projects saved with the removed `gemma-conservative` mode reopen with `last-take` and need to be analysed again.

Use `⌘Z` / `⇧⌘Z` for undo/redo, Space for play/pause, `R`/`K` to classify the selected range, and Delete to clear it. Session files contain the source path, settings, analysis ranges, and manual overrides; they never embed media. OpenRoughCut also keeps an atomic recovery copy in its user-data directory and restores it after a restart or unexpected exit.

For a production renderer build:

```bash
npm run app:build
npm run app:preview
```

Sources use a bounded 720p H.264/AAC proxy with frequent keyframes for predictable Chromium playback and fast jumps across large cuts. Proxies are stored in the operating-system cache and reused while the source path, size, and modification time remain unchanged. Every timeline export still references the untouched original recording.

Public macOS and Windows packages use `electron-builder` and bundle the private whisper.cpp runtime. Setup lets users choose Base (fastest), Small (balanced), or Large-v3 Turbo (best accuracy), then downloads and verifies only that on-device speech model. Previously installed tiers remain selectable without another download. Users do not need Terminal or a package manager. FFmpeg and FFprobe are deliberately excluded from the app installer. See [docs/RELEASING.md](docs/RELEASING.md) for runtime layout, signing, licensing, and installer commands.

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
node packages/cli/src/cli.js recording.mov --transcribe
```

Whisper runs locally, detects the spoken language from one representative speech region, and reuses that language for the remaining regions. Exact token timestamps protect real words while short isolated sounds with no lexical speech are merged into their surrounding silence and removed conservatively. Transcript regions use pauses up to 0.5 seconds so quick retries can be separated without changing the user's silence-removal setting. Each region is transcribed independently, compared with nearby speech, and kept as the exact unit of any transcript edit. Exact repeated takes and strong false starts are added to the timeline cuts. Ambiguous matches are preserved and written as suggestions in the JSON report.

### Duplicate detection modes

- `last-take` (default) follows the rule an editor uses on a talking-head recording: when a line is started again, everything from the start of the first attempt up to the start of the final attempt is removed, including muttering and recording instructions in between. A restart is recognised by a repeated opening ("И результаты…" → "И результаты получились…") or by an abandoned attempt followed by speech reusing its key words. Restarts inside one Whisper segment are cut only where word timing is measured. A retake with other speech between the attempts, or whose last attempt is itself unfinished or flawed, stays a suggestion. It runs instantly and needs no model.
- `rules` compares neighbouring regions word by word and removes only near-identical repeats and strong false starts.

Score a detector against a finished edit with `node scripts/eval-takes.mjs author.roughcut [--transcript other.json] [--mode last-take|rules] -v`. The author's final plan is the reference; every transcript segment counts as removed when at least half of it was cut.

Use `--remove-non-verbal` to apply the same isolated-sound cleanup from the CLI. Use `--text-suggestions-only` to generate a transcript and suggestions without applying text edits. Adjust the conservative auto-remove threshold with `--text-confidence 0.9`, or pass a specific model with `--whisper-model /path/to/model.bin`.

### Agent review

The CLI can hand its take decisions to an outside agent, such as an LLM driving the terminal, for the cases a word-matching rule cannot settle: reworded retakes, superseded calls to action, asides.

```sh
# 1. Cut as usual and also write a review packet
openroughcut recording.mov --threshold -28 --review recording.review.json

# 2. The agent reads the packet and writes decisions.json (see below)

# 3. Rebuild the timeline from the packet's transcript; Whisper does not run again
openroughcut recording.mov --threshold -28 --decisions decisions.json
```

The packet contains:

- `units`: the transcript in speaking order, with ids and times. `cutBy` names the candidate that currently removes a unit.
- `candidates`: the detector's findings. `applied` says whether a candidate is already cut. `keptUnit` is the take the detector keeps instead.
- `instructions`: the editing rule, written for the agent.
- `applyCommand`: step 3 with this run's settings already filled in.
- The full transcript.

The agent answers only with ids, so every cut lands on measured speech boundaries:

```json
{
  "format": "openroughcut-decisions-v1",
  "review": "recording.review.json",
  "keep":   [{ "id": "c4", "reason": "not a retake, a new point" }],
  "remove": [{ "id": "c7", "reason": "earlier attempt of u31" }],
  "cut":    [{ "units": ["u10"], "reason": "superseded call to action" }]
}
```

- `keep` restores a cut candidate.
- `remove` applies a suggestion.
- `cut` removes a run of consecutive units the detector missed.
- To prefer an earlier take, `keep` its candidate and `cut` the later take.

Invalid decisions stop the run with an error and change nothing. That covers:

- unknown ids;
- contradictory or duplicate decisions;
- gaps inside a cut;
- cutting the take that an applied candidate keeps;
- a packet made for a different recording.

### Duplicate modes from the CLI

The explicit `--duplicate-mode last-take|rules` option enables transcription, so `--transcribe` is optional alongside it. With no mode option, `--transcribe` and `--text-suggestions-only` use `last-take`. `--text-confidence` controls both detectors.

Append `--text-suggestions-only` to put all text proposals in the report without applying speech deletions. Silence cuts and an explicitly selected `--remove-non-verbal` still operate. The JSON report records the actual detector in `textEdits.mode`, its policy in `textEdits.summary`, applied speech deletions in `textEdits.applied`, candidates eligible for automatic removal in `textEdits.autoEligible`, and blocked or untimed proposals in `textEdits.requiresReview`. `textEdits.suggestions` contains every proposal left unapplied, including eligible ones in suggestions-only mode. `cuts` records the final frame-aligned removals, including silence and non-verbal cuts.

The CLI creates a new timeline from source media; it does not load or revise saved projects or manual decisions. Use a distinct output path to keep earlier exports. Successful completion establishes that the analysis ran, not that the edit preserves every useful thought or sounds natural. Listen to the edited sequence and review disputed proposals before accepting it.

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

This runs every workspace's tests plus `test/pipeline-parity.test.js`, which checks that the CLI and the desktop path call the same core steps and export the same timeline. `npm test -w @openroughcut/core`, `-w @openroughcut/cli` or `-w apps/desktop` runs one workspace.

Release scripts live in `apps/desktop/scripts` (`npm run dist:mac` etc. still work from the root); installers are written to `release/` at the repository root.

### Transcript review prototype

Projects with a speech transcript open in **Монтаж по тексту**: compare connected take chains, highlight word differences, listen to a source range, keep/remove attempts, and undo decisions. **Весь текст** edits whole transcript blocks. **Таймлайн и настройки** returns to the existing workspace. Untimed partial suggestions expose a separate whole-block action with the complete source text.

For the current local recording demo, run `npm exec -w apps/desktop vite -- --host 127.0.0.1 --port 5190` and open `http://127.0.0.1:5190/?mock=review`. The development-only demo uses `.roughcut-tmp/review-demo.json` and `.roughcut-tmp/review-demo.mp4`, stores its edits in browser storage, and downloads an editable `.roughcut` via **Save project**. Video export remains in the desktop application.

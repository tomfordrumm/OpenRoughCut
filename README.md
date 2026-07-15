# Roughcut PoC

`roughcut` finds long silences in a video and creates a Final Cut Pro timeline that skips most of each silence. It references the original media, so it does not render, transcode, or duplicate the recording.

The imported event contains two editable items:

- `<recording> — Source` — a compound clip containing the full original recording.
- `<recording> — Rough Cut` — a project whose edits reference ranges of that compound clip.

Open the Source compound clip to crop, reposition, transform, or otherwise adjust the original video once. Those changes flow through to every retained range in the Rough Cut project.

## Requirements

- Node.js 20 or newer
- `ffmpeg` and `ffprobe` available on `PATH`
- Final Cut Pro with FCPXML 1.10 support

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

Run `node src/cli.js --help` for all options.

## Calibrating a recording

- Speech is treated as silence: lower the threshold, for example from `-35` to `-42` dB.
- Room noise is treated as speech: raise the threshold, for example from `-35` to `-30` dB.
- Natural pauses are cut too often: increase `--minimum-silence`.
- The edit feels too abrupt: increase `--keep-pause`.

The PoC analyses the first audio stream and assumes a constant-rate video. Review the generated timeline before using it as an edit base.

## Tests

```bash
npm test
```

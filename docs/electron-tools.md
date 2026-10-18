# Electron tools workspace

> **Historical context:** this page was written while the Electron and Tauri apps
> coexisted. Mentions of Tauri helpers, pages, tests and regression results describe
> that migration period; the Tauri shell has since been removed and the shared code
> now lives in `electron/src/shared/`. Existing Tauri installs: see the
> [migration guide](electron-migration.md).

Tools in the cloning sidebar or command search opens three utility panes:

- Directorial AI parses direction into instruction, translation hint, rate bias,
  tokens and taxonomy using the existing direction service.
- Speech-rate fit submits translated text, a positive time slot and target
  language to the existing fitting service. Invalid durations block submission.
- Probe file submits an absolute path to the existing ffprobe metadata endpoint.

Each operation starts only on explicit submission. Switching tools aborts the
frontend request and prevents stale results from replacing another tool's content.
LLM-backed operations follow the configured backend routing. Errors stay compact
with expandable diagnostics. No new processing engine or network dependency is added.

The tools browser smoke verifies request fields and results with mocked responses.
Settings > Audio tools exposes the existing app-managed media bundle installer,
status/progress, system-copy selection, restore, and yt-dlp update/restore actions.
Downloads start only through an explicit action. Custom executable selection still
needs the Electron native path-authorization bridge.

The existing checksummed installer successfully installed ffprobe in the development
app data directory. A real probe then read two streams and a four-second duration
from an MP4 fixture. No system-wide binary or application version was changed.

Custom FFmpeg/FFprobe executables can be selected from Media tools in the desktop app. The native picker validates the selected executable with `-version`, then issues the same one-use path capability used by Tauri in the backend-advertised data directory. Cancelling leaves the current tool unchanged. Browser-only sessions do not expose the native picker.

The live Windows conversion smoke now exercises the complete Tools > Convert path with the selected
Faster-Whisper and OmniVoice engines: upload, ASR, saved-profile conversion, returned waveform and
Vidstack playback-clock advancement. The fixture uses an existing clone profile and does not change
the user's engine selections.

Tools > Convert lists saved Voice Design profiles as well as clones with reference
audio or a locked take. Search by the saved profile name, select it, and upload or
record the source clip. Designed voices use their saved sample and instructions;
legacy designs without a sample fall back to their saved instructions and seed.
A ready TTS engine with cloning support is still required. Conversion transcribes
the source and synthesizes its text in the selected voice. Match duration adjusts
the overall length; it does not preserve the original performance's pitch, pauses,
or expression.

Media-tool installation retries temporary filesystem locks for up to four seconds,
including Windows locks after the executable probe. It preserves the existing installation in a sibling backup
until publication succeeds and attempts to restore it if publication fails. If
rollback also fails, the previous installation remains in `.media-backup-*/previous`;
the error includes that recovery path. Persistent locks surface their original
error; no system binaries or user media are deleted. The same behavior applies to
yt-dlp overlay updates, and restoring the tested version reports failed cleanup.
Dubbing background preservation and long export filter graphs support both legacy
`-filter_complex_script` and modern FFmpeg `-/filter_complex` file arguments.
If FFmpeg rejects the legacy option before processing, VoiceStudio retries once
with the modern spelling; filter contents stay in a file to avoid Windows command
line limits. Actual decoding/filter errors are reported without retrying.


Tools > Convert uses one form for **Speech** and **Singing**. Source upload,
record/clear, required target voice, selected-profile summary, duration matching,
and Convert are identical in both modes. Switching modes retains inputs and
clears obsolete results. The model card identifies the engine for the selected
mode; a sole or environment-pinned engine is informational, not a fake selector.

Speech uses the active cloning-capable TTS engine after ASR transcription.
Singing uses the opt-in [Seed-VC SVC adapter](engines/seed-vc.md), conditioned on
source pitch and the saved profile's reference audio. It never calls the speech
ASR/TTS pipeline. Profiles without reference audio remain visible in the common
voice list but cannot run singing conversion until a reference is supplied.

Both modes explicitly require a source, an available compatible model, and a
selected target voice. Missing target selection is explained inline. A sole
profile is confirmed by a button, then displayed in a checked summary; multiple
profiles use the shared searchable voice picker. The Portuguese clear-source
button reads **Limpar**.

`GET /convert/models` reports local singing readiness without loading weights
or accessing the network. `POST /convert` accepts `mode=speech` (default) and
`mode=singing`; unknown modes return 422. An unconfigured singing adapter returns
409 `singing_engine_unavailable`. Conversion results share provenance marking,
WAV persistence and history; singing has no fabricated transcript.

Conversion now polls its content-free job status while processing, showing the
current phase and an elapsed clock in both modes. Seed-VC supplies real completed
solver steps, with an explicitly stage-scoped percentage and measured ETA. Speech
engines without step reporting show a phase and clock only. Cancellation is shown
as requested until the backend confirms that the request and workers stopped;
a failed status lookup never becomes a success receipt. Seed-VC CPU parallelism
is limited to three threads by default and the child runs at reduced priority.

Completed speech and singing conversions show their full internal output path,
with **Show in folder** and the shared native **Save As…** action. Save As lets
users choose a name and folder; its successful destination stays visible when
navigating away and back in the same session. Cancelling or failing the dialog
keeps the internal result and does not claim an export. The initial form explains
that results are stored in the app history (and subject to its retention policy);
exporting creates a separate copy. Failed/cancelled conversions have no final
result or export controls. The API returns `output_path` alongside `audio_url`.

On explicitly validated Windows installations, singing can use the hybrid
DirectML adapter. The model label includes DirectML + CPU and the configured
GPU name. This does not claim every stage runs on GPU; the same real-step
progress and cancellation flow applies. Default CPU behavior is unchanged.

Conversion now offers per-run GPU/CPU controls for adapters that can honor them
(native VoxCPM2 and prepared Seed-VC). Choices never change the global model or
device preferences. GPU singing remains hybrid DirectML + CPU; speech GPU uses
Vulkan. Other engines keep their existing automatic routing and show unavailable
controls rather than silently pretending to apply a device override.

Before a native conversion starts, choose its output in a Save As dialog. The
initial proposal is the source directory and `<original-stem>_convert.wav` for
both modes. Recorded/browser-only files have no original disk path and start in
Downloads instead. Choosing a path does not create or truncate the destination.
Completion automatically exports there and displays the path. Cancelling the
dialog starts no job; failed exports retain the internal playable result. A
one-use, window-bound main-process token authorizes only the chosen path; the
original source and destinations changed during processing cannot be overwritten.

Planned conversion exports normalize backend audio paths through the same API-prefix helper as manual Save As, before crossing the native download boundary. A failed export retains the completed internal take for retry.

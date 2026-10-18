# Optional Seed-VC singing conversion

This local adapter runs upstream [Seed-VC](https://github.com/Plachtaa/seed-vc)
in a separate Python environment. Use the F0-conditioned 44.1 kHz SVC model,
not the ordinary speech VC checkpoint. Source pitch is kept with zero semitone
shift and automatic pitch adjustment disabled. Reference audio supplies timbre;
this does not train a new model. Keep clean vocals and a clean own-voice reference.

## Explicit setup

Clone the upstream repository and install its inference dependencies into a
separate environment; never replace VoiceStudio's Torch installation. The tested
Windows environment uses Python 3.11, CPU Torch/torchaudio 2.4.0, torchvision
0.19.0, NumPy 1.26.4, transformers 4.46.3 and huggingface-hub 0.36.0.
Install the remaining inference dependencies from
`backend/engines/seed_vc/requirements-cpu.txt` using the isolated interpreter;
Torch CPU wheel installation precedes this dependency step.
Run `backend/engines/seed_vc/runner.py --root <absolute-seed-vc-root> --prepare`
with that environment's Python. This explicit action downloads the Seed-VC SVC,
RMVPE, CAMPPlus, BigVGAN and Whisper encoder weights and creates the local
`.voicestudio-ready.json` readiness manifest after all models load successfully.
The Whisper encoder extracts audio features; it does not transcribe the lyrics.

Set `OMNIVOICE_SEED_VC_ROOT` and `OMNIVOICE_SEED_VC_PYTHON` to the absolute
checkout and isolated interpreter paths in the app launch environment. Without
these opt-ins the adapter is unavailable. The local Vulkan launcher sets these
alongside the existing native VoxCPM2 speech settings. It leaves global settings
and packaged installations unchanged.

## Execution and limits

The default adapter uses CPU float32. Upstream Seed-VC does not provide Vulkan.
An explicit Windows DirectML opt-in can offload Whisper encoding and the
diffusion estimator while keeping audio DSP, RMVPE, CAMPPlus, length regulation
and BigVGAN on CPU. This is hybrid acceleration, not an entirely GPU pipeline.
Speech continues using the separately configured Vulkan engine. Start with a short excerpt before
processing an entire song on CPU. Inference uses 30 diffusion steps and runs
fully offline against prepared weights. Nothing downloads on conversion.

Jobs use an owned child process and the guarded execution pool. HTTP disconnect or task cancellation
terminates the child; temporary source/reference files remain leased until the
worker exits. There is no fixed 30-minute whole-song limit. The owned child is stopped and reaped if no new engine stage or solver step is observed for 30 minutes. A long conversion with real progress can continue beyond that time; the generic TTS compute-timeout message does not apply. Failures leave diagnostics at
`<data-dir>/seed-vc/last-run.log`, without deleting source media or profiles.
Optional duration matching uses the same pitch-preserving duration adjustment
as Speech. Final audio passes the synthetic-provenance marking choke point,
then the shared WAV/history persistence flow.

Upstream code is GPL-3.0; retain its license and check each downloaded model's
license before redistributing it. This is a local integration, not a claim that
Seed-VC is bundled in official VoiceStudio releases.

## Progress and CPU responsiveness

The adapter reports structured phase events and counts actual completed Euler
iterations. The UI labels percentages as progress of the current diffusion
stage/chunk. The chunk counter includes the real total (for example, 5/10), computed from source/reference conditioning frames and the upstream overlapping windows. It never extrapolates a whole-file percentage from a spinner.
ETA is available only after three measured solver steps and is scoped to that
stage. Loading, analysis, waveform generation, validation, duration matching,
provenance marking and saving show their phase and elapsed time without a
fabricated percentage or remaining time.

`OMNIVOICE_SEED_VC_THREADS` defaults to 3 and is clamped to the host's logical CPU
count. The child also constrains OpenMP/MKL/OpenBLAS/NumExpr and uses one Torch
interop thread. Windows launches it at below-normal priority; POSIX lowers its
priority with niceness. This controls thread parallelism and scheduling, not a
promised percentage of total CPU usage or a RAM cap.

CPU Whisper loads directly in float32 with eager attention. All models use the
Torch math attention implementation on CPU: this avoids non-finite values seen
with fused attention in the tested Torch 2.4 CPU build. Encoder, diffusion and
vocoder outputs are checked so an invalid result fails early instead of wasting
all 30 steps and publishing corrupt audio.

Each conversion can carry a UUID `job_id`. `GET /convert/jobs/{job_id}` exposes
content-free state and timing; `POST /convert/jobs/{job_id}/cancel` requests a
stop. A receipt remains `cancelling` until the request and all tracked workers
retire. A running sidecar is terminated and reaped before the worker retires.
Non-killable speech workers remain pending until they return. Cancelling before
multipart parsing completes reserves the UUID, blocking late execution.
Completed records are bounded and expire; they are not a durable task history.

## Experimental Windows DirectML opt-in

Use a separate environment with `requirements-directml.txt` (Torch/torchaudio
2.4.1, torchvision 0.19.1, torch-directml 0.2.5.dev240914). Never install these
packages over the working CPU environment or VoiceStudio's application venv.
The original CPU interpreter remains usable by clearing
`OMNIVOICE_SEED_VC_DEVICE` or explicitly setting it to `cpu`.

Validate a short real conversion before enabling this path. The adapter requires
`<seed-vc-root>/.voicestudio-directml-ready.json` containing the absolute validated
`python` path, `gpu_index`, `gpu_name`, and `verified_components` set to
`["whisper", "diffusion"]`. Set `OMNIVOICE_SEED_VC_PYTHON` to that interpreter and
`OMNIVOICE_SEED_VC_DEVICE=directml`. Readiness checks only local files; the child
checks the actual adapter index/name at each run and fails if the GPU changed.
A missing validation record never silently selects the GPU or retries on CPU.

The hybrid boundary keeps CPU tensors for upstream audio processing, moving only
neural-module inputs and results across devices. This handles upstream inference
mode and unregistered Transformer caches without modifying the Seed-VC checkout.
DirectML execution is recorded in `seed-vc/last-run.log`, including the actual GPU
name and explicit GPU/CPU components. CPU thread limits and owned-process
cancellation apply to both compute choices.

The native DirectML attention operator exhausted memory with the tested full
reference. The opt-in uses exact, noncausal attention as query blocks of 128,
with all keys/values retained, explicit matmul/softmax and correct masks; it avoids
the problematic native operator rather than truncating reference data. Numerical
comparisons cover this decomposition. BigVGAN stays on CPU because its grouped
transposed convolution failed in the tested DirectML runtime. Memory needs still
increase with source/reference lengths; short tests do not guarantee whole-song
capacity or fixed speedups.

Validated on the local RX 6600M: a 6-second source with the full 11.8-second
reference completed 30 steps in 166.6 seconds (including process/model loading).
The output is 44.1 kHz, finite, non-silent and unclipped. This is a technical
validation; voice similarity still requires listening. In the pinned DirectML
build, `nan_to_num` in attention falls back to CPU; the execution log lists that
cleanup alongside other CPU work. Small component checks showed relative RMSE
below 0.001% against CPU; their speedups are not a whole-song estimate.

Conversion may explicitly request CPU or GPU per run. CPU bypasses the DirectML
validation record and keeps all neural components on CPU using the configured
isolated interpreter; GPU requires the validated DirectML runtime. The request
never rewrites process environment variables or the default launcher choice.

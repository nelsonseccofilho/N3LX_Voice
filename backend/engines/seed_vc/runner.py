"""Seed-VC SVC runner, executed only by its isolated Python environment."""
import argparse
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--prepare', action='store_true')
parser.add_argument('--device', choices=('cpu', 'directml'), default='cpu')
parser.add_argument('--device-index', type=int, default=0)
parser.add_argument('--device-name')
parser.add_argument('--source')
parser.add_argument('--reference')
parser.add_argument('--output')
parser.add_argument('--steps', type=int, default=30)
parser.add_argument('--cpu-threads', type=int, default=3)
parser.add_argument('--progress-path')
args = parser.parse_args()
if args.prepare and args.device != 'cpu':
    parser.error('Prepare weights with CPU; DirectML validation is a separate explicit action')
if not 1 <= args.cpu_threads <= (os.cpu_count() or 1):
    parser.error('CPU threads must be between 1 and the available logical CPUs')
for key in ('OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS'):
    os.environ[key] = str(args.cpu_threads)
if os.name == 'posix':
    os.nice(5)
from progress import Reporter
reporter = Reporter(args.progress_path)
reporter.emit('loading')
root = Path(args.root).resolve()
os.chdir(root)
sys.path.insert(0, str(root))
if not args.prepare:
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import torch
import inference

torch.set_num_threads(args.cpu_threads)
torch.set_num_interop_threads(1)
inference.device = torch.device('cpu')
# CPU Whisper uses float32 eager attention rather than upstream's fp16
# default and the fused attention path that returned NaNs on this host.
from transformers import WhisperModel
_original_whisper_load = WhisperModel.from_pretrained

def cpu_whisper_load(*values, **options):
    options['torch_dtype'] = torch.float32
    options['attn_implementation'] = 'eager'
    return _original_whisper_load(*values, **options)

WhisperModel.from_pretrained = cpu_whisper_load
original_load = inference.load_models

def load_cpu_models(options):
    models = original_load(options)
    # Upstream loads Whisper in fp16 even on CPU. Keep the encoder float32
    # alongside the other CPU models; do not change the upstream checkout.
    semantic = models[1]
    for cell in semantic.__closure__ or ():
        if isinstance(cell.cell_contents, torch.nn.Module):
            cell.cell_contents.float()
    from modules import flow_matching
    flow_matching.tqdm = reporter.steps
    models[0].length_regulator.register_forward_hook(reporter.conditioning)

    def finite_output(module, inputs, output):
        if not torch.isfinite(output).all():
            raise RuntimeError('Seed-VC diffusion produced non-finite values; conversion stopped before exporting invalid audio')
    models[0].cfm.estimator.register_forward_hook(finite_output)
    def finite_inputs(module, inputs):
        for index, value in enumerate(inputs):
            if isinstance(value, torch.Tensor) and not torch.isfinite(value).all():
                raise RuntimeError(f'Seed-VC diffusion input {index} contains non-finite values')
    models[0].cfm.estimator.register_forward_pre_hook(finite_inputs)
    vocoder = models[3]
    def vocal_waveform(mel):
        reporter.emit('vocoder')
        if not torch.isfinite(mel).all():
            raise RuntimeError('Seed-VC produced a non-finite mel spectrogram')
        result = vocoder(mel)
        if not torch.isfinite(result).all():
            raise RuntimeError('Seed-VC vocoder produced non-finite audio')
        return result
    def analyze(waves):
        reporter.emit('analyzing')
        result = semantic(waves)
        if not torch.isfinite(result).all():
            raise RuntimeError('Seed-VC audio encoder produced non-finite values')
        return result
    if args.device == 'directml':
        from directml import enable_directml
        enable_directml(models, device_index=args.device_index, expected_name=args.device_name)
    reporter.emit('analyzing')
    return (models[0], analyze, models[2], vocal_waveform, *models[4:])

inference.load_models = load_cpu_models
options = argparse.Namespace(
    f0_condition=True, auto_f0_adjust=False, semi_tone_shift=0,
    checkpoint=None, config=None, fp16=False, diffusion_steps=args.steps,
    length_adjust=1.0, inference_cfg_rate=0.7,
    source=args.source, target=args.reference, output=args.output,
)
if args.prepare:
    load_cpu_models(options)
    files = [str(p.relative_to(root)) for p in (root/'checkpoints').rglob('*')
             if p.is_file() and not p.name.endswith(('.lock', '.incomplete')) and p.stat().st_size > 0]
    manifest = {'engine':'seed-vc-svc', 'sample_rate':44100, 'device':'cpu', 'files':files}
    (root/'.voicestudio-ready.json').write_text(json.dumps(manifest),encoding='utf-8')
    print('Seed-VC SVC prepared for offline CPU inference', flush=True)
else:
    if not args.source or not args.reference or not args.output:
        parser.error('source, reference and output are required')
    # CPU fused SDPA in this Torch build can return NaNs. Use the supported
    # float32 math attention path for all models in this isolated CPU process.
    with torch.nn.attention.sdpa_kernel(torch.nn.attention.SDPBackend.MATH):
        inference.main(options)
    reporter.emit('validating')

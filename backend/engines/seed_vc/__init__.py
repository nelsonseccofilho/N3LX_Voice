"""Opt-in local Seed-VC SVC in a separate process; never downloads on use."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT_ENV = 'OMNIVOICE_SEED_VC_ROOT'
PYTHON_ENV = 'OMNIVOICE_SEED_VC_PYTHON'
RUNNER = Path(__file__).with_name('runner.py')

from .progress import ProgressWatchdog, SingingProgressTimeout

def configured_paths():
    root = Path(os.environ.get(ROOT_ENV,''))
    python = Path(os.environ.get(PYTHON_ENV,''))
    if not root.is_absolute() or not (root/'inference.py').is_file():
        raise RuntimeError('Seed-VC source directory is not configured')
    if not python.is_absolute() or not python.is_file():
        raise RuntimeError('Seed-VC isolated Python is not configured')
    manifest = json.loads((root/'.voicestudio-ready.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or manifest.get('engine') != 'seed-vc-svc' or not isinstance(manifest.get('files'), list) or not manifest['files']:
        raise RuntimeError('Seed-VC singing weights are not prepared')
    for name in manifest['files']:
        if not isinstance(name, str):
            raise RuntimeError('Seed-VC singing manifest is invalid')
        target = (root/name).resolve()
        if not target.is_relative_to(root.resolve()) or not target.is_file() or target.stat().st_size == 0:
            raise RuntimeError('Seed-VC singing weight is missing')
    return root,python

def cpu_threads():
    try:
        requested = int(os.environ.get('OMNIVOICE_SEED_VC_THREADS', '3'))
    except ValueError:
        requested = 3
    return min(os.cpu_count() or 1, max(1, requested))


def runtime_config(root, python, compute="auto"):
    device = os.environ.get('OMNIVOICE_SEED_VC_DEVICE', 'cpu').lower()
    if compute != 'auto':
        device = 'cpu' if compute == 'cpu' else 'directml'
    if device == 'cpu':
        return {'device': 'cpu'}
    if device != 'directml' or os.name != 'nt':
        raise RuntimeError('Unsupported Seed-VC compute device')
    proof = json.loads((root/'.voicestudio-directml-ready.json').read_text(encoding='utf-8'))
    if not isinstance(proof, dict) or not isinstance(proof.get('python'), str):
        raise RuntimeError('DirectML validation record is invalid')
    if os.path.normcase(proof['python']) != os.path.normcase(str(python.resolve())):
        raise RuntimeError('DirectML validation belongs to a different Python environment')
    if (type(proof.get('gpu_index')) is not int or proof['gpu_index'] < 0
            or not isinstance(proof.get('gpu_name'), str) or not proof['gpu_name'].strip()
            or proof.get('verified_components') != ['whisper', 'diffusion']):
        raise RuntimeError('DirectML singing runtime has not been validated')
    return {'device': device, 'gpu_index': proof['gpu_index'], 'gpu_name': proof['gpu_name']}


def status():
    runtime = {'device': os.environ.get('OMNIVOICE_SEED_VC_DEVICE', 'cpu').lower()}
    reason = None
    try:
        root, python = configured_paths()
        runtime = runtime_config(root, python)
        ready = True
    except (OSError, ValueError, RuntimeError, TypeError) as error:
        ready = False
        reason = str(error)
    label = 'CPU' if runtime['device'] == 'cpu' else 'DirectML + CPU'
    if runtime.get('gpu_name'):
        label += ' — ' + runtime['gpu_name']
    choices = []
    try:
        configured_paths()
        choices.append('cpu')
    except (OSError, ValueError, RuntimeError, TypeError):
        pass
    try:
        root, python = configured_paths()
        runtime_config(root, python, 'gpu')
        choices.append('gpu')
    except (OSError, ValueError, RuntimeError, TypeError):
        pass
    return {'compute_options':choices, 'id':'seed-vc-svc','display_name':f'Seed-VC SVC (44.1 kHz, {label})',
            'available':ready, **runtime, 'sample_rate':44100,'cpu_threads':cpu_threads(), 'reason':reason}


def convert(source, reference, *, progress=None, compute="auto"):
    from core.config import DATA_DIR
    from core.contained_subprocess import spawn_owned
    from services.inference_cancellation import current_cancellation
    import numpy as np
    import soundfile as sf
    import torch
    root,python = configured_paths()
    runtime = runtime_config(root, python, compute)
    directory = Path(DATA_DIR)/'seed-vc'
    directory.mkdir(parents=True,exist_ok=True)
    cancellation = current_cancellation()
    with tempfile.TemporaryDirectory(prefix='convert-',dir=directory) as work:
        work = Path(work)
        copied_reference = work/'reference.wav'
        shutil.copyfile(reference,copied_reference)
        log_path = directory/'last-run.log'
        env = dict(os.environ,HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',PYTHONIOENCODING='utf-8')
        progress_path = work/'progress.jsonl'
        progress_position = 0
        pending = ''
        watchdog = ProgressWatchdog()
        def read_progress():
            nonlocal progress_position, pending
            if not progress_path.exists():
                return
            with progress_path.open(encoding='utf-8') as stream:
                stream.seek(progress_position)
                pending += stream.read()
                progress_position = stream.tell()
            lines = pending.split('\n')
            pending = lines.pop()
            for line in lines:
                try:
                    message = json.loads(line)
                    if message.get('stage') in {'loading','analyzing','diffusion','vocoder','validating'}:
                        watchdog.observe(message)
                        if progress is not None:
                            progress(**message)
                except (ValueError, TypeError):
                    continue
        env.update({key:str(cpu_threads()) for key in ('OMP_NUM_THREADS','MKL_NUM_THREADS','OPENBLAS_NUM_THREADS','NUMEXPR_NUM_THREADS')})
        argv = [str(python),str(RUNNER),'--root',str(root),'--source',str(source),
                '--reference',str(copied_reference),'--output',str(work),
                '--cpu-threads',str(cpu_threads()),'--progress-path',str(progress_path),'--steps','30']
        argv += ['--device', runtime['device']]
        if runtime['device'] == 'directml':
            argv += ['--device-index',str(runtime['gpu_index']),'--device-name',runtime['gpu_name']]
        proc = None
        try:
            with log_path.open('wb') as log:
                proc = spawn_owned(argv,cwd=str(root),env=env,stdin=subprocess.DEVNULL,
                    stdout=log,stderr=subprocess.STDOUT,
                    creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.BELOW_NORMAL_PRIORITY_CLASS) if os.name=='nt' else 0)
            while proc.poll() is None:
                read_progress()
                if cancellation is not None and cancellation.cancelled.is_set():
                    raise RuntimeError('Singing conversion cancelled')
                watchdog.check()
                time.sleep(0.2)
            read_progress()
            if proc.returncode:
                raise RuntimeError('Seed-VC singing conversion failed; inspect seed-vc/last-run.log')
            outputs = list(work.glob('vc_*.wav'))
            if len(outputs)!=1:
                raise RuntimeError('Seed-VC did not produce one output recording')
            samples,rate = sf.read(outputs[0],dtype='float32',always_2d=True)
            if rate!=44100 or not len(samples) or not np.isfinite(samples).all():
                raise RuntimeError(f'Seed-VC returned invalid singing audio (rate={rate}, samples={len(samples)}, nonfinite={int((~np.isfinite(samples)).sum())})')
            return torch.from_numpy(samples.mean(axis=1).copy()).unsqueeze(0),rate
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)

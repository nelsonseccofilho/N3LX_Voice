import io
import json
from types import SimpleNamespace

import numpy as np
import pytest
import soundfile as sf

from services import tts_backend


def test_native_voxcpm_is_explicit_opt_in(monkeypatch):
    monkeypatch.setenv('OMNIVOICE_VOXCPM2_NATIVE_BIN', '/configured/native/server')
    result = tts_backend._effective_backend_class('voxcpm2', tts_backend.VoxCPM2Backend, 'cpu')
    assert result.__name__ == 'VoxCPM2NativeBackend'


def test_default_adapter_is_unchanged(monkeypatch):
    monkeypatch.delenv('OMNIVOICE_VOXCPM2_NATIVE_BIN', raising=False)
    monkeypatch.setattr(tts_backend, '_OWN_VENV_SIDECARS', {})
    assert tts_backend._effective_backend_class('voxcpm2', tts_backend.VoxCPM2Backend, 'cpu') is tts_backend.VoxCPM2Backend


def test_native_controls_and_unicode_use_existing_voxcpm_mapping():
    from engines.voxcpm2_native import speech_payload

    payload = speech_payload('Olá, Brasil!', description='Brazilian male voice', num_step=12, seed=7)
    assert payload['input'] == '(Brazilian male voice)Olá, Brasil!'
    assert payload['inference_timesteps'] == 12
    assert payload['seed'] == 7
    assert json.loads(json.dumps(payload, ensure_ascii=False).encode('utf-8')) == payload


def test_reference_is_pcm_and_transcript_preserved(tmp_path):
    from engines.voxcpm2_native import speech_payload
    import base64

    path = tmp_path / 'reference.wav'
    sf.write(path, np.zeros(1600, dtype=np.float32), 16000)
    payload = speech_payload('Olá!', ref_audio=str(path), ref_text='Bom dia.')
    assert payload['prompt_text'] == 'Bom dia.'
    with sf.SoundFile(io.BytesIO(base64.b64decode(payload['reference_audio']))) as audio:
        assert audio.samplerate == 16000 and audio.subtype == 'PCM_16'


def test_remote_reference_is_rejected():
    from engines.voxcpm2_native import speech_payload

    with pytest.raises(ValueError, match='local file'):
        speech_payload('Olá', ref_audio='https://example.com/voice.wav')


def test_cpu_fallback_is_rejected():
    from engines.voxcpm2_native import verified_backend

    with pytest.raises(RuntimeError, match='requires Vulkan'):
        verified_backend('VoxCPM2Runtime: custom component backend=CPU')
    assert verified_backend('0.1 I VoxCPM2Runtime: custom component backend=Vulkan0') == 'Vulkan0'


def test_no_acceleration_claim_before_load_or_after_unload():
    from engines.voxcpm2_native import VoxCPM2NativeBackend

    backend = VoxCPM2NativeBackend()
    assert backend.runtime_compute_profile(None)['runtime_device_verified'] is False
    backend._proc = SimpleNamespace(poll=lambda: None)
    backend._backend = 'Vulkan0'
    assert backend.runtime_compute_profile(None)['routing_status'] == 'accelerated'
    backend._proc = None
    backend.unload()
    backend.unload()
    assert backend.runtime_compute_profile(None)['runtime_device_verified'] is False


def test_refuse_unowned_loopback_listener(monkeypatch):
    from engines.voxcpm2_native import VoxCPM2NativeBackend
    import psutil

    backend = VoxCPM2NativeBackend()
    backend._proc = SimpleNamespace(pid=123, poll=lambda: None)
    backend._port = 12345
    monkeypatch.setattr(psutil, 'Process', lambda pid: SimpleNamespace(net_connections=lambda **kw: []))
    with pytest.raises(RuntimeError, match='not owned'):
        backend._owns_listener()
    backend._proc = None

def test_setup_accepts_selected_native_weights_without_claiming_hub_cache(monkeypatch):
    from api.routers.setup import wizard, models

    monkeypatch.setattr(wizard, 'REQUIRED_MODELS', [('tts/repo', 'TTS'), ('asr/repo', 'ASR')])
    monkeypatch.setattr(models, 'KNOWN_MODELS', [{'repo_id':'tts/repo','role':'TTS'}, {'repo_id':'asr/repo','role':'ASR'}])
    monkeypatch.setattr(wizard, 'is_cached', lambda rid: False)
    monkeypatch.setattr(tts_backend, 'active_backend_id', lambda: 'native-test')
    monkeypatch.setattr(tts_backend, 'get_backend_class', lambda bid: SimpleNamespace(installed_model_files_ready=lambda: True))
    result = wizard.setup_status()
    assert result['missing'] == [{'repo_id':'asr/repo','label':'ASR'}]
    assert result['models_ready'] is False


def test_setup_still_requires_models_without_native_readiness(monkeypatch):
    from api.routers.setup import wizard

    monkeypatch.setattr(wizard, 'REQUIRED_MODELS', [('tts/repo', 'TTS')])
    monkeypatch.setattr(wizard, 'is_cached', lambda rid: False)
    monkeypatch.setattr(tts_backend, 'active_backend_id', lambda: 'native-test')
    monkeypatch.setattr(tts_backend, 'get_backend_class', lambda bid: SimpleNamespace(installed_model_files_ready=lambda: False))
    assert wizard.setup_status()['models_ready'] is False


def test_explicit_cpu_is_verified_without_changing_gpu_default():
    from engines.voxcpm2_native import verified_backend, VoxCPM2NativeBackend
    assert verified_backend('custom component backend=CPU',expected='cpu') == 'CPU'
    with pytest.raises(RuntimeError): verified_backend('custom component backend=Vulkan0',expected='cpu')
    backend=VoxCPM2NativeBackend()
    assert backend._conversion_compute.get() == 'gpu'
    with backend.conversion_device('cpu'): assert backend._conversion_compute.get() == 'cpu'
    assert backend._conversion_compute.get() == 'gpu'

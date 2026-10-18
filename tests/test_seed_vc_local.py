"""Local readiness is explicit and never downloads during a status check."""
import json
from pathlib import Path
from engines import seed_vc


def test_unconfigured_is_unavailable(monkeypatch):
    monkeypatch.delenv(seed_vc.ROOT_ENV, raising=False)
    monkeypatch.delenv(seed_vc.PYTHON_ENV, raising=False)
    assert seed_vc.status()["available"] is False
    assert seed_vc.status()["device"] == "cpu"


def _prepared(tmp_path, monkeypatch):
    root = tmp_path / "seed"
    root.mkdir()
    (root / "inference.py").touch()
    interpreter = tmp_path / "python"
    interpreter.touch()
    weight = root / "checkpoints" / "weight.pth"
    weight.parent.mkdir()
    weight.write_bytes(b"prepared test weight")
    (root / ".voicestudio-ready.json").write_text(json.dumps({
        "engine": "seed-vc-svc", "files": ["checkpoints/weight.pth"],
    }))
    monkeypatch.setenv(seed_vc.ROOT_ENV, str(root))
    monkeypatch.setenv(seed_vc.PYTHON_ENV, str(interpreter))
    return root, weight


def test_readiness_checks_prepared_files(tmp_path, monkeypatch):
    _, weight = _prepared(tmp_path, monkeypatch)
    assert seed_vc.status()["available"] is True
    weight.unlink()
    assert seed_vc.status()["available"] is False


def test_manifest_cannot_escape_root(tmp_path, monkeypatch):
    root, _ = _prepared(tmp_path, monkeypatch)
    (root / ".voicestudio-ready.json").write_text(json.dumps({
        "engine": "seed-vc-svc", "files": ["../python"],
    }))
    assert seed_vc.status()["available"] is False


def test_malformed_manifest_is_unavailable(tmp_path, monkeypatch):
    root, _ = _prepared(tmp_path, monkeypatch)
    (root / ".voicestudio-ready.json").write_text("invalid")
    assert seed_vc.status()["available"] is False


def test_conversion_uses_owned_offline_process_and_cleans_work(tmp_path, monkeypatch):
    import numpy as np
    import soundfile as sf
    from core import config, contained_subprocess
    _prepared(tmp_path, monkeypatch)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    reference = tmp_path / "reference.wav"
    source = tmp_path / "source.wav"
    sf.write(reference, np.zeros(4410), 44100)
    sf.write(source, np.zeros(4410), 44100)
    observed = {}
    class Completed:
        returncode = 0
        def poll(self): return 0
    def spawn(argv, **kwargs):
        observed.update(argv=argv, **kwargs)
        output = Path(argv[argv.index("--output") + 1])
        copied = Path(argv[argv.index("--reference") + 1])
        assert copied != reference and copied.read_bytes() == reference.read_bytes()
        sf.write(output / "vc_test.wav", np.zeros(4410), 44100)
        observed["work"] = output
        return Completed()
    monkeypatch.setattr(contained_subprocess, "spawn_owned", spawn)
    samples, rate = seed_vc.convert(source, reference)
    assert rate == 44100 and samples.shape == (1, 4410)
    assert observed["env"]["HF_HUB_OFFLINE"] == "1"
    assert observed["env"]["TRANSFORMERS_OFFLINE"] == "1"
    assert observed["argv"][observed["argv"].index("--steps")+1] == "30"
    assert observed["argv"][observed["argv"].index("--device")+1] == "cpu"
    assert not observed["work"].exists()
    assert reference.is_file() and source.is_file()


def test_cancellation_terminates_owned_process_before_temp_cleanup(tmp_path, monkeypatch):
    import pytest
    from core import config, contained_subprocess
    from services import inference_cancellation
    _prepared(tmp_path, monkeypatch)
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    reference = tmp_path / "reference.wav"
    reference.write_bytes(b"own voice")
    scope = inference_cancellation.InferenceCancellation()
    scope.cancel()
    monkeypatch.setattr(inference_cancellation, "current_cancellation", lambda: scope)
    class Running:
        returncode = None
        stopped = False
        def poll(self): return None
        def terminate(self):
            assert self.work.exists()
            self.stopped = True
        def wait(self, **kwargs): return 0
    proc = Running()
    def spawn(argv, **kwargs):
        proc.work = Path(argv[argv.index("--output") + 1])
        return proc
    monkeypatch.setattr(contained_subprocess, "spawn_owned", spawn)
    with pytest.raises(RuntimeError, match="cancelled"):
        seed_vc.convert(tmp_path / "source.wav", reference)
    assert proc.stopped and not proc.work.exists()
    assert reference.read_bytes() == b"own voice"


def test_cpu_threads_are_bounded(monkeypatch):
    monkeypatch.setattr(seed_vc.os, "cpu_count", lambda: 12)
    monkeypatch.delenv("OMNIVOICE_SEED_VC_THREADS", raising=False)
    assert seed_vc.cpu_threads() == 3
    monkeypatch.setenv("OMNIVOICE_SEED_VC_THREADS", "99")
    assert seed_vc.cpu_threads() == 12
    monkeypatch.setenv("OMNIVOICE_SEED_VC_THREADS", "invalid")
    assert seed_vc.cpu_threads() == 3


def test_directml_requires_explicit_verified_runtime(tmp_path, monkeypatch):
    root, _ = _prepared(tmp_path, monkeypatch)
    monkeypatch.setenv('OMNIVOICE_SEED_VC_DEVICE', 'directml')
    assert seed_vc.status()['available'] is False
    proof = {
        'python': str(Path(seed_vc.os.environ[seed_vc.PYTHON_ENV]).resolve()),
        'gpu_index': 0, 'gpu_name': 'AMD Radeon RX 6600M',
        'verified_components': ['whisper', 'diffusion'],
    }
    (root/'.voicestudio-directml-ready.json').write_text(json.dumps(proof))
    if seed_vc.os.name != 'nt':
        assert seed_vc.status()['available'] is False
        return
    state = seed_vc.status()
    assert state['available'] and state['device'] == 'directml'
    assert state['gpu_name'] == 'AMD Radeon RX 6600M'
    assert 'CPU' in state['display_name'] and 'DirectML' in state['display_name']
    proof['python'] = 'wrong-interpreter'
    (root/'.voicestudio-directml-ready.json').write_text(json.dumps(proof))
    assert seed_vc.status()['available'] is False


def test_invalid_device_never_silently_falls_back(tmp_path, monkeypatch):
    _prepared(tmp_path, monkeypatch)
    monkeypatch.setenv('OMNIVOICE_SEED_VC_DEVICE', 'cuda')
    assert seed_vc.status()['available'] is False


def test_acceleration_boundary_preserves_cpu_contract_and_inference_tensors():
    import torch
    from dataclasses import dataclass
    from engines.seed_vc.directml import offload_module
    @dataclass
    class Output:
        last_hidden_state: object
    class Encoder(torch.nn.Module):
        def forward(self, x, *, scale=1):
            assert not torch.is_inference(x)
            return Output(x * scale)
    model = Encoder()
    offload_module(model, torch.device('cpu'))
    with torch.inference_mode():
        value = torch.ones(2,3)
        result = model(value, scale=2)
    assert torch.equal(result.last_hidden_state, torch.full((2,3),2.))
    assert result.last_hidden_state.device.type == 'cpu'
    assert not torch.is_inference(result.last_hidden_state)


def test_chunked_attention_preserves_full_keys_and_masks():
    import torch
    from engines.seed_vc.directml import chunked_attention
    from torch.nn.functional import scaled_dot_product_attention
    torch.manual_seed(42)
    q, k, v = torch.randn(2,4,53,16), torch.randn(2,4,61,16), torch.randn(2,4,61,16)
    for rows in (1,53):
        mask = torch.rand(2,1,rows,61) > 0.2
        mask[0,:,0,:] = False
        with torch.nn.attention.sdpa_kernel(torch.nn.attention.SDPBackend.MATH):
            expected = scaled_dot_product_attention(q,k,v,attn_mask=mask)
            actual = chunked_attention(q,k,v,mask,chunk_size=7)
        torch.testing.assert_close(actual,expected,atol=1e-6,rtol=1e-5)


def test_cpu_selection_is_per_conversion_and_does_not_change_default(tmp_path, monkeypatch):
    root,_=_prepared(tmp_path,monkeypatch)
    monkeypatch.setenv('OMNIVOICE_SEED_VC_DEVICE','directml')
    interpreter=Path(seed_vc.os.environ[seed_vc.PYTHON_ENV])
    assert seed_vc.runtime_config(root,interpreter,'cpu') == {'device':'cpu'}
    assert seed_vc.os.environ['OMNIVOICE_SEED_VC_DEVICE']=='directml'


def test_idle_timeout_reaps_a_real_owned_child_before_returning(tmp_path, monkeypatch):
    import sys
    import pytest
    from core import config, contained_subprocess
    _prepared(tmp_path, monkeypatch)
    monkeypatch.setattr(config, 'DATA_DIR', str(tmp_path / 'data'))
    reference = tmp_path / 'reference.wav'
    reference.write_bytes(b'own voice')
    original_spawn = contained_subprocess.spawn_owned
    observed = {}
    def spawn(argv, **kwargs):
        observed['work'] = Path(argv[argv.index('--output') + 1])
        proc = original_spawn([sys.executable,'-c','import time; time.sleep(600)'], **kwargs)
        observed['proc'] = proc
        return proc
    monkeypatch.setattr(contained_subprocess, 'spawn_owned', spawn)
    monkeypatch.setattr(seed_vc, 'ProgressWatchdog', lambda: seed_vc.progress.ProgressWatchdog(0))
    with pytest.raises(seed_vc.SingingProgressTimeout):
        seed_vc.convert(tmp_path / 'source.wav', reference)
    assert observed['proc'].poll() is not None
    assert not observed['work'].exists()
    assert reference.read_bytes() == b'own voice'

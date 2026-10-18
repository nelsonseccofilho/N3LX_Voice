"""Explicit local VoxCPM2 GGUF adapter for llama.cpp-omni's TTS server.

No downloads. The managed child binds loopback only; Vulkan must be confirmed
in its startup log. The normal PyTorch adapter is unchanged without opt-in.
"""
from __future__ import annotations
from contextlib import contextmanager
from contextvars import ContextVar

import atexit
import base64
import io
import json
import os
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import weakref
from pathlib import Path

from core.contained_subprocess import spawn_owned
from services.tts_backend import VoxCPM2Backend, prepare_voxcpm_reference

BIN_ENV = "OMNIVOICE_VOXCPM2_NATIVE_BIN"
BASE_ENV = "OMNIVOICE_VOXCPM2_NATIVE_BASE"
ACOUSTIC_ENV = "OMNIVOICE_VOXCPM2_NATIVE_ACOUSTIC"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Native speech server redirects are not permitted")


def configured_paths() -> tuple[Path, Path, Path]:
    paths = tuple(Path(os.environ.get(key, "")) for key in (BIN_ENV, BASE_ENV, ACOUSTIC_ENV))
    for key, path in zip((BIN_ENV, BASE_ENV, ACOUSTIC_ENV), paths):
        if not path.is_absolute() or not path.is_file() or path.stat().st_size < 1024:
            raise RuntimeError(f"{key} must name an installed local file")
    if os.name == "nt" and not (paths[0].parent / "ggml-vulkan.dll").is_file():
        raise RuntimeError("Native server requires its Vulkan runtime DLL")
    return paths


def verified_backend(log: str, expected="gpu") -> str:
    for line in log.splitlines():
        if "custom component backend=" in line:
            backend = line.split("custom component backend=", 1)[1].strip()
            if expected == "cpu" and backend == "CPU":
                return backend
            if expected != "cpu" and backend.startswith("Vulkan"):
                return backend
            raise RuntimeError(f"Native VoxCPM2 requires Vulkan; actual backend: {backend}")
    raise RuntimeError("Native VoxCPM2 has not confirmed its compute backend")


def device_name_from_listing(listing: str, backend: str) -> str | None:
    """Match the runtime's exact device identifier, never the OS primary GPU."""
    if not re.fullmatch(r"Vulkan\d+", backend):
        return None
    for line in listing.splitlines():
        prefix = f"{backend}: "
        if line.strip().startswith(prefix):
            name = line.strip()[len(prefix):]
            return re.sub(r" \(\d+ MiB, \d+ MiB free\)$", "", name).strip() or None
    return None


def native_device_name(binary: Path, backend: str) -> str | None:
    # Optional display metadata; probe once per load, never on telemetry polls.
    try:
        result = subprocess.run(
            [str(binary), "--list-devices"], cwd=str(binary.parent),
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=5, check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        return device_name_from_listing(result.stdout + "\n" + result.stderr, backend)
    except (OSError, subprocess.SubprocessError):
        return None


def speech_payload(text: str, **options) -> dict:
    from engines.voxcpm2_subprocess.main import generation_kwargs

    reference = options.get("ref_audio")
    if reference and "://" in str(reference):
        raise ValueError("Reference audio must be a local file")
    mapped = generation_kwargs(text, **options)
    payload = {
        "model": "voxcpm2", "input": mapped["text"], "voice": "default",
        "response_format": "wav", "cfg_value": float(mapped["cfg_value"]),
        "inference_timesteps": mapped["inference_timesteps"],
        "max_steps": min(1800, max(200, len(text) * 3)),
        "seed": int(options.get("seed") if options.get("seed") is not None else 42),
    }
    if reference:
        import soundfile as sf

        samples, rate = sf.read(str(reference), dtype="float32", always_2d=True)
        stream = io.BytesIO()
        sf.write(stream, samples.mean(axis=1), rate, format="WAV", subtype="PCM_16")
        payload["reference_audio"] = base64.b64encode(stream.getvalue()).decode("ascii")
        if mapped.get("prompt_text"):
            payload["prompt_text"] = mapped["prompt_text"]
    return payload


class VoxCPM2NativeBackend(VoxCPM2Backend):
    runs_out_of_process = True
    _is_subprocess_isolated = True
    supports_generation_seed = True
    gpu_compat = ("vulkan", "cpu")
    supports_compute_selection = True
    _conversion_compute = ContextVar("voxcpm2_conversion_compute", default="gpu")

    @contextmanager
    def conversion_device(self, choice):
        token = self._conversion_compute.set("cpu" if choice == "cpu" else "gpu")
        try:
            yield
        finally:
            self._conversion_compute.reset(token)
    _instances = weakref.WeakSet()
    _instances_lock = threading.Lock()

    def __init__(self):
        super().__init__()
        self._proc = None
        self._port = None
        self._backend = None
        self._gpu_name = None
        self._device = None
        self._provider = None
        self._compute_type = None
        self._log_path = None
        self._identity = self.configured_identity()
        self._lock = threading.RLock()
        self._http = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
        with type(self)._instances_lock:
            type(self)._instances.add(self)

    @classmethod
    def configured_identity(cls):
        return json.dumps([os.environ.get(key, "") for key in (BIN_ENV, BASE_ENV, ACOUSTIC_ENV)])

    def built_identity(self):
        return self._identity

    def model_identity(self):
        return "VoxCPM2-GGUF/Q8_0+Acoustic-F16 (local native runtime)"

    @classmethod
    def is_available(cls):
        try:
            configured_paths()
            return True, "ready"
        except (OSError, RuntimeError) as exc:
            return False, str(exc)

    @classmethod
    def installed_model_files_ready(cls):
        return cls.is_available()[0]

    @classmethod
    def runtime_compute_profile(cls, caps):
        # Registry/probe instances must not overwrite the resident instance's
        # evidence. Keep weak references so metadata does not retain models.
        with cls._instances_lock:
            instances = tuple(cls._instances)
        backend = None
        gpu_name = None
        for instance in instances:
            proc = instance._proc
            if proc is not None and proc.poll() is None and instance._backend:
                backend = instance._backend
                gpu_name = instance._gpu_name
                break
        live = backend is not None
        return {
            "gpu_compat": cls.gpu_compat, "min_vram_gb": 0.0,
            "effective_device": "cpu" if backend == "CPU" else "vulkan", "routing_status": ("cpu_only" if backend == "CPU" else "accelerated") if live else "n/a",
            "routing_reason": None if live else "Native Vulkan selected; verification occurs on model load.",
            "runtime_backend": ("cpu" if backend == "CPU" else "vulkan") if live else None,
            "runtime_device_index": int(backend[6:]) if backend and backend[6:].isdigit() else None,
            "runtime_device_name": gpu_name or backend, "runtime_hardware_family": ("cpu" if backend == "CPU" else "vulkan") if live else None,
            "runtime_vram_gb": None, "runtime_device_verified": live,
        }

    def _owns_listener(self):
        import psutil

        if self._proc is None or self._proc.poll() is not None:
            raise RuntimeError("Managed native server is not running")
        connections = psutil.Process(self._proc.pid).net_connections(kind="tcp")
        if not any(c.status == psutil.CONN_LISTEN and c.laddr.port == self._port
                   and c.laddr.ip == "127.0.0.1" for c in connections):
            raise RuntimeError("Loopback listener is not owned by the managed native server")

    def _request(self, path, payload=None, timeout=5):
        self._owns_listener()
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self._port}{path}", data=body,
            headers={"Content-Type": "application/json"}, method="GET" if body is None else "POST",
        )
        with self._http.open(request, timeout=timeout) as response:
            return response.read()

    def _ensure_loaded(self):
        with self._lock:
            choice = self._conversion_compute.get()
            if self._proc is not None and self._proc.poll() is None and self._backend and ((choice == "cpu") == (self._backend == "CPU")):
                return
            self.unload()
            binary, base, acoustic = configured_paths()
            from core.config import DATA_DIR

            directory = Path(DATA_DIR) / "voxcpm2-native"
            directory.mkdir(parents=True, exist_ok=True)
            self._log_path = directory / "server.log"
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                self._port = reservation.getsockname()[1]
            argv = [str(binary), "--host", "127.0.0.1", "--port", str(self._port),
                    "--threads", str(min(3 if choice == "cpu" else 6, os.cpu_count() or 1)),
                    "--voxcpm2-base-lm", str(base), "--voxcpm2-acoustic", str(acoustic)]
            if choice == "cpu":
                argv += ["--voxcpm2-n-gpu-layers", "0"]
            with self._log_path.open("wb") as log:
                self._proc = spawn_owned(argv, stdin=subprocess.DEVNULL, stdout=log,
                                         stderr=subprocess.STDOUT, cwd=str(binary.parent),
                                         creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            atexit.register(self.unload)
            try:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    if self._proc.poll() is not None:
                        raise RuntimeError("Native speech server exited; inspect voxcpm2-native/server.log")
                    try:
                        health = json.loads(self._request("/health"))
                    except (urllib.error.URLError, OSError, RuntimeError):
                        time.sleep(0.5)
                        continue
                    if health.get("status") == "ok" and health.get("engine") == "voxcpm2":
                        self._backend = verified_backend(self._log_path.read_text(encoding="utf-8", errors="replace"), expected=choice)
                        self._gpu_name = native_device_name(binary, self._backend) if choice != "cpu" else None
                        self._device = self._backend
                        self._provider = "cpu" if choice == "cpu" else "vulkan"
                        self._compute_type = "Q8_0 + Acoustic F16"
                        return
                raise TimeoutError("Native speech server did not become ready within 120 seconds")
            except BaseException:
                self.unload()
                raise

    def generate(self, text, **options):
        self._check_language(options.get("language"))
        prepare_voxcpm_reference(options)
        payload = speech_payload(text, **options)
        with self._lock:
            self._ensure_loaded()
            try:
                wav_bytes = self._request("/v1/audio/speech", payload, timeout=240)
                import numpy as np
                import soundfile as sf

                wav, rate = sf.read(io.BytesIO(wav_bytes), dtype="float32")
                if rate != self.sample_rate or wav.ndim != 1 or not len(wav) or not np.isfinite(wav).all():
                    raise RuntimeError("Native speech server returned invalid mono 48 kHz audio")
                return self._finalize(wav)
            except BaseException:
                self.unload()
                raise

    def unload(self):
        with self._lock:
            proc, self._proc = self._proc, None
            self._backend = None
            self._gpu_name = None
            self._device = None
            self._provider = None
            self._compute_type = None
            if proc is not None:
                try:
                    proc.terminate()
                    proc.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    proc.kill()
                    proc.wait(timeout=5)
            atexit.unregister(self.unload)
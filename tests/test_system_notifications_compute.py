"""CPU notices must follow the selected engine, including native providers."""
from types import SimpleNamespace

import pytest


@pytest.fixture
def notification_host(monkeypatch):
    from api.routers import system
    from core import device_caps, run_sentinel
    from services import tts_backend

    monkeypatch.setattr(system, "_has_hf_token", lambda: True)
    monkeypatch.setattr(system, "find_ffmpeg", lambda: "ffmpeg")
    monkeypatch.setattr(system, "get_best_device", lambda: "cpu")
    monkeypatch.setattr(system, "_gpu_arch_warning_cached", lambda: None)
    monkeypatch.setattr(system, "_crashed_last_session", lambda: False)
    monkeypatch.setattr(system.shutil, "disk_usage", lambda _: SimpleNamespace(free=20 * 1024**3))
    monkeypatch.setattr(run_sentinel, "newest_record", lambda: None)
    monkeypatch.setattr(device_caps, "detect_host_caps", lambda: SimpleNamespace(family="cpu"))
    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "selected-test")
    return system, tts_backend


@pytest.mark.parametrize("device,status,expected", [
    ("vulkan", "accelerated", False),
    ("vulkan", "n/a", False),  # selected, not yet loaded: no claim it runs on CPU
    ("cuda", "accelerated", False),  # provider independent of parent's torch
    ("cpu", "cpu_fallback", True),
    ("cpu", "cpu_only", True),
])
def test_cpu_notice_uses_selected_engine(notification_host, monkeypatch, device, status, expected):
    system, tts = notification_host
    class SelectedEngine:
        def __init__(self):
            raise AssertionError("Notification polling must not construct or load an engine")

        @classmethod
        def runtime_compute_profile(cls, caps):
            return {"effective_device": device, "routing_status": status}

    monkeypatch.setattr(tts, "get_backend_class", lambda _: SelectedEngine)
    notes = system.system_notifications()["notifications"]
    assert any(n["id"] == "gpu-unavailable" for n in notes) is expected


def test_compute_probe_failure_retains_cpu_notice(notification_host, monkeypatch, caplog):
    system, tts = notification_host
    def unavailable(_):
        raise RuntimeError("probe unavailable")
    monkeypatch.setattr(tts, "get_backend_class", unavailable)
    with caplog.at_level("WARNING"):
        notes = system.system_notifications()["notifications"]
    assert any(n["id"] == "gpu-unavailable" for n in notes)
    assert "Active TTS compute could not be checked" in caplog.text


def test_unloaded_probe_does_not_hide_live_native_instance(monkeypatch):
    import weakref
    from engines.voxcpm2_native import VoxCPM2NativeBackend

    monkeypatch.setattr(VoxCPM2NativeBackend, "_instances", weakref.WeakSet(), raising=False)
    live = VoxCPM2NativeBackend()
    live._proc = SimpleNamespace(poll=lambda: None)
    live._backend = "Vulkan0"
    probe = VoxCPM2NativeBackend()
    try:
        result = VoxCPM2NativeBackend.runtime_compute_profile(None)
        assert result["runtime_device_verified"] is True
        assert result["routing_status"] == "accelerated"
        live._proc = None
        live.unload()
        assert VoxCPM2NativeBackend.runtime_compute_profile(None)["runtime_device_verified"] is False
    finally:
        live._proc = None
        probe.unload()

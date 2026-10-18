"""Native GPU identity is load-time evidence, not invented telemetry."""
from types import SimpleNamespace
import pytest

@pytest.mark.parametrize("verified,name", [(True, "AMD Radeon RX 6600M"), (False, None)])
def test_sysinfo_native_gpu_status_without_metrics(monkeypatch, verified, name):
    from api.routers import system
    from services import tts_backend
    from core import device_caps
    profile={"effective_device":"vulkan", "runtime_backend":"vulkan" if verified else None,
             "runtime_device_verified":verified, "runtime_device_name":name}
    class Native:
        def __init__(self):
            raise AssertionError("Telemetry must not load or construct engines")
        @classmethod
        def runtime_compute_profile(cls, caps): return profile
    monkeypatch.setattr(tts_backend, "get_backend_class", lambda _: Native)
    monkeypatch.setattr(tts_backend, "active_backend_id", lambda: "voxcpm2")
    monkeypatch.setattr(device_caps, "detect_host_caps", lambda: None)
    monkeypatch.setattr(system, "_is_cuda", False)
    monkeypatch.setattr(system, "_is_mac", False)
    monkeypatch.setattr(system, "_is_xpu", False)
    data=system.get_sys_info()
    assert data["gpu_utilization"] is None
    assert data["total_vram"] == 0
    assert data["tts_runtime"] == {"provider":"Vulkan", "device_name":name, "verified":verified}

def test_native_device_name_matches_backend_identifier():
    from engines.voxcpm2_native import device_name_from_listing
    listing="Available devices:\n  Vulkan0: AMD Radeon RX 6600M (8176 MiB, 4964 MiB free)\n  Vulkan1: Another GPU (4096 MiB, 2000 MiB free)\n"
    assert device_name_from_listing(listing, "Vulkan0") == "AMD Radeon RX 6600M"
    assert device_name_from_listing(listing, "Vulkan1") == "Another GPU"
    assert device_name_from_listing(listing, "Vulkan2") is None
    assert device_name_from_listing(listing, "CPU") is None

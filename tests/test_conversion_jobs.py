import time
import pytest
from services.conversion_jobs import ConversionJob


def test_progress_is_stage_scoped_and_eta_needs_measured_steps():
    job = ConversionJob("test")
    job.update("loading")
    assert job.snapshot()["percent"] is None
    assert job.snapshot()["eta_s"] is None
    for step in range(4):
        job.update("diffusion", step=step, total=30, chunk=1, observed_at=10 + step * 2)
    state = job.snapshot()
    assert state["percent"] == 10
    assert state["eta_s"] == pytest.approx(54)
    job.update("vocoder")
    assert job.snapshot()["percent"] is None
    assert job.snapshot()["eta_s"] is None


def test_cancel_is_not_confirmed_before_worker_and_request_retire():
    job = ConversionJob("test")
    job.start_worker()
    job.cancel()
    job.finish("cancelled")
    assert job.snapshot()["state"] == "cancelling"
    job.end_worker()
    assert job.snapshot()["state"] == "cancelled"
    assert job.drained.is_set()


def test_new_chunk_does_not_reuse_previous_eta():
    job = ConversionJob("test")
    for step in range(4):
        job.update("diffusion", step=step, total=30, chunk=1, observed_at=10 + step)
    job.update("diffusion", step=0, total=30, chunk=2, observed_at=100)
    assert job.snapshot()["eta_s"] is None


def test_cancel_before_upload_blocks_late_conversion():
    from fastapi.testclient import TestClient
    from main import app
    from uuid import uuid4
    client = TestClient(app, client=("127.0.0.1", 50000))
    job_id = str(uuid4())
    receipt = client.post(f"/convert/jobs/{job_id}/cancel")
    assert receipt.status_code == 200
    assert receipt.json()["state"] == "cancelled"
    response = client.post("/convert", data={"profile_id":"unused", "job_id":job_id}, files={"audio":("sample.wav",b"sample","audio/wav")})
    assert response.status_code == 499
    assert client.get(f"/convert/jobs/{job_id}").json()["state"] == "cancelled"


def test_step_reporter_counts_completed_iterations(tmp_path):
    import json
    from engines.seed_vc.progress import Reporter
    report = Reporter(tmp_path / "steps.jsonl")
    iterator = report.steps(range(1, 4))
    next(iterator)
    records = [json.loads(line) for line in report.path.read_text().splitlines()]
    assert records[-1]["step"] == 0
    next(iterator)
    records = [json.loads(line) for line in report.path.read_text().splitlines()]
    assert records[-1]["step"] == 1
    list(iterator)
    records = [json.loads(line) for line in report.path.read_text().splitlines()]
    assert records[-1]["step"] == 3
    assert all(row["total"] == 3 for row in records)


def test_native_model_loading_does_not_report_cancelled_until_drained():
    import asyncio
    async def scenario():
        job = ConversionJob("async-load")
        release = asyncio.Event()
        async def loader(): await release.wait()
        waiting = asyncio.create_task(job.async_call(loader()))
        await asyncio.sleep(0)
        job.cancel()
        waiting.cancel()
        await asyncio.gather(waiting, return_exceptions=True)
        job.finish("cancelled")
        assert job.snapshot()["state"] == "cancelling"
        release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert job.snapshot()["state"] == "cancelled"
    asyncio.run(scenario())


@pytest.mark.parametrize("frames,reference,expected", [(100,20,2),(80,20,1),(81,20,2),(144,20,2),(145,20,3),(15000,1000,10)])
def test_reporter_counts_real_overlapping_chunks(tmp_path, frames, reference, expected):
    import json
    from engines.seed_vc.progress import Reporter
    report = Reporter(tmp_path / 'plan.jsonl')
    report.plan(frames, reference, max_context_frames=100 if frames < 1000 else 2580, overlap_frames=16)
    for _ in range(expected):
        list(report.steps(range(2)))
    records = [json.loads(line) for line in report.path.read_text().splitlines()]
    assert records[-1]['chunk'] == expected
    assert records[-1]['chunk_total'] == expected


def test_job_propagates_chunk_total_and_resets_eta_for_each_chunk():
    job = ConversionJob('chunk-count')
    job.update('diffusion', chunk=5, chunk_total=10, step=18, total=30)
    assert job.snapshot()['chunk_total'] == 10
    assert job.snapshot()['percent'] == 60
    job.update('vocoder', chunk=5, chunk_total=10)
    assert job.snapshot()['chunk'] == 5
    assert job.snapshot()['chunk_total'] == 10
    assert job.snapshot()['percent'] is None


def test_watchdog_allows_long_conversion_with_real_progress_only():
    from engines.seed_vc.progress import ProgressWatchdog, SingingProgressTimeout
    clock = [0.0]
    watchdog = ProgressWatchdog(1800, clock=lambda: clock[0])
    for chunk in range(1, 8):
        clock[0] += 1000
        watchdog.observe({'stage':'diffusion','chunk':chunk,'step':1,'total':30})
        watchdog.check()
    clock[0] += 1801
    with pytest.raises(SingingProgressTimeout):
        watchdog.check()

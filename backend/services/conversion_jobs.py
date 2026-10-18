"""Bounded, content-free conversion progress and cancellation receipts."""
import asyncio
from collections import deque
from functools import wraps
import threading
import time


class ConversionCancelled(RuntimeError):
    pass


class ConversionJob:
    def __init__(self, job_id):
        self.id = job_id
        self.started = time.monotonic()
        self.lock = threading.RLock()
        self.cancel_requested = threading.Event()
        self.drained = threading.Event()
        self.drained.set()
        self.workers = 0
        self.request_finished = False
        self.state = "running"
        self.stage = "uploading"
        self.step = self.total = self.chunk = self.chunk_total = None
        self.measurements = deque(maxlen=6)
        self.ended = None

    def check(self):
        if self.cancel_requested.is_set():
            raise ConversionCancelled("Conversion cancelled")

    def update(self, stage, *, step=None, total=None, chunk=None, chunk_total=None, observed_at=None):
        with self.lock:
            if self.state != "running":
                return
            now = time.monotonic() if observed_at is None else observed_at
            if stage != self.stage or chunk != self.chunk:
                self.measurements.clear()
            self.stage, self.step, self.total, self.chunk = stage, step, total, chunk
            self.chunk_total = chunk_total
            if stage == "diffusion" and isinstance(step, int) and isinstance(total, int) and 0 <= step <= total and total > 0:
                if not self.measurements or step > self.measurements[-1][0]:
                    self.measurements.append((step, now))
            else:
                self.step = self.total = None
                self.measurements.clear()

    def start_worker(self):
        with self.lock:
            self.check()
            self.workers += 1
            self.drained.clear()

    def end_worker(self):
        with self.lock:
            self.workers -= 1
            if self.workers == 0:
                self.drained.set()
                if self.request_finished and self.cancel_requested.is_set():
                    self._terminal("cancelled")

    def worker(self, fn):
        @wraps(fn)
        def run():
            self.start_worker()
            try:
                return fn()
            finally:
                self.end_worker()
        return run

    async def async_call(self, operation):
        # A model loader can own native thread work. Shield its coroutine so
        # cancellation cannot claim it retired while that load still runs.
        try:
            self.start_worker()
        except BaseException:
            operation.close()
            raise
        task = asyncio.create_task(operation)
        def retired(done):
            try:
                if not done.cancelled():
                    done.exception()
            finally:
                self.end_worker()
        task.add_done_callback(retired)
        return await asyncio.shield(task)

    def cancel(self):
        with self.lock:
            if self.state in {"completed", "failed", "cancelled"}:
                return
            self.cancel_requested.set()
            self.state = self.stage = "cancelling"
            self.step = self.total = None
            self.measurements.clear()

    def _terminal(self, state):
        self.state = self.stage = state
        self.ended = time.monotonic()
        self.step = self.total = None
        self.measurements.clear()

    def finish(self, state):
        with self.lock:
            self.request_finished = True
            if self.cancel_requested.is_set() or state == "cancelled":
                self.cancel()
                if self.workers == 0:
                    self._terminal("cancelled")
            else:
                self._terminal(state)

    def snapshot(self):
        with self.lock:
            percent = eta = None
            if self.stage == "diffusion" and self.total:
                percent = round(100 * self.step / self.total, 1)
                if len(self.measurements) >= 4 and self.step < self.total:
                    first, last = self.measurements[0], self.measurements[-1]
                    eta = max(0, (last[1] - first[1]) / (last[0] - first[0]) * (self.total - self.step))
            return {"job_id": self.id, "state": self.state, "stage": self.stage,
                    "elapsed_s": round((self.ended or time.monotonic()) - self.started, 1),
                    "step": self.step, "total": self.total, "chunk": self.chunk, "chunk_total": self.chunk_total,
                    "percent": percent, "eta_s": round(eta, 1) if eta is not None else None,
                    "eta_scope": "stage" if eta is not None else None}


_jobs = {}
_registry_lock = threading.Lock()


def create(job_id):
    with _registry_lock:
        now = time.monotonic()
        for key, job in list(_jobs.items()):
            if job.ended is not None and now - job.ended > 3600:
                del _jobs[key]
        if job_id in _jobs:
            raise ValueError("Conversion job identifier already used")
        if len(_jobs) >= 64:
            finished = [key for key, job in _jobs.items() if job.ended is not None]
            if not finished:
                raise RuntimeError("Too many active conversion jobs")
            del _jobs[finished[0]]
        job = ConversionJob(job_id)
        _jobs[job_id] = job
        return job


def get(job_id):
    with _registry_lock:
        return _jobs.get(job_id)

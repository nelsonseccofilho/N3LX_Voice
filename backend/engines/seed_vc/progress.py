"""Small side-channel: completed solver iterations, never guessed percentages."""
import json
import math
import time
from pathlib import Path


class Reporter:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.chunk = 0
        self.chunk_total = None
        self.condition_frames = []

    def plan(self, source_frames, reference_frames, *, max_context_frames, overlap_frames=16):
        window = max_context_frames - reference_frames
        if window <= overlap_frames:
            raise RuntimeError('Seed-VC reference leaves no usable source window')
        # Upstream advances by window minus overlap until its final window.
        self.chunk_total = 1 + math.ceil(max(0, source_frames - window) / (window - overlap_frames))

    def conditioning(self, module, inputs, output):
        self.condition_frames.append(output[0].size(1))
        if len(self.condition_frames) == 2:
            self.plan(*self.condition_frames, max_context_frames=44100 // 512 * 30)

    def emit(self, stage, **values):
        if stage in {'diffusion', 'vocoder'} and self.chunk:
            values = {'chunk': self.chunk, 'chunk_total': self.chunk_total, **values}
        if self.path:
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps({"stage": stage, "observed_at": time.monotonic(), **values}) + "\n")

    def steps(self, iterable, *args, **kwargs):
        self.chunk += 1
        total = len(iterable)
        self.emit("diffusion", step=0, total=total, chunk=self.chunk)
        for completed, value in enumerate(iterable, 1):
            yield value
            self.emit("diffusion", step=completed, total=total, chunk=self.chunk)


class SingingProgressTimeout(TimeoutError):
    """Owned singing worker stopped after no real engine progress."""


class ProgressWatchdog:
    def __init__(self, idle_seconds=1800, *, clock=time.monotonic):
        self.clock = clock
        self.idle_seconds = idle_seconds
        self.last_progress = clock()
        self.last_event = None

    def observe(self, event):
        identity = (event.get('stage'), event.get('chunk'), event.get('step'))
        if identity != self.last_event:
            self.last_event = identity
            self.last_progress = self.clock()

    def check(self):
        if self.clock() - self.last_progress > self.idle_seconds:
            raise SingingProgressTimeout('Singing conversion stopped after 30 minutes without engine progress')

"""Best-effort host-memory return after model initialization, never per segment."""
from __future__ import annotations

import ctypes
import gc
import logging
import sys


def release_startup_memory() -> None:
    """Collect unreachable objects and return unused glibc pages if supported.

    Call in the owning worker after warmup, before accepting requests. This does
    not unload models, clear voice conditioning, or alter CUDA's caching allocator.
    Other platforms/allocators may retain memory; that is not a readiness failure.
    """
    gc.collect()
    if sys.platform != "linux":
        return
    try:
        trim = ctypes.CDLL(None).malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        released = bool(trim(0))
    except (AttributeError, OSError):
        logging.getLogger(__name__).debug("TTS startup host-memory trim unavailable")
        return
    logging.getLogger(__name__).info("TTS startup host-memory trim released_pages=%s", released)

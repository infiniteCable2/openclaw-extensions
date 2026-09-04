#!/usr/bin/env python3
"""Bounded CUDA Driver API readiness probe for the privileged broker.

The broker runs this module in a short-lived subprocess.  Keeping CUDA Driver
API initialization outside the broker process ensures that any NVIDIA device
handles are closed before a later power-off transition.
"""

from __future__ import annotations

import ctypes
from typing import Any, Callable


CUDA_SUCCESS = 0
MINIMUM_DEVICE_COUNT = 1


class CudaDriverProbeError(RuntimeError):
    """The CUDA Driver API is not ready for a compute consumer."""


def probe_cuda_driver(
    library_factory: Callable[..., Any] = ctypes.CDLL,
) -> int:
    try:
        driver = library_factory("libcuda.so.1")
    except OSError as exc:
        raise CudaDriverProbeError("CUDA driver library is unavailable") from exc

    try:
        cu_init = driver.cuInit
        cu_device_get_count = driver.cuDeviceGetCount
    except AttributeError as exc:
        raise CudaDriverProbeError("CUDA driver symbols are unavailable") from exc

    cu_init.argtypes = [ctypes.c_uint]
    cu_init.restype = ctypes.c_int
    cu_device_get_count.argtypes = [ctypes.POINTER(ctypes.c_int)]
    cu_device_get_count.restype = ctypes.c_int

    if int(cu_init(0)) != CUDA_SUCCESS:
        raise CudaDriverProbeError("CUDA driver initialization is incomplete")

    device_count = ctypes.c_int(0)
    if int(cu_device_get_count(ctypes.byref(device_count))) != CUDA_SUCCESS:
        raise CudaDriverProbeError("CUDA device enumeration is incomplete")
    if int(device_count.value) < MINIMUM_DEVICE_COUNT:
        raise CudaDriverProbeError("CUDA exposes no compute device")
    return int(device_count.value)


def main() -> int:
    try:
        probe_cuda_driver()
    except CudaDriverProbeError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

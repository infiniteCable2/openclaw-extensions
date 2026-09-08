from __future__ import annotations

import pytest

from openclaw_accelerator import AcceleratorDemandUnavailable
from openclaw_local_embedding.runtime import EmbeddingRuntimeError, OllamaEmbeddingRuntime


@pytest.mark.parametrize(
    ("entry", "ok"),
    [
        ({"name": "qwen3-embedding:0.6b", "size": 1000, "size_vram": 1000}, True),
        ({"name": "qwen3-embedding:0.6b", "size": 1000, "size_vram": 949}, False),
        ({"name": "other", "size": 1000, "size_vram": 1000}, False),
    ],
)
def test_gpu_residency_is_fail_closed(entry: dict[str, object], ok: bool) -> None:
    runtime = object.__new__(OllamaEmbeddingRuntime)
    runtime.model = "qwen3-embedding:0.6b"
    runtime.minimum_vram_ratio = 0.95
    runtime._request_json = lambda *_args, **_kwargs: {"models": [entry]}  # type: ignore[method-assign]
    if ok:
        runtime._verify_gpu_residency()
    else:
        with pytest.raises(EmbeddingRuntimeError):
            runtime._verify_gpu_residency()


def test_accelerator_failure_is_a_typed_service_error() -> None:
    class FailedLease:
        def activity(self):
            raise AcceleratorDemandUnavailable("unavailable")

    runtime = object.__new__(OllamaEmbeddingRuntime)
    runtime._lease = FailedLease()
    with pytest.raises(EmbeddingRuntimeError, match="accelerator demand"):
        runtime.embed(["synthetic"])

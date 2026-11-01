# Optional compiled KittenTTS 2 decode

`--kitten-compile` enables Transformers' native static KV cache and
`CompileConfig(mode="reduce-overhead", fullgraph=False)` for Kitten's Torch
backend. The default remains eager. This option does not change transport,
segmentation, joins, cancellation ownership, voice references or model precision.

Compilation reduces repeated Python/kernel-launch overhead. The mode requests
CUDA Graph optimizations where supported; graph breaks or incompatible operations
can prevent capture. It does not guarantee that every operation is graph-replayed.

The worker warms every configured voice with short and longer plain and
expressive synthesis before opening its listener. A failed warmup prevents
readiness. Previously unseen shapes may still compile during a later request;
warmup cannot guarantee zero future compilation. A fresh worker must rebuild
process-local graphs even when compiled kernels are cached on disk.

Provision extra CPU/RAM during startup and additional VRAM. Use bounded compiler
parallelism (`TORCHINDUCTOR_COMPILE_THREADS=1`, `MAX_JOBS=1`) on small hosts.
Set `TORCHINDUCTOR_CACHE_DIR` and `TRITON_CACHE_DIR` to private, runtime-owned
directories outside the source tree. Compiler caches contain executable code:
never share them with untrusted users. Retain only the active cache generation;
retire completed qualification caches once their consumers have exited.

Qualify short/long/alternating inputs, expression controls, concurrent requests,
cancellation and worker restarts on the actual pinned runtime before enabling.
Compare generation time per generated audio second or token, not raw wall time
alone: compiler/cache changes can alter sampled output despite an identical seed.
Check speech completeness and voice quality separately from timing. Keep the
previous eager deployment available for a code/configuration rollback without
rewinding agent state.

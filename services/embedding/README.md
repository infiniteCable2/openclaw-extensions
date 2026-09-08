# OpenClaw local embedding service

This loopback-only provider exposes Ollama's `/api/embed` contract to OpenClaw
while owning the accelerator demand lease around local embedding work. OpenClaw
continues to own memory files, transcript admission, indexing, search, and
per-agent isolation.

The provider is intentionally narrow:

- one configured embedding model and vector dimension;
- bounded request size, batch size, queue, and concurrency;
- no cloud endpoint or CPU fallback;
- accelerator readiness before each request;
- explicit Ollama process-inventory proof that at least 95% of the model is in VRAM;
- native Ollama unload and an empty `/api/ps` before lease release;
- no logging of text, vectors, identities, or lease credentials.

The initial production model is `qwen3-embedding:0.6b` with 1024 dimensions.
Changing its name, digest, dimensions, or chunking requires an explicit
OpenClaw memory reindex.

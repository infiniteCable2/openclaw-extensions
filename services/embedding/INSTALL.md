# Embedding installation

Install the reviewed accelerator and embedding packages together into a
dedicated Python 3.13 virtual environment. Run the service as the `openclaw`
account with membership in the accelerator socket group and bind only to
`127.0.0.1`.

Configure OpenClaw with a dedicated model provider whose API is `ollama` and
whose base URL is the embedding service loopback origin. Then set
`memory.search.provider` to that provider, select the exact model, set fallback
to `none`, and enable cross-conversation memory only on explicitly personal
agents. Keep internal/system agents disabled explicitly.

Before selection, validate the package, service hardening, exact Ollama model
digest, a synthetic 1024-dimensional non-zero embedding, and broker-confirmed
unload after the idle interval. Back up the OpenClaw configuration and service
unit before cutover; roll both back together.

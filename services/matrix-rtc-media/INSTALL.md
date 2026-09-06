# Installation

Build the release artifact in a clean Linux container. Do not install a Rust
toolchain into the OpenClaw runtime account. The build image contains the
Clang and Linux headers required by LiveKit's native WebRTC archive.

```sh
cd services/matrix-rtc-media
docker build --pull=false -f Containerfile.build \
  -t openclaw-matrix-rtc-builder:local .
docker run --rm -v "$PWD:/src" \
  openclaw-matrix-rtc-builder:local cargo test --locked
docker run --rm -v "$PWD:/src" \
  openclaw-matrix-rtc-builder:local cargo build --locked --release
```

`Cargo.lock` is mandatory and pins the complete LiveKit/WebRTC graph. The
LiveKit source is also fixed to its upstream release commit because its older
crates permit semver combinations that no longer compile together. Do not
refresh either pin as part of a deployment; update them in a reviewed change
with a clean build and call test.

Copy only the resulting binary into a root-owned release directory such as
`/srv/openclaw/releases/<commit>/libexec/`; select it through the same atomic
release pointer used by OpenClaw. The binary may run as the unprivileged
OpenClaw service account and needs no supplemental group or network privilege.

The parent Matrix plugin must create a private runtime directory and unique
control-socket path for every call. It must remove stale paths before launch,
wait for the `ready` event, send the `start` envelope over the socket, and kill
the bridge if identity policy, MatrixRTC membership, E2EE, or transport health
fails. A release is not accepted until a real encrypted Element X call proves
bidirectional audio, barge-in, teardown, and rejection of a third participant.

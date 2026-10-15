mod playout;
mod protocol;
mod video;

use std::{
    collections::{BTreeMap, BTreeSet}, env, fs::Permissions, os::unix::fs::PermissionsExt, path::PathBuf,
    sync::Arc,
};

use anyhow::{Context, ensure};
use futures_util::StreamExt;
use livekit::{
    Room, RoomEvent, RoomOptions,
    e2ee::key_provider::{KeyDerivationAlgorithm, KeyProvider, KeyProviderOptions},
    id::ParticipantIdentity,
    options::TrackPublishOptions,
    track::{LocalAudioTrack, LocalTrack, RemoteTrack, TrackSource},
    webrtc::{
        audio_source::native::NativeAudioSource,
        audio_stream::native::NativeAudioStream,
        prelude::{AudioFrame, AudioSourceOptions, RtcAudioSource},
    },
};
use playout::{AudioSink, OutputControl, pump_local_audio};
use protocol::{
    CHANNELS, ControlEvent, ControlMessage, DecodedKey, FRAME_SAMPLES, OUTPUT_FRAME_HEADER_BYTES,
    OutputGate, SAMPLE_RATE, decode_key, decode_output_frame_header, validate_start,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, mpsc},
};
use video::{pump_remote_video, pump_video_output};

const MAX_CONTROL_LINE_BYTES: usize = 128 * 1024;
// Queue configuration remains unchanged. The single owner paces submission rather
// than filling this buffer; only confirmed cancellation clears it.
const OUTPUT_QUEUE_MS: u32 = 1_000;

fn socket_args() -> anyhow::Result<(PathBuf, Option<PathBuf>)> {
    let mut args = env::args_os();
    let _program = args.next();
    ensure!(
        args.next().as_deref() == Some("--control-socket".as_ref()),
        "expected --control-socket"
    );
    let path = PathBuf::from(args.next().context("missing control socket path")?);
    ensure!(path.is_absolute(), "control socket path must be absolute");
    let video = if let Some(flag) = args.next() {
        ensure!(flag == "--video-socket", "unexpected command arguments");
        let video = PathBuf::from(args.next().context("missing video socket path")?);
        ensure!(video.is_absolute() && video != path, "invalid video socket path");
        Some(video)
    } else { None };
    ensure!(args.next().is_none(), "unexpected command arguments");
    Ok((path, video))
}

async fn send_event(
    writer: &Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    event: ControlEvent<'_>,
) -> anyhow::Result<()> {
    let mut writer = writer.lock().await;
    let mut payload = serde_json::to_vec(&event)?;
    payload.push(b'\n');
    writer.write_all(&payload).await?;
    Ok(())
}

async fn read_control_line(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> anyhow::Result<ControlMessage> {
    let mut line = Vec::new();
    let read = reader.read_until(b'\n', &mut line).await?;
    ensure!(read > 0, "control channel closed");
    ensure!(
        line.len() <= MAX_CONTROL_LINE_BYTES,
        "control message is too large"
    );
    Ok(serde_json::from_slice(&line).context("invalid control message")?)
}

fn install_key(provider: &KeyProvider, key: DecodedKey) -> anyhow::Result<()> {
    ensure!(
        provider.set_key(
            &ParticipantIdentity(key.participant_identity),
            i32::from(key.index),
            key.key,
        ),
        "LiveKit rejected a media key"
    );
    Ok(())
}

async fn pump_remote_audio(
    track: livekit::track::RemoteAudioTrack,
    stdout: Arc<Mutex<tokio::io::Stdout>>,
) -> anyhow::Result<()> {
    let mut stream = NativeAudioStream::new(track.rtc_track(), SAMPLE_RATE as i32, CHANNELS as i32);
    while let Some(frame) = stream.next().await {
        let mut bytes = Vec::with_capacity(frame.data.len() * 2);
        for sample in frame.data.iter() {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        stdout.lock().await.write_all(&bytes).await?;
    }
    Ok(())
}

async fn read_output_frame(stdin: &mut tokio::io::Stdin) -> anyhow::Result<Option<(u64, Vec<u8>)>> {
    let mut header = [0_u8; OUTPUT_FRAME_HEADER_BYTES];
    if stdin.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    stdin
        .read_exact(&mut header[1..])
        .await
        .context("truncated output frame header")?;
    let (generation, payload_bytes) = decode_output_frame_header(&header)?;
    let mut payload = vec![0_u8; payload_bytes];
    stdin
        .read_exact(&mut payload)
        .await
        .context("truncated output frame payload")?;
    Ok(Some((generation, payload)))
}

async fn read_local_audio(output: mpsc::Sender<(u64, Vec<u8>)>) -> anyhow::Result<()> {
    let mut stdin = tokio::io::stdin();
    while let Some((generation, bytes)) = read_output_frame(&mut stdin).await? {
        output
            .send((generation, bytes))
            .await
            .context("output audio queue closed")?;
    }
    Ok(())
}

impl AudioSink for NativeAudioSource {
    fn capture<'a>(
        &'a self,
        bytes: &'a [u8],
        gate: OutputGate,
        diagnostic: bool,
    ) -> futures_util::future::BoxFuture<'a, anyhow::Result<()>> {
        Box::pin(capture_output_frame(self, bytes, gate, diagnostic))
    }

    fn clear(&self) {
        self.clear_buffer();
    }
}

async fn capture_output_frame(
    source: &NativeAudioSource,
    bytes: &[u8],
    gate: OutputGate,
    diagnostic: bool,
) -> anyhow::Result<()> {
    let mut frame = AudioFrame::new(SAMPLE_RATE, CHANNELS, FRAME_SAMPLES as u32);
    for (sample, chunk) in frame.data.to_mut().iter_mut().zip(bytes.chunks_exact(2)) {
        let value = i16::from_le_bytes([chunk[0], chunk[1]]);
        *sample = if gate == OutputGate::Duck {
            value / 4
        } else {
            value
        };
    }
    if diagnostic {
        eprintln!(
            "matrix_rtc_media_output_frame_nonzero={}",
            bytes.iter().any(|byte| *byte != 0)
        );
    }
    source.capture_frame(&frame).await?;
    if diagnostic {
        eprintln!("matrix_rtc_media_output_frame_captured=true");
    }
    Ok(())
}

async fn run_started_session(
    mut control: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
    video_listener: Option<UnixListener>,
) -> anyhow::Result<()> {
    let start = validate_start(read_control_line(&mut control).await?)?;
    ensure!(start.video.is_some() == video_listener.is_some(), "video socket and capture policy must match");
    let video_socket = if let Some(listener) = video_listener {
        Some(tokio::time::timeout(std::time::Duration::from_secs(15), listener.accept()).await??.0)
    } else { None };
    let allowed: BTreeSet<String> = start.allowed_remote_identities;
    let key_provider = KeyProvider::new(KeyProviderOptions {
        ratchet_window_size: 10,
        key_ring_size: 256,
        key_derivation_algorithm: KeyDerivationAlgorithm::HKDF,
        ..Default::default()
    });
    for key in start.initial_keys {
        install_key(&key_provider, key)?;
    }

    let mut options = RoomOptions::default();
    if start.encrypted {
        options.encryption = Some(livekit::E2eeOptions {
            encryption_type: livekit::e2ee::EncryptionType::Gcm,
            key_provider: key_provider.clone(),
        });
    }
    let (room, mut room_events) = Room::connect(&start.url, &start.token, options).await?;
    if start.encrypted {
        room.e2ee_manager().set_enabled(true);
    }
    ensure!(
        room.remote_participants()
            .keys()
            .all(|identity| allowed.contains(identity.0.as_str())),
        "unexpected participant was already present"
    );

    let source = NativeAudioSource::new(
        AudioSourceOptions {
            echo_cancellation: false,
            noise_suppression: false,
            auto_gain_control: false,
        },
        SAMPLE_RATE,
        CHANNELS,
        OUTPUT_QUEUE_MS,
    );
    let track =
        LocalAudioTrack::create_audio_track("openclaw", RtcAudioSource::Native(source.clone()));
    room.local_participant()
        .publish_track(
            LocalTrack::Audio(track),
            TrackPublishOptions {
                source: TrackSource::Microphone,
                ..Default::default()
            },
        )
        .await?;

    send_event(&writer, ControlEvent::Connected).await?;
    let stdout = Arc::new(Mutex::new(tokio::io::stdout()));
    let (fatal_tx, mut fatal_rx) = mpsc::channel::<()>(1);
    let (output_tx, output_rx) = mpsc::channel::<(u64, Vec<u8>)>(4);
    let (output_control_tx, output_control_rx) = mpsc::channel::<OutputControl>(4);
    let frame_diagnostic = env::var_os("OPENCLAW_MATRIX_RTC_FRAME_DIAGNOSTIC").is_some();
    let mut local_reader = tokio::spawn(read_local_audio(output_tx.clone()));
    let mut local_audio = tokio::spawn(pump_local_audio(
        source.clone(),
        output_rx,
        output_control_rx,
        frame_diagnostic,
    ));
    let (video_tx, video_rx) = mpsc::channel(1);
    let mut video_tasks = tokio::task::JoinSet::new();
    if let (Some(socket), Some(config)) = (video_socket, start.video) {
        let fatal = fatal_tx.clone();
        video_tasks.spawn(async move {
            if pump_video_output(socket, video_rx, config).await.is_err() {
                let _ = fatal.send(()).await;
            }
        });
    }
    let mut video_tracks: BTreeMap<String, tokio::task::AbortHandle> = BTreeMap::new();
    let mut next_video_source = 0_u32;

    let mut remote_audio_ready = false;
    loop {
        tokio::select! {
            message = read_control_line(&mut control) => match message? {
                ControlMessage::Key { participant_identity, index, key_base64 } => {
                    install_key(&key_provider, decode_key(participant_identity, index, key_base64)?)?;
                }
                ControlMessage::ClearOutput { generation } => {
                    let (acknowledged_tx, acknowledged_rx) = tokio::sync::oneshot::channel();
                    output_control_tx.send(OutputControl::Clear {
                        generation,
                        acknowledged: acknowledged_tx,
                    }).await.context("output audio queue closed")?;
                    ensure!(acknowledged_rx.await?, "output generation must increase");
                    send_event(&writer, ControlEvent::OutputCleared { generation }).await?;
                }
                ControlMessage::SetOutputGate { gate } => {
                    let (acknowledged, ack) = tokio::sync::oneshot::channel();
                    output_control_tx.send(OutputControl::Gate { gate, acknowledged })
                        .await.context("output audio queue closed")?;
                    ack.await.context("output gate owner stopped")?;
                    send_event(&writer, ControlEvent::OutputGateSet { gate }).await?;
                }
                ControlMessage::Stop {} => break,
                ControlMessage::Start { .. } => anyhow::bail!("session is already started"),
            },
            event = room_events.recv() => match event {
                Some(RoomEvent::ParticipantConnected(participant)) => {
                    let identity = participant.identity();
                    if !allowed.contains(identity.0.as_str()) {
                        anyhow::bail!("unexpected participant joined");
                    }
                }
                Some(RoomEvent::TrackSubscribed { track, participant, publication }) => {
                    let identity = participant.identity();
                    if !allowed.contains(identity.0.as_str()) {
                        anyhow::bail!("unexpected participant published media");
                    }
                    match track {
                        RemoteTrack::Audio(track) => {
                            if !remote_audio_ready {
                                send_event(&writer, ControlEvent::RemoteAudioReady).await?;
                                remote_audio_ready = true;
                            }
                            let stdout = stdout.clone();
                            let fatal_tx = fatal_tx.clone();
                            tokio::spawn(async move {
                                if pump_remote_audio(track, stdout).await.is_err() {
                                    let _ = fatal_tx.send(()).await;
                                }
                            });
                        }
                        RemoteTrack::Video(track) => {
                            if let Some(config) = start.video {
                                // One admitted participant can publish camera and screen-share.
                                // Further tracks never create additional decoder queues.
                                let sid = track.sid().to_string();
                                if let Some(previous) = video_tracks.remove(&sid) { previous.abort(); }
                                if video_tracks.len() < 2 {
                                    next_video_source = next_video_source.checked_add(1).context("video source exhausted")?;
                                    let output = video_tx.clone();
                                    let fatal = fatal_tx.clone();
                                    let source = next_video_source;
                                    let handle = video_tasks.spawn(async move {
                                        if pump_remote_video(track, output, config, source).await.is_err() {
                                            let _ = fatal.send(()).await;
                                        }
                                    });
                                    video_tracks.insert(sid, handle);
                                } else {
                                    publication.set_subscribed(false);
                                }
                            } else {
                                publication.set_subscribed(false);
                            }
                        }
                    }
                }
                Some(RoomEvent::TrackUnsubscribed { track: RemoteTrack::Video(track), .. }) => {
                    if let Some(handle) = video_tracks.remove(&track.sid().to_string()) { handle.abort(); }
                }
                Some(RoomEvent::Disconnected { .. }) | None => break,
                _ => {}
            },
            result = &mut local_audio => {
                match result {
                    Ok(Ok(())) => break,
                    _ => anyhow::bail!("local audio stream failed"),
                }
            },
            result = &mut local_reader => {
                match result {
                    Ok(Ok(())) => break,
                    _ => anyhow::bail!("local audio input failed"),
                }
            },
            _ = fatal_rx.recv() => anyhow::bail!("remote media stream failed"),
            result = video_tasks.join_next(), if !video_tasks.is_empty() => {
                if result.is_some_and(|result| result.is_err_and(|error| !error.is_cancelled())) {
                    anyhow::bail!("video processing task failed");
                }
            },
        }
    }

    local_audio.abort();
    local_reader.abort();
    video_tasks.abort_all();
    room.close().await?;
    send_event(&writer, ControlEvent::Stopped).await?;
    Ok(())
}

async fn run_session(stream: UnixStream, video_listener: Option<UnixListener>) -> anyhow::Result<()> {
    let (read_half, write_half) = stream.into_split();
    let control = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));
    send_event(
        &writer,
        ControlEvent::Ready {
            output_gate: true,
            remote_audio_ready: true,
            video_frames: true,
        },
    )
    .await?;

    let result = run_started_session(control, writer.clone(), video_listener).await;
    if result.is_err() {
        let _ = send_event(
            &writer,
            ControlEvent::Fatal {
                code: "session_failed",
            },
        )
        .await;
    }
    result
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let (socket_path, video_path) = socket_args()?;
    ensure!(!socket_path.exists(), "control socket already exists");
    let listener = UnixListener::bind(&socket_path).context("failed to bind control socket")?;
    std::fs::set_permissions(&socket_path, Permissions::from_mode(0o600))?;
    let video_listener = if let Some(path) = video_path.as_ref() {
        ensure!(!path.exists(), "video socket already exists");
        let listener = UnixListener::bind(path).context("failed to bind video socket")?;
        std::fs::set_permissions(path, Permissions::from_mode(0o600))?;
        Some(listener)
    } else { None };

    let result = async {
        let (stream, _) = listener.accept().await?;
        run_session(stream, video_listener).await
    }
    .await;

    if result.is_err() {
        // Never include tokens, keys, participant identities, or room identifiers in stderr.
        eprintln!("matrix_rtc_media_fatal=true");
    }
    let _ = std::fs::remove_file(&socket_path);
    if let Some(path) = video_path { let _ = std::fs::remove_file(path); }
    result
}

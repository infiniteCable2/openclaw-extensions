mod protocol;

use std::{
    collections::BTreeSet, env, fs::Permissions, os::unix::fs::PermissionsExt, path::PathBuf,
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
use protocol::{
    CHANNELS, ControlEvent, ControlMessage, DecodedKey, OUTPUT_FRAME_HEADER_BYTES, SAMPLE_RATE,
    decode_key, decode_output_frame_header, validate_start,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Mutex, mpsc},
};

const MAX_CONTROL_LINE_BYTES: usize = 128 * 1024;
// Keep the proven LiveKit source capacity. Barge-in explicitly clears this
// queue; shrinking it causes the native SDK to publish silence under load.
const OUTPUT_QUEUE_MS: u32 = 1_000;

struct OutputState {
    generation: u64,
    source: NativeAudioSource,
}

fn control_socket_arg() -> anyhow::Result<PathBuf> {
    let mut args = env::args_os();
    let _program = args.next();
    ensure!(
        args.next().as_deref() == Some("--control-socket".as_ref()),
        "expected --control-socket"
    );
    let path = PathBuf::from(args.next().context("missing control socket path")?);
    ensure!(args.next().is_none(), "unexpected command arguments");
    ensure!(path.is_absolute(), "control socket path must be absolute");
    Ok(path)
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

async fn pump_local_audio(
    output: Arc<Mutex<OutputState>>,
    frame_diagnostic: bool,
) -> anyhow::Result<()> {
    let mut stdin = tokio::io::stdin();
    let mut first_frame = true;
    while let Some((generation, bytes)) = read_output_frame(&mut stdin).await? {
        let mut frame = AudioFrame::new(SAMPLE_RATE, CHANNELS, (bytes.len() / 2) as u32);
        for (sample, chunk) in frame.data.to_mut().iter_mut().zip(bytes.chunks_exact(2)) {
            *sample = i16::from_le_bytes([chunk[0], chunk[1]]);
        }
        let state = output.lock().await;
        if generation == state.generation {
            if first_frame && frame_diagnostic {
                eprintln!(
                    "matrix_rtc_media_output_frame_nonzero={}",
                    bytes.iter().any(|byte| *byte != 0)
                );
            }
            state.source.capture_frame(&frame).await?;
            if first_frame && frame_diagnostic {
                eprintln!("matrix_rtc_media_output_frame_captured=true");
            }
        }
        first_frame = false;
    }
    Ok(())
}

async fn run_started_session(
    mut control: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>,
) -> anyhow::Result<()> {
    let start = validate_start(read_control_line(&mut control).await?)?;
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
    let output = Arc::new(Mutex::new(OutputState {
        generation: 0,
        source,
    }));
    let frame_diagnostic = env::var_os("OPENCLAW_MATRIX_RTC_FRAME_DIAGNOSTIC").is_some();
    let mut local_audio = tokio::spawn(pump_local_audio(output.clone(), frame_diagnostic));

    loop {
        tokio::select! {
            message = read_control_line(&mut control) => match message? {
                ControlMessage::Key { participant_identity, index, key_base64 } => {
                    install_key(&key_provider, decode_key(participant_identity, index, key_base64)?)?;
                }
                ControlMessage::ClearOutput { generation } => {
                    let mut state = output.lock().await;
                    ensure!(generation > state.generation, "output generation must increase");
                    state.generation = generation;
                    state.source.clear_buffer();
                    drop(state);
                    send_event(&writer, ControlEvent::OutputCleared { generation }).await?;
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
                Some(RoomEvent::TrackSubscribed { track, participant, .. }) => {
                    let identity = participant.identity();
                    if !allowed.contains(identity.0.as_str()) {
                        anyhow::bail!("unexpected participant published media");
                    }
                    match track {
                        RemoteTrack::Audio(track) => {
                            let stdout = stdout.clone();
                            let fatal_tx = fatal_tx.clone();
                            tokio::spawn(async move {
                                if pump_remote_audio(track, stdout).await.is_err() {
                                    let _ = fatal_tx.send(()).await;
                                }
                            });
                        }
                        _ => anyhow::bail!("unsupported remote media track"),
                    }
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
            _ = fatal_rx.recv() => anyhow::bail!("remote audio stream failed"),
        }
    }

    local_audio.abort();
    room.close().await?;
    send_event(&writer, ControlEvent::Stopped).await?;
    Ok(())
}

async fn run_session(stream: UnixStream) -> anyhow::Result<()> {
    let (read_half, write_half) = stream.into_split();
    let control = BufReader::new(read_half);
    let writer = Arc::new(Mutex::new(write_half));
    send_event(&writer, ControlEvent::Ready).await?;

    let result = run_started_session(control, writer.clone()).await;
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
    let socket_path = control_socket_arg()?;
    ensure!(!socket_path.exists(), "control socket already exists");
    let listener = UnixListener::bind(&socket_path).context("failed to bind control socket")?;
    std::fs::set_permissions(&socket_path, Permissions::from_mode(0o600))?;

    let result = async {
        let (stream, _) = listener.accept().await?;
        run_session(stream).await
    }
    .await;

    if result.is_err() {
        // Never include tokens, keys, participant identities, or room identifiers in stderr.
        eprintln!("matrix_rtc_media_fatal=true");
    }
    let _ = std::fs::remove_file(&socket_path);
    result
}

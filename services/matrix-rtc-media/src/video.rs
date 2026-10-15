use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Context;
use futures_util::StreamExt;
use livekit::webrtc::{
    video_frame::{BoxVideoFrame, VideoFormatType, native::VideoFrameBufferExt},
    video_stream::native::NativeVideoStream,
};
use tokio::{io::AsyncWriteExt, net::UnixStream, sync::mpsc};

use crate::protocol::{VideoConfig, encode_video_frame_header};

pub struct VideoSample {
    frame: BoxVideoFrame,
    source: u32,
    timestamp_ms: u64,
}

/** Drain SDK frames continuously: video I/O or conversion must never back up its unbounded receiver. */
pub async fn pump_remote_video(
    track: livekit::track::RemoteVideoTrack,
    output: mpsc::Sender<VideoSample>,
    config: VideoConfig,
    source: u32,
) -> anyhow::Result<()> {
    let mut stream = NativeVideoStream::new(track.rtc_track());
    let mut sampled_at: Option<Instant> = None;
    while let Some(frame) = stream.next().await {
        if output.is_closed() { break; }
        let now = Instant::now();
        if sampled_at.is_some_and(|at| now.duration_since(at) < Duration::from_millis(config.interval_ms)) {
            continue;
        }
        if config.frame_bytes(frame.buffer.width(), frame.buffer.height()).is_none() { continue; }
        sampled_at = Some(now);
        let timestamp_ms = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
        // A single shared slot bounds all subscribed video tracks; drop rather than stall audio.
        let _ = output.try_send(VideoSample { frame, source, timestamp_ms });
    }
    stream.close();
    Ok(())
}

fn rotate_rgba(input: Vec<u8>, width: u32, height: u32, rotation: i32) -> (Vec<u8>, u32, u32) {
    if rotation == 0 { return (input, width, height); }
    let (out_width, out_height) = if rotation == 90 || rotation == 270 { (height, width) } else { (width, height) };
    let mut output = vec![0; input.len()];
    for y in 0..height {
        for x in 0..width {
            let (out_x, out_y) = match rotation {
                90 => (height - 1 - y, x),
                180 => (width - 1 - x, height - 1 - y),
                270 => (y, width - 1 - x),
                _ => unreachable!("SDK rotation enum"),
            };
            let source = ((y * width + x) * 4) as usize;
            let target = ((out_y * out_width + out_x) * 4) as usize;
            output[target..target + 4].copy_from_slice(&input[source..source + 4]);
        }
    }
    (output, out_width, out_height)
}

pub async fn pump_video_output(mut socket: UnixStream, mut input: mpsc::Receiver<VideoSample>, config: VideoConfig) -> anyhow::Result<()> {
    while let Some(sample) = input.recv().await {
        let source = sample.source;
        let timestamp_ms = sample.timestamp_ms;
        let (pixels, width, height) = tokio::task::spawn_blocking(move || {
            let width = sample.frame.buffer.width();
            let height = sample.frame.buffer.height();
            let bytes = config.frame_bytes(width, height).context("video frame exceeds limits")?;
            let buffer = sample.frame.buffer.to_i420();
            let mut pixels = vec![0_u8; bytes];
            VideoFrameBufferExt::to_argb(&buffer, VideoFormatType::RGBA, &mut pixels, width * 4, width as i32, height as i32);
            Ok::<_, anyhow::Error>(rotate_rgba(pixels, width, height, sample.frame.rotation as i32))
        }).await??;
        let header = encode_video_frame_header(timestamp_ms, width, height, source, u32::try_from(pixels.len())?);
        socket.write_all(&header).await?;
        socket.write_all(&pixels).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotations_preserve_pixels_without_lossy_resizing() {
        let input = vec![1, 0, 0, 255, 2, 0, 0, 255];
        let (pixels, width, height) = rotate_rgba(input.clone(), 2, 1, 90);
        assert_eq!((width, height), (1, 2));
        assert_eq!(pixels, input);
        let (pixels, width, height) = rotate_rgba(input.clone(), 2, 1, 180);
        assert_eq!((width, height), (2, 1));
        assert_eq!(pixels, [2, 0, 0, 255, 1, 0, 0, 255]);
        let (pixels, width, height) = rotate_rgba(input, 2, 1, 270);
        assert_eq!((width, height), (1, 2));
        assert_eq!(pixels, [2, 0, 0, 255, 1, 0, 0, 255]);
    }
}

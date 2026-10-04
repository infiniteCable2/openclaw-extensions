//! One owner for source submission, reversible gates, and generation changes.
//!
//! The native source retains its proven queue setting, without burst-prefilling.
//! A gate never clears already-submitted samples: the SDK has no consumption
//! cursor with which to recover them exactly. Native/network scheduling can
//! still delay an audible gate; submission is not a remote playout receipt.

use std::time::Duration;

use anyhow::Context;
use futures_util::future::BoxFuture;
use tokio::{
    sync::{mpsc, oneshot},
    time::{Instant, sleep_until, timeout},
};

use crate::protocol::OutputGate;

const FRAME_PERIOD: Duration = Duration::from_millis(10);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(2);

fn next_capture_deadline(scheduled: Instant, started: Instant, completed: Instant) -> Instant {
    // Rebase missed scheduler ticks before submission, preserving small-jitter
    // correction. A slow native callback has already paid the frame interval.
    let frame_start = if started >= scheduled + FRAME_PERIOD {
        started
    } else {
        scheduled
    };
    (frame_start + FRAME_PERIOD).max(completed)
}

pub enum OutputControl {
    Clear {
        generation: u64,
        acknowledged: oneshot::Sender<bool>,
    },
    Gate {
        gate: OutputGate,
        acknowledged: oneshot::Sender<()>,
    },
}

pub trait AudioSink: Send + Sync {
    fn capture<'a>(
        &'a self,
        bytes: &'a [u8],
        gate: OutputGate,
        diagnostic: bool,
    ) -> BoxFuture<'a, anyhow::Result<()>>;
    fn clear(&self);
}

pub async fn pump_local_audio<S: AudioSink>(
    source: S,
    mut output: mpsc::Receiver<(u64, Vec<u8>)>,
    mut controls: mpsc::Receiver<OutputControl>,
    frame_diagnostic: bool,
) -> anyhow::Result<()> {
    let mut generation = 0_u64;
    let mut gate = OutputGate::Normal;
    let mut pending: Option<Vec<u8>> = None;
    let mut next_capture_at = Instant::now();
    let mut first_frame = true;
    loop {
        tokio::select! {
            biased;
            command = controls.recv() => {
                match command.context("output control closed")? {
                    OutputControl::Clear { generation: next, acknowledged } => {
                        let accepted = next > generation;
                        if accepted {
                            generation = next;
                            pending = None;
                            source.clear();
                        }
                        let _ = acknowledged.send(accepted);
                    }
                    OutputControl::Gate { gate: next, acknowledged } => {
                        if gate == OutputGate::Paused && next != OutputGate::Paused {
                            next_capture_at = Instant::now();
                        }
                        gate = next;
                        // Retain pending and native audio on every reversible gate.
                        let _ = acknowledged.send(());
                    }
                }
            }
            frame = output.recv(), if pending.is_none() => {
                let Some((frame_generation, bytes)) = frame else { break; };
                if frame_generation == generation {
                    let now = Instant::now();
                    if now >= next_capture_at + FRAME_PERIOD {
                        // Fresh output after idle starts a fresh cadence.
                        next_capture_at = now;
                    }
                    pending = Some(bytes);
                }
            }
            _ = sleep_until(next_capture_at), if pending.is_some() && gate != OutputGate::Paused => {
                let bytes = pending.take().expect("capture requires a pending frame");
                // Do not race/drop this future against a gate: native capture can
                // have accepted PCM before its completion callback arrives.
                // On a stalled SDK callback, terminate the session. The native
                // source may already own these samples, so never retry/replay.
                let capture_started = Instant::now();
                timeout(CAPTURE_TIMEOUT, source.capture(&bytes, gate, frame_diagnostic && first_frame))
                    .await.context("native audio capture timed out")??;
                first_frame = false;
                // No catch-up bursts after scheduler stalls, pause, or slow capture.
                next_capture_at = next_capture_deadline(next_capture_at, capture_started, Instant::now());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::{
        sync::Notify,
        time::{advance, sleep, timeout},
    };

    #[derive(Default)]
    struct Record {
        frames: Vec<(Vec<u8>, OutputGate, Instant)>,
        clears: usize,
    }

    #[derive(Clone, Default)]
    struct FakeSink(Arc<Mutex<Record>>, Arc<Notify>);

    impl AudioSink for FakeSink {
        fn capture<'a>(
            &'a self,
            bytes: &'a [u8],
            gate: OutputGate,
            _: bool,
        ) -> BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async move {
                self.0
                    .lock()
                    .unwrap()
                    .frames
                    .push((bytes.to_vec(), gate, Instant::now()));
                self.1.notify_one();
                Ok(())
            })
        }
        fn clear(&self) {
            self.0.lock().unwrap().clears += 1;
        }
    }

    async fn gate(tx: &mpsc::Sender<OutputControl>, value: OutputGate) {
        let (acknowledged, ack) = oneshot::channel();
        tx.send(OutputControl::Gate {
            gate: value,
            acknowledged,
        })
        .await
        .unwrap();
        timeout(Duration::from_secs(1), ack).await.unwrap().unwrap();
    }

    async fn clear(tx: &mpsc::Sender<OutputControl>, generation: u64) -> bool {
        let (acknowledged, ack) = oneshot::channel();
        tx.send(OutputControl::Clear {
            generation,
            acknowledged,
        })
        .await
        .unwrap();
        timeout(Duration::from_secs(1), ack).await.unwrap().unwrap()
    }

    async fn wait_frames(sink: &FakeSink, count: usize) {
        timeout(Duration::from_secs(2), async {
            while sink.0.lock().unwrap().frames.len() < count {
                sink.1.notified().await;
            }
        })
        .await
        .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn false_candidate_pause_empty_resume_preserves_every_sample_in_order() {
        let sink = FakeSink::default();
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(sink.clone(), audio_rx, control_rx, false));
        audio_tx.send((0, vec![1; 480])).await.unwrap();
        wait_frames(&sink, 1).await;
        gate(&control_tx, OutputGate::Duck).await;
        audio_tx.send((0, vec![2; 480])).await.unwrap();
        wait_frames(&sink, 2).await;
        gate(&control_tx, OutputGate::Paused).await;
        for value in 3..=6 {
            audio_tx.send((0, vec![value; 480])).await.unwrap();
        }
        advance(Duration::from_millis(40)).await;
        assert_eq!(sink.0.lock().unwrap().frames.len(), 2);
        // Empty/rejected speech maps to normal, without advancing generation.
        gate(&control_tx, OutputGate::Normal).await;
        wait_frames(&sink, 6).await;
        {
            let record = sink.0.lock().unwrap();
            assert_eq!(record.clears, 0);
            assert_eq!(
                record
                    .frames
                    .iter()
                    .flat_map(|f| f.0.clone())
                    .collect::<Vec<_>>(),
                (1..=6)
                    .flat_map(|value| vec![value; 480])
                    .collect::<Vec<_>>()
            );
            assert_eq!(record.frames[1].1, OutputGate::Duck);
            assert!(record.frames[2..].iter().all(|f| f.1 == OutputGate::Normal));
        }
        drop(audio_tx);
        worker.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn only_confirmed_clear_discards_pending_and_old_generation_frames() {
        let sink = FakeSink::default();
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(sink.clone(), audio_rx, control_rx, false));
        gate(&control_tx, OutputGate::Paused).await;
        audio_tx.send((0, vec![1; 480])).await.unwrap();
        audio_tx.send((0, vec![2; 480])).await.unwrap();
        assert!(clear(&control_tx, 1).await);
        assert!(!clear(&control_tx, 1).await);
        audio_tx.send((0, vec![3; 480])).await.unwrap();
        audio_tx.send((1, vec![4; 480])).await.unwrap();
        gate(&control_tx, OutputGate::Normal).await;
        wait_frames(&sink, 1).await;
        assert_eq!(sink.0.lock().unwrap().frames[0].0, vec![4; 480]);
        assert_eq!(sink.0.lock().unwrap().clears, 1);
        drop(audio_tx);
        worker.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn queued_frames_are_paced_without_native_prefill_burst() {
        let sink = FakeSink::default();
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (_control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(sink.clone(), audio_rx, control_rx, false));
        for value in 0..4 {
            audio_tx.send((0, vec![value; 480])).await.unwrap();
        }
        wait_frames(&sink, 4).await;
        assert!(
            sink.0
                .lock()
                .unwrap()
                .frames
                .windows(2)
                .all(|pair| pair[1].2.duration_since(pair[0].2) >= FRAME_PERIOD)
        );
        drop(audio_tx);
        worker.await.unwrap().unwrap();
    }

    struct PendingCaptureSink {
        record: FakeSink,
        started: Mutex<Option<oneshot::Sender<()>>>,
        complete: Mutex<Option<oneshot::Receiver<()>>>,
    }

    impl AudioSink for PendingCaptureSink {
        fn capture<'a>(
            &'a self,
            bytes: &'a [u8],
            gate: OutputGate,
            diagnostic: bool,
        ) -> BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async move {
                self.record.capture(bytes, gate, diagnostic).await?;
                let started = self.started.lock().unwrap().take();
                let complete = self.complete.lock().unwrap().take();
                if let Some(started) = started {
                    let _ = started.send(());
                }
                if let Some(complete) = complete {
                    complete.await?;
                }
                Ok(())
            })
        }
        fn clear(&self) {
            self.record.clear();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn gate_waits_for_accepted_capture_instead_of_cancelling_and_replaying_it() {
        let record = FakeSink::default();
        let (started_tx, started_rx) = oneshot::channel();
        let (complete_tx, complete_rx) = oneshot::channel();
        let sink = PendingCaptureSink {
            record: record.clone(),
            started: Mutex::new(Some(started_tx)),
            complete: Mutex::new(Some(complete_rx)),
        };
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(sink, audio_rx, control_rx, false));
        audio_tx.send((0, vec![1; 480])).await.unwrap();
        timeout(Duration::from_secs(1), started_rx)
            .await
            .unwrap()
            .unwrap();
        let (acknowledged, mut ack) = oneshot::channel();
        control_tx
            .send(OutputControl::Gate {
                gate: OutputGate::Paused,
                acknowledged,
            })
            .await
            .unwrap();
        audio_tx.send((0, vec![2; 480])).await.unwrap();
        assert!(timeout(Duration::from_millis(20), &mut ack).await.is_err());
        complete_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), ack).await.unwrap().unwrap();
        assert_eq!(record.0.lock().unwrap().frames.len(), 1);
        gate(&control_tx, OutputGate::Normal).await;
        wait_frames(&record, 2).await;
        assert_eq!(
            record
                .0
                .lock()
                .unwrap()
                .frames
                .iter()
                .map(|f| f.0[0])
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(record.0.lock().unwrap().clears, 0);
        drop(audio_tx);
        worker.await.unwrap().unwrap();
    }

    #[test]
    fn cadence_absorbs_small_jitter_and_rebases_after_a_whole_missed_tick() {
        let start = Instant::now();
        assert_eq!(
            next_capture_deadline(start, start, start + Duration::from_millis(3)),
            start + FRAME_PERIOD
        );
        assert_eq!(
            next_capture_deadline(start, start, start + Duration::from_millis(25)),
            start + Duration::from_millis(25)
        );
        assert_eq!(
            next_capture_deadline(start, start, start + FRAME_PERIOD),
            start + FRAME_PERIOD
        );
        let after_stall = start + Duration::from_secs(1);
        assert_eq!(
            next_capture_deadline(start, after_stall, after_stall),
            after_stall + FRAME_PERIOD
        );
        let mut scheduled = start;
        for _ in 0..1_000 {
            let started = scheduled + Duration::from_millis(1);
            scheduled = next_capture_deadline(scheduled, started, started);
        }
        assert_eq!(scheduled.duration_since(start), Duration::from_secs(10));
    }

    struct SlowSink(FakeSink);

    impl AudioSink for SlowSink {
        fn capture<'a>(
            &'a self,
            bytes: &'a [u8],
            gate: OutputGate,
            diagnostic: bool,
        ) -> BoxFuture<'a, anyhow::Result<()>> {
            Box::pin(async move {
                self.0.capture(bytes, gate, diagnostic).await?;
                sleep(Duration::from_millis(25)).await;
                Ok(())
            })
        }
        fn clear(&self) {
            self.0.clear();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn delayed_native_callbacks_preserve_order_without_catchup_bursts() {
        let record = FakeSink::default();
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (_control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(
            SlowSink(record.clone()),
            audio_rx,
            control_rx,
            false,
        ));
        for value in 0..4 {
            audio_tx.send((0, vec![value; 480])).await.unwrap();
        }
        drop(audio_tx);
        worker.await.unwrap().unwrap();
        let result = record.0.lock().unwrap();
        assert_eq!(
            result.frames.iter().map(|f| f.0[0]).collect::<Vec<_>>(),
            vec![0, 1, 2, 3]
        );
        assert!(result.frames.windows(2).all(|pair| {
            let gap = pair[1].2.duration_since(pair[0].2);
            gap >= Duration::from_millis(25) && gap < Duration::from_millis(35)
        }));
        assert_eq!(result.clears, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_capture_fails_closed_without_replay_or_unbounded_gate_ack() {
        let record = FakeSink::default();
        let (started_tx, started_rx) = oneshot::channel();
        let (_complete_tx, complete_rx) = oneshot::channel();
        let sink = PendingCaptureSink {
            record: record.clone(),
            started: Mutex::new(Some(started_tx)),
            complete: Mutex::new(Some(complete_rx)),
        };
        let (audio_tx, audio_rx) = mpsc::channel(4);
        let (control_tx, control_rx) = mpsc::channel(4);
        let worker = tokio::spawn(pump_local_audio(sink, audio_rx, control_rx, false));
        audio_tx.send((0, vec![1; 480])).await.unwrap();
        started_rx.await.unwrap();
        let (acknowledged, ack) = oneshot::channel();
        control_tx
            .send(OutputControl::Gate {
                gate: OutputGate::Paused,
                acknowledged,
            })
            .await
            .unwrap();
        audio_tx.send((0, vec![2; 480])).await.unwrap();
        let error = worker.await.unwrap().unwrap_err();
        assert_eq!(error.to_string(), "native audio capture timed out");
        assert!(ack.await.is_err());
        assert_eq!(record.0.lock().unwrap().frames.len(), 1);
        assert_eq!(record.0.lock().unwrap().clears, 0);
    }
}

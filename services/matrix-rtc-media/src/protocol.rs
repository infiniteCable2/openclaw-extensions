use std::collections::BTreeSet;

use anyhow::{Context, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};

pub const SAMPLE_RATE: u32 = 24_000;
pub const CHANNELS: u32 = 1;
pub const FRAME_SAMPLES: usize = 240;
const MAX_JWT_BYTES: usize = 16 * 1024;
const MAX_IDENTITY_BYTES: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlMessage {
    Start {
        url: String,
        token: String,
        encrypted: bool,
        allowed_remote_identities: Vec<String>,
        initial_keys: Vec<WireKey>,
    },
    Key {
        participant_identity: String,
        index: u8,
        key_base64: String,
    },
    Stop {},
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireKey {
    pub participant_identity: String,
    pub index: u8,
    pub key_base64: String,
}

#[derive(Debug)]
pub struct SessionStart {
    pub url: String,
    pub token: String,
    pub encrypted: bool,
    pub allowed_remote_identities: BTreeSet<String>,
    pub initial_keys: Vec<DecodedKey>,
}

#[derive(Clone, Debug)]
pub struct DecodedKey {
    pub participant_identity: String,
    pub index: u8,
    pub key: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ControlEvent<'a> {
    Ready,
    Connected,
    Stopped,
    Fatal { code: &'a str },
}

fn validate_identity(value: String) -> anyhow::Result<String> {
    let value = value.trim().to_owned();
    ensure!(!value.is_empty(), "participant identity is empty");
    ensure!(
        value.len() <= MAX_IDENTITY_BYTES,
        "participant identity is too long"
    );
    ensure!(
        !value.chars().any(char::is_control),
        "participant identity contains controls"
    );
    Ok(value)
}

pub fn decode_key(identity: String, index: u8, encoded: String) -> anyhow::Result<DecodedKey> {
    let participant_identity = validate_identity(identity)?;
    let key = STANDARD
        .decode(encoded.trim())
        .context("invalid media key encoding")?;
    ensure!(key.len() == 16, "media key must be exactly 16 bytes");
    Ok(DecodedKey {
        participant_identity,
        index,
        key,
    })
}

pub fn validate_start(message: ControlMessage) -> anyhow::Result<SessionStart> {
    let ControlMessage::Start {
        url,
        token,
        encrypted,
        allowed_remote_identities,
        initial_keys,
    } = message
    else {
        anyhow::bail!("first control message must start the session");
    };

    let url = url.trim().to_owned();
    ensure!(url.starts_with("wss://"), "LiveKit URL must use wss");
    ensure!(
        !token.is_empty() && token.len() <= MAX_JWT_BYTES,
        "LiveKit token is invalid"
    );
    ensure!(
        allowed_remote_identities.len() == 1,
        "exactly one remote identity is required"
    );
    let allowed_remote_identities = allowed_remote_identities
        .into_iter()
        .map(validate_identity)
        .collect::<anyhow::Result<BTreeSet<_>>>()?;
    ensure!(
        allowed_remote_identities.len() == 1,
        "remote identity must be unique"
    );

    let initial_keys = initial_keys
        .into_iter()
        .map(|key| decode_key(key.participant_identity, key.index, key.key_base64))
        .collect::<anyhow::Result<Vec<_>>>()?;
    if encrypted {
        ensure!(
            !initial_keys.is_empty(),
            "encrypted sessions require an initial media key"
        );
    } else {
        ensure!(
            initial_keys.is_empty(),
            "unencrypted sessions cannot receive media keys"
        );
    }

    Ok(SessionStart {
        url,
        token,
        encrypted,
        allowed_remote_identities,
        initial_keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start_json(remote: &[&str], encrypted: bool, keys: &str) -> String {
        format!(
            r#"{{"type":"start","url":"wss://rtc.example.test/livekit/sfu","token":"jwt","encrypted":{encrypted},"allowed_remote_identities":{},"initial_keys":{keys}}}"#,
            serde_json::to_string(remote).unwrap()
        )
    }

    #[test]
    fn accepts_one_exact_remote_and_a_16_byte_key() {
        let encoded = STANDARD.encode([7_u8; 16]);
        let raw = start_json(
            &["remote"],
            true,
            &format!(r#"[{{"participant_identity":"local","index":0,"key_base64":"{encoded}"}}]"#),
        );
        let parsed = serde_json::from_str(&raw).unwrap();
        let start = validate_start(parsed).unwrap();
        assert_eq!(start.allowed_remote_identities.len(), 1);
        assert_eq!(start.initial_keys[0].key, vec![7_u8; 16]);
    }

    #[test]
    fn rejects_broad_remote_access() {
        let raw = start_json(&["first", "second"], false, "[]");
        let parsed = serde_json::from_str(&raw).unwrap();
        assert!(validate_start(parsed).is_err());
    }

    #[test]
    fn rejects_plaintext_websocket_and_unknown_fields() {
        let raw = start_json(&["remote"], false, "[]").replace("wss://", "ws://");
        let parsed = serde_json::from_str(&raw).unwrap();
        assert!(validate_start(parsed).is_err());
        assert!(
            serde_json::from_str::<ControlMessage>(r#"{"type":"stop","unexpected":true}"#).is_err()
        );
    }
}

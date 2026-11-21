import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { textResult } from "openclaw/plugin-sdk/tool-results";

const photoLimit = 700 * 1024;
const waveHeaderBytes = 44;
const waveBytesPerSecond = 32_000;
const mediaDirectory = "echo-capture";

const saveWithCommitGuard: (
  bytes: Buffer,
  mime: string,
  subdir: string,
  limit: number,
  name: string,
  hint: undefined,
  options: { assertCommitAllowed: () => void },
) => ReturnType<typeof saveMediaBuffer> = saveMediaBuffer;

export function decodeEchoCapture(
  action: "capture_audio" | "capture_photo",
  payload: unknown,
  durationSeconds?: unknown,
) {
  const photo = action === "capture_photo";
  const mime = photo ? "image/jpeg" : "audio/wav";
  let limit = photoLimit;
  if (!photo) {
    if (
      typeof durationSeconds !== "number" ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 1 ||
      durationSeconds > 10
    ) {
      throw new Error("Invalid Echo recording duration");
    }
    limit = waveHeaderBytes + durationSeconds * waveBytesPerSecond;
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    !("mime" in payload) ||
    payload.mime !== mime ||
    !("dataBase64" in payload) ||
    typeof payload.dataBase64 !== "string"
  ) {
    throw new Error("Invalid Echo capture result");
  }
  const encoded = payload.dataBase64;
  if (!encoded || encoded.length > 4 * Math.ceil(limit / 3)) {
    throw new Error("Echo capture exceeds its byte limit");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length > limit ||
    !(photo ? isJpeg(bytes) : bytes.length === limit && isWave(bytes))
  ) {
    throw new Error("Invalid Echo capture bytes");
  }
  return { bytes, mime, limit, filename: photo ? "echo-photo.jpg" : "echo-recording.wav" };
}

function isJpeg(bytes: Buffer) {
  return (
    bytes.length > 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[bytes.length - 2] === 0xff &&
    bytes[bytes.length - 1] === 0xd9
  );
}

function isWave(bytes: Buffer) {
  return (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.readUInt32LE(4) === bytes.length - 8 &&
    bytes.toString("ascii", 8, 16) === "WAVEfmt " &&
    bytes.readUInt32LE(16) === 16 &&
    bytes.readUInt16LE(20) === 1 &&
    bytes.readUInt16LE(22) === 1 &&
    bytes.readUInt32LE(24) === 16_000 &&
    bytes.readUInt32LE(28) === waveBytesPerSecond &&
    bytes.readUInt16LE(32) === 2 &&
    bytes.readUInt16LE(34) === 16 &&
    bytes.toString("ascii", 36, 40) === "data" &&
    bytes.readUInt32LE(40) === bytes.length - waveHeaderBytes
  );
}

export async function saveEchoCapture(
  api: OpenClawPluginApi,
  device: string,
  capture: ReturnType<typeof decodeEchoCapture>,
  isCurrent: () => boolean,
) {
  const media = api.runtime.channel.media;
  if (
    !("deleteMediaBuffer" in media) ||
    typeof media.deleteMediaBuffer !== "function" ||
    !isCurrent()
  ) {
    throw new Error("The private Echo capture store is unavailable");
  }
  let commitGuardInvoked = false;
  const assertCommitAllowed = () => {
    if (!isCurrent()) {
      throw new Error("Echo capture permission is no longer current");
    }
    commitGuardInvoked = true;
  };
  const saved = await saveWithCommitGuard(
    capture.bytes,
    capture.mime,
    mediaDirectory,
    capture.limit,
    capture.filename,
    undefined,
    { assertCommitAllowed },
  );
  if (!commitGuardInvoked || !isCurrent()) {
    await media.deleteMediaBuffer(saved.id, mediaDirectory);
    throw new Error("Echo capture permission is no longer current");
  }
  return textResult(`FILE:${saved.path}`, {
    ok: true,
    device,
    path: saved.path,
    mime: capture.mime,
    size: saved.size,
    media: { mediaUrl: saved.path, outbound: false },
  });
}

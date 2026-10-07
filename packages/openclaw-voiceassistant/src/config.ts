export type AgentVoiceProfile = {
  toolPolicy: "none" | "safe-read-only" | "owner";
  agentThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  speakCommentary: boolean;
};

export type VoiceassistantConfig = {
  nodeId: string;
  agentId: string;
  transcriptionProvider: string;
  providers: Record<string, Record<string, unknown>>;
  responseStreaming: "off" | "sentence";
  pollIntervalMs: number;
  profile: AgentVoiceProfile;
  waitingAudio?: {
    filePath: string;
    startDelayMs: number;
    resumeDelayMs: number;
    volume: number;
  };
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function parseVoiceassistantConfig(value: unknown): VoiceassistantConfig {
  const raw = record(value);
  const nodeId = raw.nodeId;
  const agentId = raw.agentId;
  const transcriptionProvider = raw.transcriptionProvider;
  if (typeof nodeId !== "string" || !/^[a-f0-9]{64}$/.test(nodeId)) {
    throw new Error("voiceassistant requires an exact 64-character nodeId");
  }
  if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId)) {
    throw new Error("voiceassistant requires an exact agentId");
  }
  if (typeof transcriptionProvider !== "string" || !transcriptionProvider.trim()) {
    throw new Error("voiceassistant requires a transcriptionProvider");
  }
  const profiles = record(raw.agentProfiles);
  const profile = record(profiles[agentId]);
  const toolPolicy = profile.toolPolicy ?? "safe-read-only";
  if (!["none", "safe-read-only", "owner"].includes(String(toolPolicy))) {
    throw new Error("invalid voiceassistant toolPolicy");
  }
  const agentThinkingLevel = profile.agentThinkingLevel;
  if (agentThinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high"].includes(String(agentThinkingLevel))) {
    throw new Error("invalid voiceassistant agentThinkingLevel");
  }
  const responseStreaming = raw.responseStreaming ?? "sentence";
  if (responseStreaming !== "off" && responseStreaming !== "sentence") {
    throw new Error("invalid voiceassistant responseStreaming");
  }
  const speakCommentary = profile.speakCommentary === true;
  if (speakCommentary && responseStreaming !== "sentence") {
    throw new Error("voiceassistant commentary requires sentence streaming");
  }
  const pollIntervalMs = raw.pollIntervalMs ?? 500;
  if (!Number.isInteger(pollIntervalMs) || Number(pollIntervalMs) < 250 || Number(pollIntervalMs) > 2000) {
    throw new Error("invalid voiceassistant pollIntervalMs");
  }
  const providers = record(raw.providers);
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
      throw new Error("invalid voiceassistant provider options");
    }
  }
  let waitingAudio: VoiceassistantConfig["waitingAudio"];
  if (raw.waitingAudio !== undefined) {
    const waiting = record(raw.waitingAudio);
    if (typeof waiting.filePath !== "string" || !waiting.filePath.startsWith("/") ||
      !Number.isInteger(waiting.startDelayMs) || Number(waiting.startDelayMs) < 0 ||
      !Number.isInteger(waiting.resumeDelayMs) || Number(waiting.resumeDelayMs) < 0 ||
      typeof waiting.volume !== "number" || waiting.volume < 0 || waiting.volume > 1) {
      throw new Error("invalid voiceassistant waitingAudio");
    }
    waitingAudio = {
      filePath: waiting.filePath,
      startDelayMs: Number(waiting.startDelayMs),
      resumeDelayMs: Number(waiting.resumeDelayMs),
      volume: waiting.volume,
    };
  }
  return {
    nodeId,
    agentId,
    transcriptionProvider: transcriptionProvider.trim(),
    providers: providers as Record<string, Record<string, unknown>>,
    responseStreaming,
    pollIntervalMs: Number(pollIntervalMs),
    profile: {
      toolPolicy: toolPolicy as AgentVoiceProfile["toolPolicy"],
      ...(agentThinkingLevel ? { agentThinkingLevel: agentThinkingLevel as AgentVoiceProfile["agentThinkingLevel"] } : {}),
      speakCommentary,
    },
    ...(waitingAudio ? { waitingAudio } : {}),
  };
}

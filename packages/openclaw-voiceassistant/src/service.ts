import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawPluginApi, OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  prepareMeetingAgentRealtimeEngine,
  startMeetingAgentRealtimeEngine,
  type MeetingAgentRealtimePreparation,
  type MeetingRealtimeAudioEngineHandle,
  type MeetingRealtimeAudioTransport,
  type MeetingRealtimeEngineConfig,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { VoiceassistantConfig } from "./config.js";
import { VOICEASSISTANT_COMMAND } from "./node-policy.js";

const PLATFORM = {
  id: "voiceassistant",
  displayName: "Voiceassistant",
  logScope: "voiceassistant",
  agentConsult: {
    surface: "voiceassistant",
    userLabel: "speaker",
    assistantLabel: "assistant",
    questionSourceLabel: "live voiceassistant audio",
    workingResponseLabel: "speaker",
    extraSystemPrompt:
      "You are speaking through a paired voiceassistant device. Match the speaker's language and keep spoken replies concise. The device identifies its assigned agent, not the physical speaker; do not infer a human identity from pairing alone.",
  },
  session: {
    idPrefix: "voiceassistant",
    participantIdentity: (transport: string) => transport,
  },
} as const;

type NodeStatus = {
  wakeSequence: number;
  muted: boolean;
  listening: boolean;
  active: boolean;
  persistent: boolean;
};

type ActiveSession = {
  engine: MeetingRealtimeAudioEngineHandle;
  preparation: MeetingAgentRealtimePreparation;
  startedAt: number;
};

function payload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("voiceassistant node response is not an object");
  }
  const outer = value as Record<string, unknown>;
  if (outer.ok === false) {
    throw new Error("voiceassistant node rejected the command");
  }
  const inner = outer.payload ?? outer;
  if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
    throw new Error("voiceassistant node payload is malformed");
  }
  return inner as Record<string, unknown>;
}

function status(value: unknown): NodeStatus {
  const raw = payload(value);
  if (!Number.isSafeInteger(raw.wakeSequence) || Number(raw.wakeSequence) < 0 ||
    typeof raw.muted !== "boolean" || typeof raw.listening !== "boolean" ||
    typeof raw.active !== "boolean" || typeof raw.persistent !== "boolean") {
    throw new Error("voiceassistant node status is malformed");
  }
  return {
    wakeSequence: Number(raw.wakeSequence),
    muted: raw.muted,
    listening: raw.listening,
    active: raw.active,
    persistent: raw.persistent,
  };
}

export class VoiceassistantService {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private active: ActiveSession | undefined;
  private lastWakeSequence = 0;
  private nextPersistentAttemptAt = 0;
  private lastUnavailableLogAt = 0;
  private lastUnavailableClass = "";

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly context: OpenClawPluginServiceContext,
    private readonly config: VoiceassistantConfig,
  ) {
    if (!context.invokeNode) {
      throw new Error("voiceassistant requires service-owned node invocation");
    }
  }

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
    await this.starting;
    await this.closeSession();
  }

  private async invoke(
    params: Record<string, unknown>, timeoutMs = 2_000, allowAfterStop = false,
  ): Promise<Record<string, unknown>> {
    return payload(await this.context.invokeNode!({
      nodeId: this.config.nodeId,
      command: VOICEASSISTANT_COMMAND,
      params,
      timeoutMs,
      sessionKey: `agent:${this.config.agentId}:main`,
      ...(!allowAfterStop ? { signal: this.abort.signal } : {}),
    }));
  }

  async deviceCommand(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.abort.signal.aborted) {
      throw new Error("voiceassistant service is stopping");
    }
    return await this.invoke(params, 5_000);
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.poll();
        this.lastUnavailableClass = "";
      } catch (error) {
        const errorClass = error instanceof Error ? error.name : "Error";
        const now = Date.now();
        if (this.lastUnavailableClass !== errorClass || now - this.lastUnavailableLogAt >= 30_000) {
          this.context.logger.warn(`voiceassistant poll unavailable: ${errorClass}`);
          this.lastUnavailableClass = errorClass;
          this.lastUnavailableLogAt = now;
        }
        if (this.active) {
          await this.closeSession().catch(() => undefined);
        }
      }
      try {
        await sleep(this.config.pollIntervalMs, undefined, { signal: this.abort.signal });
      } catch {
        break;
      }
    }
  }

  private async poll(): Promise<void> {
    const current = status(await this.invoke({ action: "status" }));
    if (current.wakeSequence < this.lastWakeSequence) {
      this.lastWakeSequence = 0; // Pi restarted; its monotonic wake counter reset.
    }
    if (this.active) {
      this.lastWakeSequence = current.wakeSequence;
      if (!current.active || current.muted || !current.listening ||
        this.active.engine.getHealth().bridgeClosed ||
        Date.now() - this.active.startedAt > 30 * 60_000) {
        await this.closeSession();
      }
      return;
    }
    if (this.starting) {
      return;
    }
    if (current.active) {
      // A Gateway restart must not inherit a stale bridge or old audio.
      await this.invoke({ action: "stop" }, 5_000);
      this.lastWakeSequence = current.wakeSequence;
      return;
    }
    if (current.muted || !current.listening ||
      (!current.persistent && current.wakeSequence <= this.lastWakeSequence) ||
      (current.persistent && Date.now() < this.nextPersistentAttemptAt)) {
      return;
    }
    this.lastWakeSequence = current.wakeSequence;
    this.starting = this.openSession()
      .catch((error) => {
        if (current.persistent) {
          this.nextPersistentAttemptAt = Date.now() + 5_000;
        }
        this.context.logger.warn(`voiceassistant session setup failed: ${error instanceof Error ? error.name : "Error"}`);
      })
      .finally(() => { this.starting = undefined; });
  }

  private engineConfig(): MeetingRealtimeEngineConfig {
    return {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "agent",
        agentId: this.config.agentId,
        transcriptionProvider: this.config.transcriptionProvider,
        responseStreaming: this.config.responseStreaming,
        providers: this.config.providers,
        ...(this.config.waitingAudio ? { waitingAudio: this.config.waitingAudio } : {}),
      },
    };
  }

  private async openSession(): Promise<void> {
    let preparation: MeetingAgentRealtimePreparation | undefined;
    let transport: MeetingRealtimeAudioTransport | undefined;
    let bridgeId: string | undefined;
    let keepListening: ReturnType<typeof setInterval> | undefined;
    try {
      const firstHold = await this.invoke({ action: "holdListening" });
      if (firstHold.held !== true) {
        return;
      }
      // Readiness may take longer than the Pi's local listening window.
      keepListening = setInterval(() => {
        if (!this.abort.signal.aborted) {
          void this.invoke({ action: "holdListening" }).catch(() => undefined);
        }
      }, 4_000);
      const config = this.engineConfig();
      const ttsContext = { agentId: this.config.agentId, channelId: "voiceassistant" };
      const runtime = {
        ...this.api.runtime,
        nodes: {
          ...this.api.runtime.nodes,
          invoke: async (request: Parameters<typeof this.api.runtime.nodes.invoke>[0]) =>
            await this.context.invokeNode!(request),
        },
      };
      preparation = await prepareMeetingAgentRealtimeEngine({
        config, fullConfig: this.context.config, runtime, ttsContext,
        signal: this.abort.signal,
      });
      if (keepListening) {
        clearInterval(keepListening);
        keepListening = undefined;
      }
      this.abort.signal.throwIfAborted();
      const lastHold = await this.invoke({ action: "holdListening" });
      if (lastHold.held !== true) {
        return;
      }
      const started = await this.invoke({ action: "start" }, 5_000);
      if (typeof started.bridgeId !== "string" || !/^[a-f0-9]{32}$/.test(started.bridgeId)) {
        throw new Error("voiceassistant bridge start was not confirmed");
      }
      if (typeof started.outputGeneration !== "number" ||
        !Number.isSafeInteger(started.outputGeneration) || started.outputGeneration < 0) {
        throw new Error("voiceassistant bridge output generation was not confirmed");
      }
      bridgeId = started.bridgeId;
      const activeBridgeId = started.bridgeId;
      let lastActivity = "";
      let activityQueue = Promise.resolve();
      const onActivity = (activity: "listening" | "sensing" | "hearing" | "processing" | "speaking") => {
        if (activity === lastActivity || this.abort.signal.aborted) {
          return;
        }
        lastActivity = activity;
        activityQueue = activityQueue.then(async () => {
          await this.invoke({ action: "setActivity", bridgeId: activeBridgeId, activity }, 2_000);
        }).catch(() => undefined);
      };
      transport = createNodeMeetingRealtimeAudioTransport({
        runtime, nodeId: this.config.nodeId, bridgeId,
        logger: this.context.logger, commandName: VOICEASSISTANT_COMMAND,
        logScope: "voiceassistant", logPrefix: "node", audioFormat: "pcm16-24khz",
        initialOutputGeneration: started.outputGeneration,
      });
      const bindings = createMeetingRealtimeEngineBindings({
        platform: PLATFORM,
        config: { realtime: {
          agentId: this.config.agentId,
          toolPolicy: this.config.profile.toolPolicy,
          // The Pi can control only itself; do not change the caller's broader
          // safe-read-only voice profile just to expose this one scoped tool.
          additionalToolsAllow: ["voiceassistant_device"],
          agentThinkingLevel: this.config.profile.agentThinkingLevel,
          speakCommentary: this.config.profile.speakCommentary,
        } },
        fullConfig: this.context.config, runtime, logger: this.context.logger,
      });
      const engine = await startMeetingAgentRealtimeEngine({
        config, fullConfig: this.context.config, runtime,
        platform: bindings.platform, meetingSessionId: randomUUID(),
        requesterSessionKey: `agent:${this.config.agentId}:main`,
        ttsContext, transport, logger: this.context.logger,
        consultAgent: bindings.consultAgent,
        onActivity,
      });
      onActivity("listening");
      this.active = { engine, preparation, startedAt: Date.now() };
      preparation = undefined;
      transport = undefined;
      bridgeId = undefined;
    } finally {
      if (keepListening) {
        clearInterval(keepListening);
      }
      if (transport) {
        await transport.stop().catch(() => undefined);
      } else if (bridgeId) {
        await this.invoke({ action: "stop", bridgeId }, 5_000, true).catch(() => undefined);
      }
      await preparation?.release();
    }
  }

  private async closeSession(): Promise<void> {
    const session = this.active;
    this.active = undefined;
    if (!session) {
      return;
    }
    try {
      await session.engine.stop();
    } finally {
      await session.preparation.release();
    }
  }
}

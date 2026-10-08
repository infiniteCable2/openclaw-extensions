import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  startEngine: vi.fn(),
  createTransport: vi.fn(),
  createBindings: vi.fn(),
  stopEngine: vi.fn(),
  release: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", () => ({
  prepareMeetingAgentRealtimeEngine: mocks.prepare,
  startMeetingAgentRealtimeEngine: mocks.startEngine,
  createNodeMeetingRealtimeAudioTransport: mocks.createTransport,
  createMeetingRealtimeEngineBindings: mocks.createBindings,
}));

import { parseVoiceassistantConfig } from "./config.js";
import { VoiceassistantService } from "./service.js";

const nodeId = "a".repeat(64);
const bridgeId = "b".repeat(32);

describe("voiceassistant service admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepare.mockResolvedValue({ release: mocks.release });
    mocks.createTransport.mockReturnValue({ stop: vi.fn(async () => undefined) });
    mocks.createBindings.mockReturnValue({
      platform: { displayName: "Voiceassistant", logScope: "voiceassistant", sessionIdPrefix: "voiceassistant" },
      consultAgent: vi.fn(),
    });
    mocks.startEngine.mockResolvedValue({
      stop: mocks.stopEngine,
      getHealth: () => ({ bridgeClosed: false }),
    });
    mocks.stopEngine.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined);
  });

  it("starts only for a new button wake, then closes on mute", async () => {
    let wakeSequence = 0;
    let muted = false;
    let active = false;
    const invokeNode = vi.fn(async ({ params }: { params: { action: string } }) => {
      switch (params.action) {
        case "status": return { payload: { wakeSequence, muted, listening: !muted, active, persistent: false } };
        case "holdListening": return { payload: { held: !muted } };
        case "start": active = true; return { payload: { bridgeId, outputGeneration: 3 } };
        case "stop": active = false; return { payload: { closed: true } };
        default: throw new Error("unexpected media command");
      }
    });
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
      agentProfiles: { steffen: { agentThinkingLevel: "off", speakCommentary: true } },
      waitingAudio: {
        filePath: "/var/lib/openclaw/media/waiting.wav",
        startDelayMs: 800,
        resumeDelayMs: 800,
        volume: 0.2,
      },
    });
    const api = { runtime: { nodes: { invoke: vi.fn() } } } as never;
    const context = {
      config: {}, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, invokeNode,
    } as never;
    const service = new VoiceassistantService(api, context, config);
    const poll = (service as unknown as { poll(): Promise<void> }).poll.bind(service);
    await poll();
    expect(mocks.prepare).not.toHaveBeenCalled();
    wakeSequence = 1;
    await poll();
    await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledOnce());
    expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({
        realtime: expect.objectContaining({ waitingAudio: config.waitingAudio }),
      }),
    }));
    expect(mocks.createTransport).toHaveBeenCalledWith(expect.objectContaining({
      initialOutputGeneration: 3,
    }));
    expect(mocks.createBindings).toHaveBeenCalledWith(expect.objectContaining({
      config: { realtime: expect.objectContaining({
        agentId: "steffen", agentThinkingLevel: "off", speakCommentary: true,
        toolPolicy: "safe-read-only",
      }) },
    }));
    await poll();
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    muted = true;
    await poll();
    expect(mocks.stopEngine).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    await service.stop();
  });

  it("reopens a continuous session after bridge loss without another button press", async () => {
    let active = false;
    let bridgeClosed = false;
    mocks.startEngine.mockImplementation(async () => ({
      stop: mocks.stopEngine,
      getHealth: () => ({ bridgeClosed }),
    }));
    const invokeNode = vi.fn(async ({ params }: { params: { action: string } }) => {
      switch (params.action) {
        case "status": return { payload: {
          wakeSequence: 1, muted: false, listening: true, active, persistent: true,
        } };
        case "holdListening": return { payload: { held: true } };
        case "start": active = true; return { payload: { bridgeId, outputGeneration: 4 } };
        case "stop": active = false; return { payload: { closed: true } };
        case "setActivity": return { payload: { activitySet: true } };
        default: throw new Error("unexpected media command");
      }
    });
    const config = parseVoiceassistantConfig({
      nodeId, agentId: "steffen", transcriptionProvider: "local-media",
    });
    const api = { runtime: { nodes: { invoke: vi.fn() } } } as never;
    const context = {
      config: {}, logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() }, invokeNode,
    } as never;
    const service = new VoiceassistantService(api, context, config);
    const poll = (service as unknown as { poll(): Promise<void> }).poll.bind(service);
    await poll();
    await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledTimes(1));
    bridgeClosed = true;
    await poll(); // close the unhealthy engine
    await poll(); // clear its stale node bridge
    bridgeClosed = false;
    await poll();
    await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledTimes(2));
    await service.stop();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  startEngine: vi.fn(),
  createTransport: vi.fn(),
  createBindings: vi.fn(),
  stopEngine: vi.fn(),
  release: vi.fn(),
  prepareInput: vi.fn(),
  releaseInput: vi.fn(),
  nativeInput: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/meeting-runtime", () => ({
  prepareMeetingAgentRealtimeEngine: mocks.prepare,
  startMeetingAgentRealtimeEngine: mocks.startEngine,
  createNodeMeetingRealtimeAudioTransport: mocks.createTransport,
  createMeetingRealtimeEngineBindingsV2: mocks.createBindings,
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
    mocks.createBindings.mockImplementation((params) => ({
      platform: {
        displayName: "Voiceassistant",
        logScope: "voiceassistant",
        sessionIdPrefix: "voiceassistant",
      },
      consultAgent: vi.fn(),
      nativeInput: mocks.nativeInput,
      connectionPresentation: params.connectionPresentation,
    }));
    mocks.prepareInput.mockImplementation(async (request) => ({
      agentId: request.agentId,
      conversationId: request.conversationId,
      sessionKey: `agent:${request.agentId}:voiceassistant:group:device-conversation`,
      inputSource: { version: 1, admitInput: vi.fn() },
      assertCurrent: vi.fn(),
      assertInputCurrent: vi.fn(),
      release: mocks.releaseInput,
      connectionPresentation: {
        kind: "assistant",
        channel: "voiceassistant",
        label: request.label,
      },
    }));
    mocks.startEngine.mockResolvedValue({
      stop: mocks.stopEngine,
      getHealth: () => ({ bridgeClosed: false }),
    });
    mocks.stopEngine.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined);
  });

  it("requires native device admission rather than silently using legacy consult", () => {
    const config = parseVoiceassistantConfig({
      nodeId,
      agentId: "example_owner",
      transcriptionProvider: "local-media",
    });
    expect(
      () =>
        new VoiceassistantService(
          {} as never,
          {
            invokeNode: vi.fn(),
          } as never,
          config,
        ),
    ).toThrow("native device conversation admission");
    expect(mocks.createBindings).not.toHaveBeenCalled();
  });

  it.each([
    { result: { bridgeId: "invalid", outputGeneration: 1 }, error: "bridge start", stopped: false },
    { result: { bridgeId, outputGeneration: -1 }, error: "output generation", stopped: true },
  ])(
    "admits no input before the actual node bridge response is valid ($error)",
    async ({ result, error, stopped }) => {
      const invokeNode = vi.fn(async ({ params }: { params: { action: string } }) => {
        if (params.action === "holdListening") return { payload: { held: true } };
        if (params.action === "start") return { payload: result };
        if (params.action === "stop") return { payload: { closed: true } };
        throw new Error("Unexpected node action");
      });
      const config = parseVoiceassistantConfig({
        nodeId,
        agentId: "example_owner",
        transcriptionProvider: "local-media",
      });
      const service = new VoiceassistantService(
        { runtime: { nodes: {} } } as never,
        {
          config: {},
          logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
          invokeNode,
          prepareNodeConversationInput: mocks.prepareInput,
        } as never,
        config,
      );
      await expect(
        (service as unknown as { openSession(): Promise<void> }).openSession(),
      ).rejects.toThrow(error);
      expect(mocks.prepareInput).not.toHaveBeenCalled();
      expect(mocks.startEngine).not.toHaveBeenCalled();
      expect(invokeNode.mock.calls.some(([request]) => request.params.action === "stop")).toBe(
        stopped,
      );
      await service.stop();
    },
  );

  it("starts only for a new button wake, then closes on mute", async () => {
    let wakeSequence = 0;
    let muted = false;
    let active = false;
    const invokeNode = vi.fn(async ({ params }: { params: { action: string } }) => {
      switch (params.action) {
        case "status":
          return { payload: { wakeSequence, muted, listening: !muted, active, persistent: false } };
        case "holdListening":
          return { payload: { held: !muted } };
        case "start":
          active = true;
          return { payload: { bridgeId, outputGeneration: 3 } };
        case "stop":
          active = false;
          return { payload: { closed: true } };
        default:
          throw new Error("unexpected media command");
      }
    });
    const config = parseVoiceassistantConfig({
      nodeId,
      agentId: "example_owner",
      transcriptionProvider: "local-media",
      agentProfiles: { example_owner: { agentThinkingLevel: "off", speakCommentary: true } },
      waitingAudio: {
        filePath: "/var/lib/openclaw/media/waiting.wav",
        startDelayMs: 800,
        resumeDelayMs: 800,
        volume: 0.2,
      },
    });
    const api = {
      runtime: {
        nodes: {
          invoke: vi.fn(),
          list: vi.fn(async () => ({ nodes: [{ nodeId, connected: true }] })),
        },
      },
    } as never;
    const context = {
      config: {},
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      invokeNode,
      prepareNodeConversationInput: mocks.prepareInput,
    } as never;
    const service = new VoiceassistantService(api, context, config);
    const poll = (service as unknown as { poll(): Promise<void> }).poll.bind(service);
    await poll();
    expect(mocks.prepare).not.toHaveBeenCalled();
    wakeSequence = 1;
    await poll();
    await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledOnce());
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          realtime: expect.objectContaining({ waitingAudio: config.waitingAudio }),
        }),
      }),
    );
    expect(mocks.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        initialOutputGeneration: 3,
      }),
    );
    expect(mocks.createBindings).toHaveBeenCalledWith(
      expect.objectContaining({
        inputSource: expect.objectContaining({ version: 1 }),
        agentId: "example_owner",
        assertOutputCurrent: expect.any(Function),
        config: {
          realtime: expect.objectContaining({
            agentId: "example_owner",
            agentThinkingLevel: "off",
            speakCommentary: true,
            toolPolicy: "safe-read-only",
          }),
        },
      }),
    );
    expect(mocks.startEngine).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeInput: mocks.nativeInput,
        requesterSessionKey: "agent:example_owner:voiceassistant:group:device-conversation",
        connectionPresentation: expect.objectContaining({ kind: "assistant" }),
      }),
    );
    const inputRequest = mocks.prepareInput.mock.calls[0]![0];
    expect(() =>
      inputRequest.assertAssigned({
        plugins: {
          entries: {
            voiceassistant: {
              config: {
                nodeId,
                agentId: "different",
                transcriptionProvider: "local-media",
              },
            },
          },
        },
      }),
    ).toThrow("assignment changed");
    await poll();
    expect(mocks.startEngine).toHaveBeenCalledTimes(1);
    muted = true;
    await poll();
    expect(mocks.stopEngine).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.releaseInput).toHaveBeenCalledOnce();
    await service.stop();
  });

  it.each(["bridge loss", "node disconnect"])(
    "reopens continuous mode after %s",
    async (failure) => {
      let active = false;
      let bridgeClosed = false;
      let connected = true;
      mocks.startEngine.mockImplementation(async () => ({
        stop: mocks.stopEngine,
        getHealth: () => ({ bridgeClosed }),
      }));
      const invokeNode = vi.fn(async ({ params }: { params: { action: string } }) => {
        switch (params.action) {
          case "status":
            return {
              payload: {
                wakeSequence: 1,
                muted: false,
                listening: true,
                active,
                persistent: true,
              },
            };
          case "holdListening":
            return { payload: { held: true } };
          case "start":
            active = true;
            return { payload: { bridgeId, outputGeneration: 4 } };
          case "stop":
            active = false;
            return { payload: { closed: true } };
          case "setActivity":
            return { payload: { activitySet: true } };
          default:
            throw new Error("unexpected media command");
        }
      });
      const config = parseVoiceassistantConfig({
        nodeId,
        agentId: "example_owner",
        transcriptionProvider: "local-media",
      });
      const api = {
        runtime: {
          nodes: {
            invoke: vi.fn(),
            list: vi.fn(async () => ({ nodes: [{ nodeId, connected }] })),
          },
        },
      } as never;
      const context = {
        config: {},
        logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
        invokeNode,
        prepareNodeConversationInput: mocks.prepareInput,
      } as never;
      const service = new VoiceassistantService(api, context, config);
      const poll = (service as unknown as { poll(): Promise<void> }).poll.bind(service);
      await poll();
      await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledTimes(1));
      bridgeClosed = failure === "bridge loss";
      connected = failure !== "node disconnect";
      await poll(); // close the unhealthy engine
      expect(mocks.stopEngine).toHaveBeenCalledOnce();
      expect(mocks.release).toHaveBeenCalledOnce();
      if (!connected) {
        invokeNode.mockClear();
        await poll();
        await poll();
        expect(invokeNode).not.toHaveBeenCalled();
        expect(mocks.release).toHaveBeenCalledOnce();
        connected = true;
      }
      await poll(); // clear its stale node bridge
      bridgeClosed = false;
      await poll();
      await vi.waitFor(() => expect(mocks.startEngine).toHaveBeenCalledTimes(2));
      await service.stop();
    },
  );

  it("does not invoke missing or disconnected nodes and resumes on reconnect", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ nodes: [] })
      .mockResolvedValueOnce({ nodes: [{ nodeId: "c".repeat(64), connected: true }] })
      .mockResolvedValueOnce({ nodes: [{ nodeId, connected: false }] })
      .mockResolvedValue({ nodes: [{ nodeId, connected: true }] });
    const invokeNode = vi.fn(async () => ({
      payload: {
        wakeSequence: 0,
        muted: true,
        listening: false,
        active: false,
        persistent: false,
      },
    }));
    const config = parseVoiceassistantConfig({
      nodeId,
      agentId: "example_owner",
      transcriptionProvider: "local-media",
    });
    const api = { runtime: { nodes: { list, invoke: vi.fn() } } } as never;
    const context = {
      config: {},
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      invokeNode,
      prepareNodeConversationInput: mocks.prepareInput,
    } as never;
    const service = new VoiceassistantService(api, context, config);
    const poll = (service as unknown as { poll(): Promise<void> }).poll.bind(service);
    await poll();
    await poll();
    await poll();
    expect(invokeNode).not.toHaveBeenCalled();
    await poll();
    expect(list).toHaveBeenLastCalledWith({ connected: true });
    expect(invokeNode).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        nodeId,
        params: { action: "status" },
      }),
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    await service.stop();
  });

  it("does not send a status request after stop while presence is resolving", async () => {
    let resolvePresence!: (value: { nodes: { nodeId: string; connected: boolean }[] }) => void;
    const list = vi.fn(
      () =>
        new Promise<{ nodes: { nodeId: string; connected: boolean }[] }>((resolve) => {
          resolvePresence = resolve;
        }),
    );
    const invokeNode = vi.fn();
    const config = parseVoiceassistantConfig({
      nodeId,
      agentId: "example_owner",
      transcriptionProvider: "local-media",
    });
    const api = { runtime: { nodes: { list, invoke: vi.fn() } } } as never;
    const context = {
      config: {},
      logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      invokeNode,
      prepareNodeConversationInput: mocks.prepareInput,
    } as never;
    const service = new VoiceassistantService(api, context, config);
    const pending = (service as unknown as { poll(): Promise<void> }).poll();
    await service.stop();
    resolvePresence({ nodes: [{ nodeId, connected: true }] });
    await pending;
    expect(invokeNode).not.toHaveBeenCalled();
  });
});

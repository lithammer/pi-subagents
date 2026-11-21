import {
  contentText,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type ExtensionFactory,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type ScriptedReply =
  string | ToolCall[] | { text: string; usage: Usage } | { error: string };

export async function openScriptedRuntime(
  t: TestContext,
  reply: (
    context: TranscriptContext,
    signal?: AbortSignal,
  ) => Promise<ScriptedReply>,
  prepareWorkspace?: (cwd: string) => Promise<void>,
  unblockModelReplies = () => {},
  extension?: { factory: ExtensionFactory; beforeSubagents?: true },
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
  const errors: unknown[] = [];
  let runtime: AgentSessionRuntime | undefined;
  let disposing: Promise<void> | undefined;
  const quit = () => (disposing ??= runtime?.dispose());
  t.after(async () => {
    try {
      // Scripted model replies must finish before abort can wait for idle.
      unblockModelReplies();
      await quit();
      assert.deepEqual(errors, []);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  await prepareWorkspace?.(cwd);
  const models = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  models.registerProvider("scripted", {
    baseUrl: "http://127.0.0.1",
    apiKey: "test",
    api: "scripted",
    models: [
      {
        id: "scripted",
        name: "Scripted",
        input: ["text"],
        reasoning: false,
        contextWindow: 16_384,
        maxTokens: 1_024,
        cost,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: message });
      void reply(context, options?.signal).then(
        (answer) => {
          if (Array.isArray(answer)) {
            message.content = answer;
          } else if (typeof answer === "string") {
            message.content = [{ type: "text", text: answer }];
          } else if ("error" in answer) {
            message.stopReason = "error";
            message.errorMessage = answer.error;
            stream.push({ type: "error", reason: "error", error: message });
            return;
          } else {
            message.content = [{ type: "text", text: answer.text }];
            message.usage = answer.usage;
          }
          const reason = Array.isArray(answer) ? "toolUse" : "stop";
          message.stopReason = reason;
          stream.push({ type: "done", reason, message });
        },
        (error) => {
          errors.push(error);
          message.stopReason = "error";
          message.errorMessage = String(error);
          stream.push({ type: "error", reason: "error", error: message });
        },
      );
      return stream;
    },
  });
  const model = models.getModel("scripted", "scripted");
  assert.ok(model);

  runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: models,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noContextFiles: true,
          additionalExtensionPaths: [
            fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          ],
          extensionFactories: extension && [extension.factory],
          extensionsOverride: extension?.beforeSubagents
            ? (loaded) => ({
                ...loaded,
                extensions: loaded.extensions.toReversed(),
              })
            : undefined,
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model,
        tools: [
          ...["spawn", "send", "result", "transcript", "status", "stop"].map(
            (action) => `subagent_${action}`,
          ),
          "read",
          "bash",
        ],
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir: cwd, sessionManager: SessionManager.inMemory(cwd) },
  );
  const bind = (session: AgentSessionRuntime["session"]) =>
    session.bindExtensions({
      mode: "rpc",
      onError: (error) => errors.push(error),
    });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  return { runtime, quit };
}

export async function openScriptedSession(
  ...args: Parameters<typeof openScriptedRuntime>
) {
  const { runtime } = await openScriptedRuntime(...args);
  return runtime.session;
}

export async function openSubagentSession(
  t: TestContext,
  childTasks: string | readonly string[],
  reply: (
    context: TranscriptContext,
    signal?: AbortSignal,
  ) => ScriptedReply | Promise<ScriptedReply>,
  prepareWorkspace?: (cwd: string) => Promise<void>,
  unblockModelReplies?: () => void,
) {
  let request: ToolCall | undefined;
  const parentNotices: string[] = [];
  const session = await openScriptedSession(
    t,
    async (context, signal) => {
      const { messages } = context;
      const inputs = messages
        .filter((message) => message.role === "user")
        .map(({ content }) => contentText(content));
      if (
        typeof childTasks === "string"
          ? inputs[0] === childTasks
          : childTasks.includes(inputs[0])
      ) {
        return reply(context, signal);
      }

      const prompt = inputs.at(-1);
      if (!request || prompt !== request.id) {
        assert.ok(
          prompt,
          "The parent must receive a completion or tool prompt",
        );
        parentNotices.push(prompt);
        return "Received the completion.";
      }

      const callId = request.id;
      const answered = messages.some(
        (message) =>
          message.role === "toolResult" && message.toolCallId === callId,
      );
      return answered ? "Received the tool result." : [request];
    },
    prepareWorkspace,
    unblockModelReplies,
  );

  async function runTool(
    callId: string,
    action: string,
    args: ToolCall["arguments"],
  ) {
    const result = await callTool(callId, action, args);
    assert.equal(result.isError, false, contentText(result.content));
    return result.details as Record<string, any>;
  }

  async function callTool(
    callId: string,
    action: string,
    args: ToolCall["arguments"],
  ) {
    request = toolCall(callId, `subagent_${action}`, args);
    await session.prompt(callId);
    const result = session.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === callId,
    );
    assert.ok(result, `The parent must receive the ${callId} result`);
    return result;
  }

  return { session, runTool, callTool, parentNotices };
}

export function toolCall(
  id: string,
  name: string,
  args: ToolCall["arguments"],
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

export function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

export function hold() {
  const reached = gate();
  const resume = gate();
  return {
    reached: reached.wait,
    pause() {
      reached.open();
      return resume.wait;
    },
    release: resume.open,
  };
}

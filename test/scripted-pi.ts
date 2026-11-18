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
  createAgentSession,
  type AgentSession,
  DefaultResourceLoader,
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

export async function openScriptedSession(
  t: TestContext,
  reply: (
    context: TranscriptContext,
    signal?: AbortSignal,
  ) => Promise<ScriptedReply>,
  prepareWorkspace?: (cwd: string) => Promise<void>,
  unblockModelReplies = () => {},
): Promise<AgentSession> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-subagent-notices-"));
  const providerErrors: unknown[] = [];
  let session: AgentSession | undefined;
  t.after(async () => {
    try {
      // Scripted model replies must finish before abort can wait for idle.
      unblockModelReplies();
      if (session) {
        await session.abort();
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        session.dispose();
      }
      assert.deepEqual(providerErrors, []);
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
          providerErrors.push(error);
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

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      fileURLToPath(new URL("../src/index.ts", import.meta.url)),
    ],
  });
  await resourceLoader.reload();
  ({ session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    model,
    modelRuntime: models,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["subagent", "read"],
  }));
  await session.bindExtensions({ mode: "rpc" });
  return session;
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

  async function runTool(callId: string, args: ToolCall["arguments"]) {
    request = toolCall(callId, "subagent", args);
    await session.prompt(callId);
    const result = session.messages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === callId,
    );
    assert.ok(result, `The parent must receive the ${callId} result`);
    assert.equal(result.isError, false);
    return JSON.parse(contentText(result.content));
  }

  return { session, runTool, parentNotices };
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

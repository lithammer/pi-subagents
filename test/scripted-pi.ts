import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type ToolCall,
  type TranscriptContext,
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

export async function openScriptedSession(
  t: TestContext,
  reply: (context: TranscriptContext) => Promise<string | ToolCall[]>,
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
    streamSimple(model, context) {
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
      void reply(context).then(
        (answer) => {
          message.content =
            typeof answer === "string"
              ? [{ type: "text", text: answer }]
              : answer;
          message.stopReason = typeof answer === "string" ? "stop" : "toolUse";
          stream.push({
            type: "done",
            reason: message.stopReason,
            message,
          });
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

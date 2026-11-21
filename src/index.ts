import {
  type ExtensionAPI,
  type ExtensionContext,
  type ModelRegistry,
  type ToolDefinition,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  StringEnum,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type, type TObject, type TProperties } from "typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subagents, type AgentSnapshot, type Completion } from "./subagents.ts";

const completionType = "durable-subagent-completion";
const failureType = "durable-subagent-failure";
const wakeType = "durable-subagent-wake";

type Wake = {
  owner: Promise<Subagents>;
  completion: Completion;
};

function chooseSelection(
  registry: ModelRegistry,
  parent: { model?: Model<Api>; thinking: ModelThinkingLevel },
  requested: { model?: string; thinking?: ModelThinkingLevel },
) {
  let model = parent.model;
  if (requested.model !== undefined) {
    // Split on the first slash: provider names have none, but model IDs can
    // (accounts/fireworks/models/…).
    const slash = requested.model.indexOf("/");
    model =
      slash > 0
        ? registry.find(
            requested.model.slice(0, slash),
            requested.model.slice(slash + 1),
          )
        : undefined;
    if (!model)
      throw new Error(
        `Unknown model "${requested.model}". Give the model as provider/id, for example anthropic/claude-sonnet-4-5.`,
      );
  }
  if (!model)
    throw new Error("Select a parent model before spawning a subagent.");

  return { model, thinking: requested.thinking ?? parent.thinking };
}

function oneLine(text: string, width = 60) {
  const line = text.trim().split("\n", 1)[0].replace(/\s+/g, " ");
  if (line.length <= width) return line;

  const cut = line.slice(0, width);
  const space = cut.lastIndexOf(" ");
  return `${space > width / 2 ? cut.slice(0, space) : cut}…`;
}

function formatUsage(usage: Completion["usage"]) {
  if (!usage) return "";
  return `\nTokens: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} cache read, ${usage.cacheWrite} cache write · $${usage.cost.toFixed(6)}`;
}

export default function (pi: ExtensionAPI) {
  let runtime: Promise<Subagents> | undefined;
  let session: ExtensionContext | undefined;
  let treeMove:
    { from: string | null; to: string | null } | "detached" | undefined;
  const awaitingDelivery = new Map<number, string>();
  const wakes = new WeakMap<object, Wake>();

  pi.on("session_start", (_event, ctx) => {
    session = ctx;
  });

  const ownsBranch = (ctx: ExtensionContext) => {
    if (treeMove === "detached") return false;
    if (!treeMove) return true;

    const { from, to } = treeMove;
    // Pi changes the leaf before running session_tree handlers.
    const branchPoint = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.id === from ||
          entry.id === to ||
          (entry.type === "branch_summary" && entry.parentId === from),
      );
    return (branchPoint?.id ?? null) === from;
  };

  pi.on("session_before_tree", ({ preparation }, ctx) => {
    if (!ownsBranch(ctx)) {
      treeMove = "detached";
      return;
    }

    const target = ctx.sessionManager.getEntry(preparation.targetId);
    if (!target) return;

    const editsMessage =
      target.type === "custom_message" ||
      (target.type === "message" && target.message.role === "user");
    treeMove = {
      from: preparation.oldLeafId,
      to: editsMessage ? target.parentId : target.id,
    };
  });

  pi.on("input", (_event, ctx) => {
    if (treeMove && ctx.isIdle() && ownsBranch(ctx)) treeMove = undefined;
  });

  const deliver = (send: (ctx: ExtensionContext, idle: boolean) => void) => {
    const parent = session;
    const owner = runtime;
    if (!parent) return;

    const trySend = () => {
      if (session !== parent || runtime !== owner) return;
      let idle: boolean;
      try {
        idle = parent.isIdle();
      } catch {
        // Direct SDK disposal invalidates the context without a shutdown event.
        return;
      }

      if (!ownsBranch(parent)) {
        treeMove = "detached";
        return;
      }
      if (treeMove && !idle && !parent.signal) {
        // Pi has no end event for a vetoed tree move.
        setTimeout(trySend, 10).unref();
        return;
      }
      send(parent, idle);
    };
    trySend();
  };

  const showFailure = (message: string) =>
    deliver((parent) => {
      if (parent.mode === "print") {
        console.error(message);
        return;
      }

      try {
        pi.sendMessage(
          { customType: failureType, content: message, display: true },
          { triggerTurn: false },
        );
      } catch {
        console.error(message);
      }
    });

  const showDeliveryFailure = (id: string, submission: number) => {
    showFailure(
      `Subagent ${id} completion delivery failed for submission ${submission}. Retrieve the saved result with subagent_result.`,
    );
  };

  const refresh = (agents: AgentSnapshot[]) => {
    if (!session?.hasUI) return;

    const running = agents.filter((agent) => agent.pending > 0);
    session.ui.setWidget(
      "durable-subagents",
      running.length
        ? running.map(
            (agent) => `${agent.id} · ${agent.label} · ${agent.activity}`,
          )
        : undefined,
    );
  };

  const complete = (completion: Completion) =>
    deliver((_parent, idle) => {
      if (!runtime) return;

      const token = {};
      wakes.set(token, { owner: runtime, completion });
      if (!idle) awaitingDelivery.set(completion.submission, completion.id);
      try {
        // Pi can hold a wake through a tree move while agent_settled runs.
        pi.sendMessage(
          {
            customType: wakeType,
            content: [],
            display: false,
            details: token,
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } catch {
        awaitingDelivery.delete(completion.submission);
        showDeliveryFailure(completion.id, completion.submission);
      }
    });

  const getReply = (token: unknown, ctx: ExtensionContext) => {
    if (!token || typeof token !== "object") return;
    const wake = wakes.get(token);
    if (wake && wake.owner === runtime && ownsBranch(ctx))
      return wake.completion;
  };

  pi.on("before_agent_start", (event, ctx) => {
    if (
      event.messageType === "custom" &&
      event.message.customType === wakeType &&
      !getReply(event.message.details, ctx)
    )
      ctx.abort();
  });

  pi.on("message_start", ({ message }, ctx) => {
    if (message.role !== "custom" || message.customType !== wakeType) return;
    const completion = getReply(message.details, ctx);
    if (!completion) {
      delete message.details;
      return;
    }

    const preview = truncateHead(completion.output, {
      maxLines: 12,
      maxBytes: 2_000,
    });
    message.customType = completionType;
    message.content =
      `Subagent ${completion.id} (${completion.label}), submission ${completion.submission}: ${completion.status}${formatUsage(completion.usage)}\n${preview.content}` +
      (preview.truncated
        ? `\nUse subagent_result with id ${completion.id} and submission ${completion.submission} for this full reply.`
        : "");
    message.display = true;
    message.details = completion;
    awaitingDelivery.delete(completion.submission);
  });

  pi.on("context", ({ messages }) => {
    // A discarded wake can still be in Pi's transcript.
    const kept = messages.filter(
      (message) => message.role !== "custom" || message.customType !== wakeType,
    );
    if (kept.length !== messages.length) return { messages: kept };
  });

  pi.on("agent_settled", ({ aborted }) => {
    // Escape can drop queued follow-ups before Pi shows them.
    if (aborted) {
      for (const [submission, id] of awaitingDelivery)
        showDeliveryFailure(id, submission);
    }
    awaitingDelivery.clear();
  });

  pi.on("session_shutdown", async () => {
    session = undefined;
    treeMove = undefined;
    awaitingDelivery.clear();
    try {
      if (runtime) await (await runtime).close();
    } finally {
      runtime = undefined;
    }
  });

  pi.on("session_tree", async () => {
    try {
      if (runtime) await (await runtime).close();
    } finally {
      runtime = undefined;
      treeMove = undefined;
      awaitingDelivery.clear();
      refresh([]);
    }
  });

  pi.registerMessageRenderer(
    failureType,
    (message, { outputPad }, theme) =>
      new Text(theme.fg("error", String(message.content)), outputPad, 0),
  );

  pi.registerMessageRenderer(
    completionType,
    (message, { expanded, outputPad }, theme) => {
      const completion = message.details as Completion;
      const color = completion.status === "completed" ? "success" : "warning";
      const title = theme.fg(
        color,
        `${completion.id} · ${completion.label} · submission ${completion.submission} · ${completion.status}`,
      );
      const card = new Box(outputPad, 1, (text) =>
        theme.bg("customMessageBg", text),
      );
      card.addChild(
        new Text(
          expanded
            ? `${title}${formatUsage(completion.usage)}\n${completion.output}`
            : title,
          0,
          0,
        ),
      );
      return card;
    },
  );

  const openAgents = async (ctx: ExtensionContext) => {
    if (!session) throw new Error("The parent session has closed.");
    runtime ??= Subagents.create(
      ctx.modelRegistry,
      refresh,
      complete,
      showFailure,
    );
    const agents = await runtime;
    if (!session) throw new Error("The parent session has closed.");
    return agents;
  };

  const registerAction = <Properties extends TProperties>(
    action: string,
    {
      properties,
      ...tool
    }: Pick<
      ToolDefinition,
      "description" | "promptSnippet" | "promptGuidelines"
    > & { properties: Properties },
    run: (
      open: () => Promise<Subagents>,
      args: Parameters<ToolDefinition<TObject<Properties>>["execute"]>[1],
      ctx: ExtensionContext,
    ) => Promise<unknown>,
  ) =>
    pi.registerTool({
      name: `subagent_${action}`,
      label: `Subagent ${action}`,
      executionMode: "sequential",
      ...tool,
      parameters: Type.Object(properties, { additionalProperties: false }),
      async execute(toolCallId, args, signal, _onUpdate, ctx) {
        signal?.throwIfAborted();
        if (!session) throw new Error("The parent session has closed.");

        let agents: Subagents | undefined;
        const result = await run(
          async () => (agents ??= await openAgents(ctx)),
          args,
          ctx,
        );

        const text = JSON.stringify(result, null, 2);
        const preview = truncateHead(text);
        let output = preview.content;
        if (preview.truncated) {
          const directory = await mkdtemp(join(tmpdir(), "pi-durable-result-"));
          const path = join(directory, "result.json");
          await writeFile(path, text, { mode: 0o600 });
          output += `\n[Truncated. Full JSON result: ${path}]`;
        }

        const usage =
          agents && toolCallId && !signal?.aborted
            ? agents.takePendingUsage()
            : undefined;
        return {
          content: [{ type: "text", text: output }],
          details: result,
          ...(usage && { usage }),
        };
      },
      renderCall(args, theme) {
        const { id, label } = args as { id?: string; label?: string };
        return new Text(
          theme.fg("toolTitle", `subagent ${action} ${id ?? label ?? ""}`),
          0,
          0,
        );
      },
      renderResult(result, { expanded }, theme) {
        const value = result.details as
          | { id?: string; status?: string; output?: string }
          | unknown[]
          | undefined;
        if (expanded || !value) {
          return new Text(
            result.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
            0,
            0,
          );
        }
        if (Array.isArray(value))
          return new Text(`${value.length} subagents`, 0, 0);

        const summary = theme.fg(
          "muted",
          `${value.id ?? ""} · ${value.status ?? ""}`,
        );
        const preview = value.output
          ? truncateHead(value.output, { maxLines: 4, maxBytes: 700 })
          : undefined;
        return new Text(
          summary + (preview ? `\n${preview.content}` : ""),
          0,
          0,
        );
      },
    });

  const id = Type.String({ description: "Agent id from subagent_spawn" });
  const task = Type.String({
    pattern: "\\S",
    description:
      "Self-contained task: file scope, expected evidence, and whether the agent may edit",
  });
  const submissionNote =
    "Submission numbers are runtime-assigned IDs, not per-agent sequence numbers; use the returned number rather than guessing.";

  registerAction(
    "spawn",
    {
      description:
        "Start a general-purpose background agent in a separate conversation. " +
        "Use only in trusted workspaces where agents may run native tools with your OS permissions. " +
        "Agents share the parent's working directory. Their native read/bash/edit/write tools match the parent's active tool names and bypass parent permission hooks and custom tool overrides. " +
        "Agents take the parent's system prompt, and its model and thinking level unless model or thinking is given. They have no parent extensions, MCP, or nested delegation, and live only for this Pi session. " +
        `Returns at once with the agent id and a submission number; completion arrives as a notification. ${submissionNote}`,
      promptSnippet:
        "Delegate an independent task to a background agent in a separate conversation",
      promptGuidelines: [
        "Use subagent_spawn for independent research, review, or implementation when delegation saves time or context; work on non-overlapping tasks locally while it runs. Do not duplicate a subagent's work.",
        "Give subagent_spawn a self-contained task, file scope, expected evidence, and explicit permission to edit or research only. The agent does not inherit the conversation history. For edits, assign non-overlapping write scopes to yourself and each agent.",
        "Verify subagent results before reporting success: check the evidence, inspect any edits, and run relevant checks rather than relying on the summary alone.",
        "Completion notifications arrive automatically, so do not poll for them. Use subagent_send for related follow-up work to keep an agent's context, subagent_transcript to diagnose a stuck or failed agent, and subagent_stop to cancel one.",
        "When waiting for a subagent and no independent work remains, end your turn with a brief status message and no tool calls. Never use sleep, shell waits, or repeated tool calls to keep your turn open: completion notifications wait for the parent run to finish, then start another turn automatically.",
      ],
      properties: {
        task,
        label: Type.Optional(
          Type.String({
            maxLength: 80,
            description: "Short task label",
          }),
        ),
        model: Type.Optional(
          Type.String({
            description:
              "Model as provider/id, for example anthropic/claude-sonnet-4-5. Defaults to the parent's model",
          }),
        ),
        thinking: Type.Optional(
          Type.Unsafe<ModelThinkingLevel>(
            StringEnum(
              // pi-ai's MODEL_THINKING_LEVELS lives at a subpath that Pi's
              // extension loader does not expose, so copy it and keep in step.
              [
                "off",
                "minimal",
                "low",
                "medium",
                "high",
                "xhigh",
                "max",
              ] as const satisfies readonly ModelThinkingLevel[],
              {
                description:
                  "Thinking level the model supports. Defaults to the parent's level",
              },
            ),
          ),
        ),
      },
    },
    async (open, args, ctx) =>
      (await open()).spawn(
        args.task,
        oneLine(args.label ?? "", 80) || oneLine(args.task),
        {
          ...chooseSelection(
            ctx.modelRegistry,
            {
              model: ctx.model,
              thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
            },
            args,
          ),
          systemPrompt: ctx.getSystemPrompt(),
          cwd: ctx.cwd,
          tools: pi
            .getActiveTools()
            .filter((name) => ["read", "bash", "edit", "write"].includes(name)),
        },
      ),
  );

  registerAction(
    "send",
    {
      description:
        "Send a follow-up task to an existing background agent. It keeps its model, thinking level, and conversation. " +
        `Returns a submission number; completion arrives as a notification. ${submissionNote}`,
      promptSnippet: "Message an existing background agent to keep its context",
      properties: {
        id,
        task,
        delivery: Type.Optional(
          StringEnum(["followUp", "steer"] as const, {
            description:
              "Queue after current work (default), or steer at the next turn boundary",
          }),
        ),
      },
    },
    async (open, args) =>
      (await open()).send(
        args.id,
        args.task,
        args.delivery === "steer" ? "steer" : "followUp",
      ),
  );

  registerAction(
    "result",
    {
      description:
        "Return a background agent's reply by submission number, or its latest if omitted (up to 50 KB/2,000 lines, with a path for overflow). " +
        submissionNote,
      promptSnippet: "Read a background agent's reply",
      properties: {
        id,
        submission: Type.Optional(
          Type.Integer({
            description:
              "Submission number from subagent_spawn, subagent_send, or a completion notice",
          }),
        ),
      },
    },
    async (open, args) => (await open()).result(args.id, args.submission),
  );

  registerAction(
    "transcript",
    {
      description:
        "Show a background agent's current activity and recent model and tool failures, with no raw diagnostic text.",
      promptSnippet: "Diagnose a stuck or failed background agent",
      properties: { id },
    },
    async (open, args) => (await open()).transcript(args.id),
  );

  registerAction(
    "status",
    {
      description:
        "List background agents with their model, thinking level, status, and activity.",
      promptSnippet: "List background agents",
      properties: {},
    },
    async (open) => (runtime ? (await open()).list() : []),
  );

  registerAction(
    "stop",
    {
      description:
        "Cancel a background agent's outstanding work. It keeps its conversation for another subagent_send.",
      promptSnippet: "Cancel a background agent's work",
      properties: { id },
    },
    async (open, args) => (await open()).stop(args.id),
  );

  pi.registerCommand("agents", {
    description:
      "List, stop, or inspect a background agent's failure transcript",
    handler: async (args, ctx) => {
      const agents = runtime ? await runtime : undefined;
      const rows = () => agents?.list() ?? [];
      const showList = () =>
        ctx.ui.notify(
          rows()
            .map((agent) => `${agent.id} · ${agent.label} · ${agent.activity}`)
            .join("\n") || "No subagents.",
          "info",
        );

      const [action, id] = args.trim().split(/\s+/);
      if (!action) return showList();
      if ((action !== "stop" && action !== "transcript") || !id)
        return ctx.ui.notify(
          "Usage: /agents, /agents stop <id>, or /agents transcript <id>",
          "warning",
        );
      if (!agents || !rows().some((agent) => agent.id === id))
        return ctx.ui.notify(`No subagent ${id} in this session.`, "warning");

      if (action === "transcript") {
        ctx.ui.notify((await agents.transcript(id)).output, "info");
        return;
      }
      await agents.stop(id);
      showList();
    },
  });
}

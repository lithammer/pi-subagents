import {
  type ExtensionAPI,
  type ExtensionContext,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
      `Subagent ${id} completion delivery failed for submission ${submission}. Retrieve the saved result with subagent result.`,
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
      `Subagent ${completion.id} (${completion.label}): ${completion.status}${formatUsage(completion.usage)}\n${preview.content}` +
      (preview.truncated
        ? `\nUse subagent result with id ${completion.id} and submission ${completion.submission} for this full reply.`
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
        `${completion.id} · ${completion.label} · ${completion.status}`,
      );
      const preview = truncateHead(
        completion.output,
        expanded ? undefined : { maxLines: 4, maxBytes: 700 },
      );
      const body =
        preview.content +
        (preview.truncated
          ? `\nUse subagent result: ${completion.id}, submission ${completion.submission}`
          : "");
      return new Text(
        `${title}${formatUsage(completion.usage)}\n${body}`,
        outputPad,
        0,
      );
    },
  );

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    executionMode: "sequential",
    description:
      "Run general-purpose background agents in separate conversations. " +
      "Use only in trusted workspaces where children may run native tools with your OS permissions. " +
      "Children share the parent's working directory. Their native read/bash/edit/write tools match the parent's active tool names and bypass parent permission hooks and custom tool overrides. " +
      "Spawn returns immediately and completion arrives as a notification. Children take the parent's model, thinking level, and system prompt at spawn. " +
      "Reuse an id with send to retain that selection and conversation. Children have no parent extensions, MCP, or nested delegation. " +
      "Result returns a reply by submission id, or the latest if omitted (up to 50 KB/2,000 lines, with a path for overflow). " +
      "Transcript shows a child's current activity and recent model and tool failures, with no raw diagnostic text. " +
      "Status lists agents. Stop cancels outstanding work and keeps the conversation for another send. Children live only for this Pi session.",
    promptSnippet:
      "Delegate independent tasks to background agents; message existing agents to retain context",
    promptGuidelines: [
      "Use subagent for independent research, review, or implementation when delegation saves time or context; work on non-overlapping tasks locally while it runs. Do not duplicate a subagent's work.",
      "Give subagent a self-contained task, file scope, expected evidence, and explicit permission to edit or research only. The child does not inherit the conversation history. For edits, assign non-overlapping write scopes to yourself and each subagent.",
      "Verify subagent results before reporting success: check the evidence, inspect any edits, and run relevant checks rather than relying on the summary alone.",
      "Use transcript to diagnose a stuck or failed child. Completion notifications arrive automatically, so do not poll for them. Use send for related follow-up work and stop to cancel a child explicitly.",
      "When waiting for a subagent and no independent work remains, end your turn with a brief status message and no tool calls. Never use sleep, shell waits, or repeated tool calls to keep your turn open: completion notifications wait for the parent run to finish, then start another turn automatically.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "spawn",
        "send",
        "result",
        "transcript",
        "status",
        "stop",
      ] as const),
      id: Type.Optional(
        Type.String({
          description:
            "Existing agent id; required for send, result, transcript, and stop",
        }),
      ),
      task: Type.Optional(
        Type.String({
          description:
            "Self-contained task or follow-up message; required for spawn and send",
        }),
      ),
      submission: Type.Optional(
        Type.Integer({
          description:
            "For result: retrieve this exact reply instead of the latest",
        }),
      ),
      label: Type.Optional(
        Type.String({
          maxLength: 80,
          description: "Short task label for a new agent",
        }),
      ),
      delivery: Type.Optional(
        StringEnum(["followUp", "steer"] as const, {
          description:
            "For send: queue after current work (default), or steer at the next turn boundary",
        }),
      ),
    }),
    async execute(toolCallId, args, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!session) throw new Error("The parent session has closed.");

      if (args.action === "status" && !runtime) {
        return {
          content: [{ type: "text", text: "No subagents." }],
          details: undefined,
        };
      }

      runtime ??= Subagents.create(
        ctx.modelRegistry,
        refresh,
        complete,
        showFailure,
      );
      const agents = await runtime;
      if (!session) throw new Error("The parent session has closed.");

      let result: unknown;
      switch (args.action) {
        case "spawn": {
          if (!args.task?.trim())
            throw new Error("spawn requires a non-empty task.");
          if (!ctx.model)
            throw new Error(
              "Select a parent model before spawning a subagent.",
            );

          result = await agents.spawn(
            args.task,
            args.label ?? args.task.slice(0, 60),
            {
              model: ctx.model,
              thinking: ctx.thinkingLevel ?? pi.getThinkingLevel(),
              systemPrompt: ctx.getSystemPrompt(),
              cwd: ctx.cwd,
              tools: pi
                .getActiveTools()
                .filter((name) =>
                  ["read", "bash", "edit", "write"].includes(name),
                ),
            },
          );
          break;
        }
        case "send":
          if (!args.id || !args.task?.trim())
            throw new Error("send requires id and a non-empty task.");
          result = await agents.send(
            args.id,
            args.task,
            args.delivery === "steer" ? "steer" : "followUp",
          );
          break;
        case "stop":
          if (!args.id) throw new Error("stop requires id.");
          result = await agents.stop(args.id);
          break;
        case "result":
          if (!args.id) throw new Error("result requires id.");
          result = await agents.result(args.id, args.submission);
          break;
        case "transcript":
          if (!args.id) throw new Error("transcript requires id.");
          result = await agents.transcript(args.id);
          if (!result)
            throw new Error("No subagent with that ID in this session.");
          break;
        case "status":
          result = agents.list();
          break;
      }

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
        toolCallId && !signal?.aborted ? agents.takePendingUsage() : undefined;
      return {
        content: [{ type: "text", text: output }],
        details: result,
        ...(usage && { usage }),
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg(
          "toolTitle",
          `subagent ${args.action ?? ""} ${args.id ?? args.label ?? ""}`,
        ),
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
      return new Text(summary + (preview ? `\n${preview.content}` : ""), 0, 0);
    },
  });

  pi.registerCommand("agents", {
    description:
      "List, stop, or inspect a background agent's failure transcript",
    handler: async (args, ctx) => {
      const agents = runtime ? await runtime : undefined;
      const [action, id] = args.trim().split(/\s+/);
      if (action === "transcript") {
        if (!ctx.hasUI) return;
        if (!id) {
          ctx.ui.notify("Usage: /agents transcript <id>", "warning");
          return;
        }
        const transcript = await agents?.transcript(id);
        ctx.ui.notify(
          transcript?.output ?? "No subagent with that ID in this session.",
          transcript ? "info" : "warning",
        );
        return;
      }
      if (action === "stop" && id && agents) await agents.stop(id);

      const rows = agents?.list() ?? [];
      const content = rows.length
        ? rows
            .map(
              (agent) =>
                `${agent.id} · ${agent.label} · ${agent.status} · ${agent.activity}`,
            )
            .join("\n")
        : "No subagents.";
      if (ctx.hasUI) ctx.ui.notify(content, "info");
    },
  });
}

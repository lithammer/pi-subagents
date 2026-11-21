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
import { Box, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type TObject, type TProperties } from "typebox";
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

function formatElapsed(ms: number) {
  const seconds = Math.round(ms / 1_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600)
    return `${Math.floor(seconds / 60)}m${pad(seconds % 60)}s`;
  return `${Math.floor(seconds / 3_600)}h${pad(Math.floor((seconds % 3_600) / 60))}m`;
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCost(cost: number) {
  return `$${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

// Usage is the agent's running total, not the spend of one submission.
function formatUsage(usage: Completion["usage"]) {
  if (!usage) return "";
  const tokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  if (tokens === 0 && usage.cost === 0) return "";
  return ` · agent total ${compact.format(tokens)} tokens, ${formatCost(usage.cost)}`;
}

function formatUsageBreakdown(usage: Completion["usage"]) {
  if (!usage) return "";
  return `Agent total: ${compact.format(usage.input)} input · ${compact.format(usage.output)} output · ${compact.format(usage.cacheRead)} cache read · ${compact.format(usage.cacheWrite)} cache write · ${formatCost(usage.cost)}`;
}

type Reply = Awaited<ReturnType<Subagents["result"]>>;

function agentLine(agent: AgentSnapshot & { submission?: number }) {
  return (
    `${agent.id} · ${agent.label} · ${agent.model} (thinking: ${agent.thinking}) · ${agent.activity}` +
    (agent.pending > 1 ? ` · ${agent.pending} pending` : "") +
    (agent.submission === undefined ? "" : ` · submission ${agent.submission}`)
  );
}

function agentRow(agent: AgentSnapshot) {
  return `${agent.id} · ${agent.label} · ${agent.activity}`;
}

function completionHead(completion: Completion) {
  return `Subagent ${completion.id} (${completion.label}), submission ${completion.submission}: ${completion.status} in ${formatElapsed(completion.durationMs)}${formatUsage(completion.usage)}`;
}

function replyText(reply: Reply) {
  if (!("submission" in reply)) return `${agentLine(reply)}\n${reply.output}`;
  return (
    `${completionHead(reply)}\n${reply.output}` +
    ("fullOutputPath" in reply
      ? `\n[Truncated. Full reply: ${reply.fullOutputPath}]`
      : "")
  );
}

export default function (pi: ExtensionAPI) {
  let runtime: Promise<Subagents> | undefined;
  let session: ExtensionContext | undefined;
  let treeMove:
    { from: string | null; to: string | null } | "detached" | undefined;
  const awaitingDelivery = new Set<Completion>();
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
    if (!running.length) {
      session.ui.setWidget("durable-subagents", undefined);
      return;
    }
    // Only the TUI takes a widget component.
    if (session.mode !== "tui") {
      session.ui.setWidget("durable-subagents", running.map(agentRow));
      return;
    }

    const shown = running.slice(0, 8);
    session.ui.setWidget("durable-subagents", (tui, theme) => {
      const clock = setInterval(() => tui.requestRender(), 1_000);
      clock.unref();
      return {
        render: (width) =>
          [
            ...shown.map(
              (agent) =>
                `${theme.fg("accent", "●")} ${agent.label}` +
                theme.fg(
                  "muted",
                  ` · ${agent.activity} · ${formatElapsed(Date.now() - (agent.runningSince ?? Date.now()))} · ${agent.model.split("/").at(-1)} · ${agent.id}`,
                ),
            ),
            ...(running.length > shown.length
              ? [theme.fg("muted", `… ${running.length - shown.length} more`)]
              : []),
          ].map((line) => truncateToWidth(` ${line}`, width, "…")),
        invalidate() {},
        dispose: () => clearInterval(clock),
      };
    });
  };

  const complete = (completion: Completion) =>
    deliver((_parent, idle) => {
      if (!runtime) return;

      const token = {};
      wakes.set(token, { owner: runtime, completion });
      if (!idle) awaitingDelivery.add(completion);
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
        awaitingDelivery.delete(completion);
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
      `${completionHead(completion)}\n${preview.content}` +
      (preview.truncated
        ? `\nUse subagent_result with id ${completion.id} and submission ${completion.submission} for this full reply.`
        : "");
    message.display = true;
    message.details = completion;
    awaitingDelivery.delete(completion);
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
      for (const { id, submission } of awaitingDelivery)
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
      // Cards saved before durations were recorded lack one.
      const completion = message.details as Omit<Completion, "durationMs"> &
        Partial<Pick<Completion, "durationMs">>;
      const [mark, color] = (
        {
          completed: ["✓", "success"],
          stopped: ["■", "warning"],
          failed: ["✗", "error"],
        } as const
      )[completion.status];
      const title = theme.fg(
        color,
        `${mark} ${completion.id} · ${completion.label} · submission ${completion.submission} · ${completion.status}` +
          (completion.durationMs === undefined
            ? ""
            : ` · ${formatElapsed(completion.durationMs)}`),
      );
      const usage = theme.fg(
        "muted",
        expanded
          ? formatUsageBreakdown(completion.usage)
          : formatUsage(completion.usage),
      );
      const card = new Box(outputPad, 1, (text) =>
        theme.bg("customMessageBg", text),
      );
      card.addChild(
        new Text(
          expanded
            ? [title, ...(usage ? [usage] : []), completion.output].join("\n")
            : title + usage,
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

  const registerAction = <Properties extends TProperties, Result>(
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
    ) => Promise<Result>,
    text: (result: Result) => string,
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

        const usage =
          agents && toolCallId && !signal?.aborted
            ? agents.takePendingUsage()
            : undefined;
        return {
          content: [{ type: "text", text: text(result) }],
          details: result,
          ...(usage && { usage }),
        };
      },
      renderCall(args, theme) {
        const call = args as {
          id?: string;
          label?: string;
          task?: string;
          model?: string;
          thinking?: string;
          submission?: number;
          delivery?: string;
        };
        const task = oneLine(call.task ?? "");
        const subject = call.id ?? (oneLine(call.label ?? "", 80) || task);
        const selection = [call.model, call.thinking].filter(Boolean);
        const notes = [
          call.id && task && `↳ ${task}`,
          selection.length && `(${selection.join(", ")})`,
          call.submission !== undefined && `submission ${call.submission}`,
          call.delivery === "steer" && "(steer)",
        ].filter(Boolean);
        return new Text(
          [
            theme.fg("toolTitle", theme.bold(`subagent ${action}`)),
            ...(subject ? [theme.fg("accent", subject)] : []),
            ...(notes.length ? [theme.fg("muted", notes.join(" "))] : []),
          ].join(" "),
          0,
          0,
        );
      },
      renderResult(result, { expanded }, theme) {
        const value = result.details as
          | (Partial<AgentSnapshot> & { submission?: number; output?: string })
          | AgentSnapshot[]
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
          return new Text(
            (value.length ? value.map(agentRow) : ["No subagents."])
              .map((line) => theme.fg("muted", line))
              .join("\n"),
            0,
            0,
          );

        const summary = theme.fg(
          "muted",
          [
            value.id,
            value.activity ?? value.status,
            value.submission !== undefined && `submission ${value.submission}`,
          ]
            .filter(Boolean)
            .join(" · "),
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
  registerAction(
    "spawn",
    {
      description:
        "Start a general-purpose background agent in a separate conversation. " +
        "Use only in trusted workspaces where agents may run native tools with your OS permissions. " +
        "Agents share the parent's working directory. Their native read/bash/edit/write tools match the parent's active tool names and bypass parent permission hooks and custom tool overrides. " +
        "Agents take the parent's system prompt, and its model and thinking level unless model or thinking is given. They have no parent extensions, MCP, or nested delegation, and live only for this Pi session. " +
        "Returns at once with the agent id and a submission number, counted per agent from 1; completion arrives as a notification.",
      promptSnippet:
        "Delegate an independent task to a background agent in a separate conversation",
      promptGuidelines: [
        "Use subagent_spawn for independent research, review, or implementation when delegation saves time or context; work on non-overlapping tasks locally while it runs. Do not duplicate a subagent's work.",
        "Give subagent_spawn a self-contained task, file scope, expected evidence, and explicit permission to edit or research only. The agent does not inherit the conversation history. For edits, assign non-overlapping write scopes to yourself and each agent.",
        "Verify subagent results before reporting success: check the evidence, inspect any edits, and run relevant checks rather than relying on the summary alone.",
        "Completion notifications arrive automatically, so do not poll for them. Use subagent_send for related follow-up work to keep an agent's context, subagent_diagnose to inspect a stuck or failed agent, and subagent_stop to cancel one.",
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
    agentLine,
  );

  registerAction(
    "send",
    {
      description:
        "Send a follow-up task to an existing background agent. It keeps its model, thinking level, and conversation. " +
        "Returns a submission number; completion arrives as a notification.",
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
    agentLine,
  );

  registerAction(
    "result",
    {
      description:
        "Return a background agent's reply by submission number, or its latest if omitted (up to 50 KB/2,000 lines, with a path for overflow).",
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
    replyText,
  );

  registerAction(
    "diagnose",
    {
      description:
        "Show a background agent's current activity and recent model and tool failures, with no raw diagnostic text.",
      promptSnippet: "Diagnose a stuck or failed background agent",
      properties: { id },
    },
    async (open, args) => (await open()).diagnose(args.id),
    (diagnosis) => diagnosis.output,
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
    (agents) => agents.map(agentLine).join("\n") || "No subagents.",
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
    agentLine,
  );

  pi.registerCommand("agents", {
    description: "List, stop, or diagnose background agents",
    getArgumentCompletions: async (prefix) => {
      const [action, id, ...rest] = prefix.trimStart().split(/\s+/);
      const actions = ["stop", "diagnose"];
      const agents = runtime ? (await runtime).list() : [];
      const items =
        id === undefined
          ? actions
              .filter((name) => name.startsWith(action))
              .map((name) => ({ value: `${name} `, label: name }))
          : rest.length || !actions.includes(action)
            ? []
            : agents
                .filter((agent) => agent.id.startsWith(id))
                .map((agent) => ({
                  value: `${action} ${agent.id}`,
                  label: agent.id,
                  description: `${agent.label} · ${agent.activity}`,
                }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const agents = runtime ? await runtime : undefined;
      const list = () => agents?.list() ?? [];
      const showList = () =>
        ctx.ui.notify(
          list().map(agentRow).join("\n") || "No subagents.",
          "info",
        );

      const [action, given] = args.trim().split(/\s+/);
      if (!action) return showList();
      if (action !== "stop" && action !== "diagnose")
        return ctx.ui.notify(
          "Usage: /agents, /agents stop [id], or /agents diagnose [id]",
          "warning",
        );

      let id: string | undefined = given;
      if (!id) {
        const stopping = action === "stop";
        const choices = stopping
          ? list().filter((agent) => agent.pending > 0)
          : list();
        if (!choices.length)
          return ctx.ui.notify(
            stopping ? "No running subagents." : "No subagents.",
            "info",
          );
        const choice = await ctx.ui.select(
          stopping ? "Stop which subagent?" : "Inspect which subagent?",
          choices.map(agentRow),
        );
        id = choices.find((agent) => agentRow(agent) === choice)?.id;
        if (!id) return;
      }
      if (!agents || !list().some((agent) => agent.id === id))
        return ctx.ui.notify(`No subagent ${id} in this session.`, "warning");

      if (action === "diagnose") {
        ctx.ui.notify((await agents.diagnose(id)).output, "info");
        return;
      }
      await agents.stop(id);
      showList();
    },
  });
}

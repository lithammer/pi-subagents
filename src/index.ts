import {
  type ExtensionAPI,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Subagents, type AgentSnapshot, type Completion } from "./subagents.ts";

const messageType = "durable-subagent-completion";

export default function (pi: ExtensionAPI) {
  let runtime: Promise<Subagents> | undefined;
  let active = false;
  let refresh = (_agents: AgentSnapshot[]) => {};

  pi.on("session_start", (_event, ctx) => {
    active = true;
    refresh = (agents) => {
      if (!active || !ctx.hasUI) return;

      const running = agents.filter((agent) => agent.pending > 0);
      ctx.ui.setWidget(
        "durable-subagents",
        running.length
          ? running.map(
              (agent) => `${agent.id} · ${agent.label} · ${agent.activity}`,
            )
          : undefined,
      );
    };
  });

  const complete = (completion: Completion) => {
    if (!active) return;

    const preview = truncateHead(completion.output, {
      maxLines: 12,
      maxBytes: 2_000,
    });
    pi.sendMessage(
      {
        customType: messageType,
        content:
          `Subagent ${completion.id} (${completion.label}): ${completion.status}\n${preview.content}` +
          (preview.truncated
            ? `\nUse subagent result with id ${completion.id} and submission ${completion.submission} for this full reply.`
            : ""),
        display: true,
        details: completion,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  pi.on("session_shutdown", async () => {
    active = false;
    if (runtime) await (await runtime).close();
  });

  pi.on("session_tree", async () => {
    if (runtime) await (await runtime).close();
    runtime = undefined;
    refresh([]);
  });

  pi.registerMessageRenderer(
    messageType,
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
      return new Text(`${title}\n${body}`, outputPad, 0);
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
      "Status lists agents. Stop cancels outstanding work and keeps the conversation for another send. Children live only for this Pi session.",
    promptSnippet:
      "Delegate independent tasks to background agents; message existing agents to retain context",
    promptGuidelines: [
      "Use subagent for independent research, review, or implementation when delegation saves time or context; work on non-overlapping tasks locally while it runs. Do not duplicate a subagent's work.",
      "Give subagent a self-contained task, file scope, expected evidence, and explicit permission to edit or research only. The child does not inherit the conversation history. For edits, assign non-overlapping write scopes to yourself and each subagent.",
      "Verify subagent results before reporting success: check the evidence, inspect any edits, and run relevant checks rather than relying on the summary alone.",
      "Do not poll subagent status/result for completion; a notification arrives automatically. Use send for related follow-up work and stop to cancel a child explicitly.",
      "When waiting for a subagent and no independent work remains, end your turn with a brief status message and no tool calls. Never use sleep, shell waits, or repeated tool calls to keep your turn open: completion notifications wait for the parent run to finish, then start another turn automatically.",
    ],
    parameters: Type.Object({
      action: StringEnum([
        "spawn",
        "send",
        "result",
        "status",
        "stop",
      ] as const),
      id: Type.Optional(
        Type.String({
          description: "Existing agent id; required for send, result, and stop",
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
    async execute(_toolCallId, args, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!active) throw new Error("The parent session has closed.");

      if (args.action === "status" && !runtime) {
        return {
          content: [{ type: "text", text: "No subagents." }],
          details: undefined,
        };
      }

      runtime ??= Subagents.create(ctx.modelRegistry, refresh, complete);
      const agents = await runtime;
      if (!active) throw new Error("The parent session has closed.");

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

      return { content: [{ type: "text", text: output }], details: result };
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
    description: "List background agents or stop one with /agents stop <id>",
    handler: async (args, ctx) => {
      const agents = runtime ? await runtime : undefined;
      const [action, id] = args.trim().split(/\s+/);
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

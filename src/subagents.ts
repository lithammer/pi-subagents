import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type {
  Api,
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  Usage,
} from "@earendil-works/pi-ai";
import {
  isContextOverflow,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  Harness,
  MemoryStorage,
  SessionFailed,
  ToolResultEntry,
  UsageDoc,
  createRegistry,
  type Conversation,
  type ConversationWatch,
  type Cursor,
  type EntryRecord,
  type LiveState,
  type Report,
  type Submission,
  type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type AgentSnapshot = {
  id: string;
  label: string;
  model: string;
  status: "running" | "idle" | "stopped" | "failed";
  pending: number;
  activity: string;
};

export type Completion = {
  id: string;
  label: string;
  submission: number;
  status: "completed" | "stopped" | "failed";
  output: string;
  usage?: UsageSummary;
};

type UsageSummary = Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite"
> & {
  cost: number;
};

type SpawnConfig = {
  model: Model<Api>;
  thinking: ModelThinkingLevel;
  systemPrompt: string;
  cwd: string;
  tools: string[];
};

type Child = {
  snapshot: AgentSnapshot;
  conversation: Conversation;
  watch: ConversationWatch;
  waits: Set<Promise<void>>;
  replies: Map<number, Completion>;
  accountedUsage: UsageState["models"];
  answer?: number;
};

export class Subagents {
  private readonly children = new Map<string, Child>();
  private readonly models = createModels();
  private readonly environments = new Map<string, NodeExecutionEnv>();
  private readonly providers = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  private pendingUsage?: Usage;
  private harness!: Harness;

  private constructor(
    private readonly parent: ModelRegistry,
    private readonly onChange: (agents: AgentSnapshot[]) => void,
    private readonly onComplete: (completion: Completion) => void,
    private readonly onFailure: (message: string) => void,
  ) {}

  static async create(
    parent: ModelRegistry,
    onChange: (agents: AgentSnapshot[]) => void,
    onComplete: (completion: Completion) => void,
    onFailure: (message: string) => void,
  ) {
    const agents = new Subagents(parent, onChange, onComplete, onFailure);
    const registry = createRegistry();
    registry.install(CodingTools);

    agents.harness = await Harness.open(
      new MemoryStorage(),
      {
        models: agents.models,
        registry,
        onReport: (report) => agents.reportRuntimeFailure(report),
        env: ({ cwd }) => {
          if (!cwd) throw new Error("Subagent has no working directory.");

          let environment = agents.environments.get(cwd);
          if (!environment) {
            environment = new NodeExecutionEnv({ cwd });
            agents.environments.set(cwd, environment);
          }
          return environment;
        },
      },
      context,
    );

    return agents;
  }

  async spawn(task: string, label: string, config: SpawnConfig) {
    this.assertOpen();
    this.addProvider(config.model.provider);

    const conversation = await this.harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: config.model.provider, modelId: config.model.id },
          thinkingLevel: config.thinking,
          extensions: [CodingTools],
          tools: CodingTools.tools!.filter((tool) =>
            config.tools.includes(tool.name),
          ),
          cwd: config.cwd,
          instructions: `${config.systemPrompt}\n\nYou are a delegated general-purpose agent in a separate conversation. The parent instructions describe its environment; your only executable tools are ${config.tools.length ? config.tools.join(", ") : "none"}. You have no extensions, MCP tools, or nested agents. Follow the task's edit scope and report evidence to the parent.`,
        },
      },
      context,
    );
    const watch = await conversation.watch(context);
    const id = `agent-${randomUUID().slice(0, 8)}`;
    const child: Child = {
      snapshot: {
        id,
        label,
        model: `${config.model.provider}/${config.model.id}`,
        status: "idle",
        pending: 0,
        activity: "ready",
      },
      conversation,
      watch,
      waits: new Set(),
      replies: new Map(),
      accountedUsage: {},
    };
    this.children.set(id, child);

    watch.start(async (call) => {
      if (call.kind !== "value" || this.closed) return;

      const live = call.value.docs["pi.live"] as LiveState | undefined;
      const tool = live?.tools?.find((slot) => slot.status === "running");
      child.snapshot.activity = tool
        ? `using ${toolName(tool.name)}`
        : live?.generation?.retry
          ? "waiting to retry the model request"
          : live?.generation
            ? "thinking"
            : child.snapshot.pending
              ? "queued"
              : "ready";
      this.changed();
    });

    await this.submit(child, task, "followUp");
    return { ...child.snapshot };
  }

  async send(id: string, task: string, delivery: "followUp" | "steer") {
    const child = this.child(id);
    await this.submit(child, task, delivery);
    return { ...child.snapshot };
  }

  list() {
    return [...this.children.values()].map((child) => ({ ...child.snapshot }));
  }

  async transcript(id: string) {
    const child = this.children.get(id);
    if (this.closed || !child) return undefined;

    const limit = 20;
    const failures: string[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await child.conversation.entries({}, 100, cursor, context);
      if (this.closed) return undefined;
      for (const entry of page.items) {
        const failure = describeFailure(entry);
        if (failure) failures.push(`#${entry.id} · ${failure}`);
        if (failures.length === limit) break;
      }
      cursor = page.next;
    } while (cursor && failures.length < limit);

    const { model, status, pending, activity } = child.snapshot;
    return {
      id,
      status,
      output: [
        `${id} · ${model} · ${status}`,
        ...(pending ? [`${activity} · ${pending} pending`] : []),
        ...(failures.length
          ? failures
          : ["No model or tool failures recorded."]),
      ].join("\n"),
    };
  }

  takePendingUsage() {
    if (this.closed) return undefined;
    const usage = this.pendingUsage;
    this.pendingUsage = undefined;
    return usage;
  }

  async result(id: string, submission?: number) {
    const child = this.child(id);
    const reply =
      submission === undefined
        ? [...child.replies.values()].at(-1)
        : child.replies.get(submission);
    if (!reply)
      return {
        ...child.snapshot,
        output:
          "No matching completed reply. A notification arrives when the task settles.",
      };

    const result = { ...reply };
    const truncated = truncateHead(result.output);
    if (!truncated.truncated) return result;

    const directory = await mkdtemp(join(tmpdir(), "pi-durable-subagent-"));
    const path = join(directory, `${id}.txt`);
    await writeFile(path, result.output, { mode: 0o600 });
    return {
      ...result,
      output: truncated.content,
      truncated: true,
      fullOutputPath: path,
    };
  }

  async stop(id: string) {
    const child = this.child(id);
    await child.conversation.abort(context);
    await Promise.all([...child.waits]);
    child.snapshot.status = "stopped";
    child.snapshot.activity = "stopped; context retained";
    this.changed();
    return { ...child.snapshot };
  }

  close() {
    return (this.closing ??= this.closeAll());
  }

  private async closeAll() {
    this.closed = true;
    await Promise.all(
      [...this.children.values()].map((child) => child.watch.stop()),
    );
    try {
      await this.harness.close(context);
      await Promise.all(
        [...this.children.values()].flatMap((child) => [...child.waits]),
      );
    } finally {
      await Promise.all(
        [...this.environments.values()].map((environment) =>
          environment.cleanup(context),
        ),
      );
    }
  }

  private addProvider(provider: string) {
    if (this.providers.has(provider)) return;

    this.models.setProvider({
      id: provider,
      name: provider,
      getModels: () =>
        this.parent.getAll().filter((model) => model.provider === provider),
      auth: {
        apiKey: {
          name: "Parent Pi authentication",
          resolve: () => this.parent.getProviderAuth(provider),
        },
      },
      stream: this.parent.stream.bind(this.parent),
      streamSimple: this.parent.streamSimple.bind(this.parent),
    });
    this.providers.add(provider);
  }

  private async submit(
    child: Child,
    task: string,
    delivery: "followUp" | "steer",
  ) {
    this.assertOpen();
    child.snapshot.pending++;
    child.snapshot.status = "running";
    child.snapshot.activity = "queued";
    this.changed();

    let submission: Submission;
    try {
      submission = await child.conversation.submit(
        { type: "input", content: task, whenBusy: delivery },
        context,
      );
    } catch (error) {
      child.snapshot.pending--;
      child.snapshot.status = child.snapshot.pending ? "running" : "failed";
      this.changed();
      throw error;
    }

    const wait = this.settle(child, submission);
    child.waits.add(wait);
    void wait.then(
      () => child.waits.delete(wait),
      () => {
        child.waits.delete(wait);
        this.reportFailure(
          `Subagent ${child.snapshot.id} could not finish handling submission ${submission.id}.`,
        );
      },
    );
  }

  private async settle(child: Child, submission: Submission) {
    let completion: Completion;
    let newReply = true;
    try {
      const settled = await submission.wait(context);
      if (settled.status === "done" && settled.type === "input") {
        const entry = await child.conversation.commit(
          (tx) => tx.entry(AssistantEntry, settled.answer),
          context,
        );
        const output =
          entry?.model
            ?.flatMap((message) =>
              message.role === "assistant"
                ? message.content.flatMap((part) =>
                    part.type === "text" ? [part.text] : [],
                  )
                : [],
            )
            .join("\n") ?? "";
        completion = {
          id: child.snapshot.id,
          label: child.snapshot.label,
          submission: submission.id,
          status: "completed",
          output,
        };
        newReply = child.answer !== settled.answer;
        child.answer = settled.answer;
      } else {
        const stopped = settled.reason === "aborted";
        completion = {
          id: child.snapshot.id,
          label: child.snapshot.label,
          submission: submission.id,
          status: stopped ? "stopped" : "failed",
          // Pi saves completion notices and tool results in the parent session.
          output: settled.reason ?? settled.status,
        };
      }
    } catch {
      completion = {
        id: child.snapshot.id,
        label: child.snapshot.label,
        submission: submission.id,
        status: "failed",
        output: "Could not read the child submission.",
      };
    }

    child.snapshot.pending--;
    child.snapshot.status = child.snapshot.pending
      ? "running"
      : completion.status === "completed"
        ? "idle"
        : completion.status;
    if (!this.closed) {
      try {
        const ledger = await this.harness.snapshot(
          UsageDoc,
          child.conversation.id,
          context,
        );
        if (ledger)
          completion.usage = this.accountForUsage(child, ledger.models);
      } catch (error) {
        // The harness reports storage failure through onReport.
        if (!(error instanceof SessionFailed))
          this.reportFailure(
            `Could not read usage for subagent ${completion.id}.`,
          );
      }
    }
    child.replies.set(submission.id, completion);
    this.changed();
    if (!this.closed && newReply) this.onComplete(completion);
  }

  private reportRuntimeFailure(report: Report) {
    const task = "task" in report ? report.task : undefined;
    const conversationId =
      task?.conversationId ??
      (report.kind === "extension_error" ? report.conversationId : undefined);
    const child =
      conversationId === undefined
        ? undefined
        : [...this.children.values()].find(
            ({ conversation }) => conversation.id === conversationId,
          );
    const source = child ? `Subagent ${child.snapshot.id}` : "Subagent";
    this.reportFailure(
      `${source} runtime failure (${report.kind.replaceAll("_", " ")}).`,
    );
  }

  private reportFailure(message: string) {
    if (this.closed) return;
    try {
      this.onFailure(message);
    } catch {
      // Reporting must not interrupt settlement or throw from wait cleanup.
    }
  }

  private accountForUsage(
    child: Child,
    models: UsageState["models"],
  ): UsageSummary {
    const summary: UsageSummary = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    };
    for (const [key, usage] of Object.entries(models)) {
      summary.input += usage.input;
      summary.output += usage.output;
      summary.cacheRead += usage.cacheRead;
      summary.cacheWrite += usage.cacheWrite;
      summary.cost += usage.cost.total;
      const previous = child.accountedUsage[key];
      const delta = previous ? combineUsage(usage, previous, -1) : usage;
      if (delta.totalTokens === 0 && delta.cost.total === 0) continue;

      this.pendingUsage = this.pendingUsage
        ? combineUsage(this.pendingUsage, delta, 1)
        : delta;
      child.accountedUsage[key] = usage;
    }
    return summary;
  }

  private child(id: string) {
    this.assertOpen();
    const child = this.children.get(id);
    if (!child) throw new Error(`Unknown subagent: ${id}`);
    return child;
  }

  private assertOpen() {
    if (this.closed) throw new Error("The subagent runtime has closed.");
  }

  private changed() {
    if (!this.closed) this.onChange(this.list());
  }
}

function describeFailure(entry: EntryRecord) {
  const message = entry.model?.[0];
  if (message?.role === "assistant" && message.stopReason === "error")
    return `model request failed (${modelErrorKind(message)})`;

  if (
    !ToolResultEntry.is(entry) ||
    message?.role !== "toolResult" ||
    !message.isError
  )
    return undefined;

  // Tool names and diagnostics may include model or tool output. Show only known values.
  const tool = toolName(message.toolName);
  const diagnostic = entry.data.diagnostics.find(
    ({ severity }) => severity === "error",
  );
  const code = diagnostic?.code;
  if (tool === "bash" && diagnostic?.code === "exit_code") {
    const exit = /^Command exited with code (\d{1,3})$/.exec(
      diagnostic.message,
    );
    if (exit) return `bash failed (exit code ${exit[1]})`;
  }
  switch (code) {
    case "invalid_arguments":
    case "tool_unavailable":
    case "tool_error":
    case "unsupported_image":
      return `${tool} failed (${code})`;
    default:
      return `${tool} failed`;
  }
}

function toolName(name: string) {
  return (
    CodingTools.tools!.find((tool) => tool.name === name)?.name ??
    "unknown tool"
  );
}

function modelErrorKind(message: AssistantMessage) {
  if (isContextOverflow(message)) return "context overflow";
  const error = message.errorMessage ?? "";
  const status =
    /^(?:HTTP )?([45]\d\d)\b/.exec(error) ??
    /^.* error \(([45]\d\d)\):/.exec(error);
  if (status) return `HTTP ${status[1]}`;
  return isRetryableAssistantError(message)
    ? "retryable error"
    : "provider error";
}

function combineUsage(first: Usage, second: Usage, sign: 1 | -1): Usage {
  return {
    input: first.input + sign * second.input,
    output: first.output + sign * second.output,
    cacheRead: first.cacheRead + sign * second.cacheRead,
    cacheWrite: first.cacheWrite + sign * second.cacheWrite,
    ...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
      ? {
          cacheWrite1h:
            (first.cacheWrite1h ?? 0) + sign * (second.cacheWrite1h ?? 0),
        }
      : {}),
    ...(first.reasoning !== undefined || second.reasoning !== undefined
      ? { reasoning: (first.reasoning ?? 0) + sign * (second.reasoning ?? 0) }
      : {}),
    totalTokens: first.totalTokens + sign * second.totalTokens,
    cost: {
      input: first.cost.input + sign * second.cost.input,
      output: first.cost.output + sign * second.cost.output,
      cacheRead: first.cost.cacheRead + sign * second.cost.cacheRead,
      cacheWrite: first.cost.cacheWrite + sign * second.cost.cacheWrite,
      total: first.cost.total + sign * second.cost.total,
    },
  };
}

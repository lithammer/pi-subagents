import {
  contentText,
  type ToolCall,
  type ToolResultMessage,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  CustomMessageEntry,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { openScriptedSession, type ScriptedReply } from "./scripted-pi.ts";

const childTask = "Start the child task.";
const steers = ["Include the first detail.", "Include the second detail."];
const childReply = "Answer covering the original task and both details.";
const deliveryWait = { interval: 10, timeout: 5_000 };

for (const [name, deliveryScenario] of [
  ["a merged child answer notifies the idle parent exactly once", "idle"],
  ["a merged child answer notifies the busy parent exactly once", "busy"],
  ["the parent can recover its queued child reply after Escape", "escape"],
] as const) {
  test(name, { timeout: 15_000 }, async (t) => {
    const startChild = gate();
    const childReplyHold = hold();
    const parentReplyHold = hold();
    const recoverPrompt = "Retrieve the skipped completion.";
    let parentCallsWithNotice = 0;
    let childId = "";
    let recoveryRequest: { id: string; submission: number } | undefined;
    let recovered: ToolResultMessage | undefined;
    const session = await openScriptedSession(
      t,
      reply,
      async (cwd) => {
        await writeFile(
          join(cwd, "fixture.txt"),
          "Child reads this between steers.\n",
        );
      },
      () => {
        startChild.open();
        childReplyHold.release();
        parentReplyHold.release();
      },
    );

    const parentRun = session.prompt(
      "Delegate the task and send both details.",
    );
    if (deliveryScenario === "idle") {
      await parentRun;
      assert.ok(session.isIdle);
    } else {
      await parentReplyHold.reached;
      assert.ok(session.isStreaming);
    }
    startChild.open();
    await childReplyHold.reached;
    assert.equal(
      completionNotices(session).length,
      0,
      "Child has not answered yet",
    );
    childReplyHold.release();

    if (deliveryScenario !== "idle") {
      await t.waitFor(
        () =>
          assert.ok(
            session.agent.hasQueuedMessages(),
            "Completion did not queue while the parent was busy",
          ),
        deliveryWait,
      );
      assert.equal(
        completionNotices(session).length,
        0,
        "Queued notice arrived before the parent finished",
      );
      if (deliveryScenario === "escape") {
        // Pi clears the queue before aborting when Escape restores queued text.
        session.clearQueue();
        const abort = session.abort();
        parentReplyHold.release();
        await abort;
        await parentRun;

        assert.equal(
          completionNotices(session).length,
          0,
          "Escape must drop the queued notice",
        );
        assert.equal(
          parentCallsWithNotice,
          0,
          "The dropped notice must not wake the parent",
        );
        const failures = customMessages(session, "durable-subagent-failure");
        assert.equal(
          failures.length,
          1,
          "Escape must show one delivery warning",
        );
        assert.ok(failures[0].display);
        const warning = contentText(failures[0].content);
        const childReference = /\bSubagent\s+(\S+)/i.exec(warning);
        const submissionReference = /\bsubmission\s+(\d+)\b/i.exec(warning);
        assert.ok(childReference, "The warning must identify the child");
        assert.ok(
          submissionReference,
          "The warning must identify the saved submission",
        );
        assert.match(warning, /subagent result/);
        recoveryRequest = {
          id: childReference[1],
          submission: Number(submissionReference[1]),
        };
        assert.equal(
          recoveryRequest.id,
          childId,
          "The warning must give the exact child ID",
        );
        await session.prompt(recoverPrompt);
        assert.ok(recovered, "The parent must receive the saved result");
        assert.equal(recovered.isError, false);
        const result = JSON.parse(contentText(recovered.content));
        assert.equal(result.id, childId);
        assert.equal(result.submission, recoveryRequest.submission);
        assert.equal(result.status, "completed");
        assert.equal(result.output, childReply);
        return;
      }
      parentReplyHold.release();
      await parentRun;
    } else {
      await t.waitFor(
        () =>
          assert.ok(
            completionNotices(session).length > 0,
            "Completion did not reach the idle parent",
          ),
        deliveryWait,
      );
    }
    await session.waitForIdle();

    // Stop waits for every submission handler before the final count.
    await session.prompt(`/agents stop ${childId}`);
    await session.waitForIdle();
    const delivered = completionNotices(session);
    assert.equal(
      delivered.length,
      1,
      "The shared answer must produce exactly one notice",
    );
    assert.equal(delivered[0].display, true);
    assert.ok(contentText(delivered[0].content).includes(childReply));
    assert.equal(
      parentCallsWithNotice,
      1,
      "The notice must reach the parent model once",
    );

    async function reply({
      messages,
    }: TranscriptContext): Promise<string | ToolCall[]> {
      const inputs = messages
        .filter((message) => message.role === "user")
        .map(({ content }) => contentText(content));
      if (inputs[0] === childTask) {
        const reads = messages
          .filter((message) => message.role === "toolResult")
          .filter((message) => message.toolName === "read");
        assert.ok(
          reads.every(({ isError }) => !isError),
          "Child reads must reach the steering boundary",
        );
        if (reads.length === 0) await startChild.wait;
        if (reads.length < steers.length) {
          return [
            toolCall(`read-${reads.length}`, "read", { path: "fixture.txt" }),
          ];
        }
        assert.deepEqual(
          inputs,
          [childTask, ...steers],
          "All child inputs must share this answer",
        );
        await childReplyHold.pause();
        return childReply;
      }

      if (inputs.at(-1)?.includes(childReply)) {
        parentCallsWithNotice++;
        return "Received the completion.";
      }
      const results = messages
        .filter((message) => message.role === "toolResult")
        .filter((message) => message.toolName === "subagent");
      assert.ok(
        results.every(({ isError }) => !isError),
        "Parent subagent calls must succeed",
      );
      if (inputs.at(-1) === recoverPrompt) {
        assert.ok(recoveryRequest);
        recovered = results.find(({ toolCallId }) => toolCallId === "recover");
        return recovered
          ? "Recovered the saved reply."
          : [
              toolCall("recover", "subagent", {
                action: "result",
                ...recoveryRequest,
              }),
            ];
      }
      if (results.length === 0) {
        return [
          toolCall("spawn", "subagent", { action: "spawn", task: childTask }),
        ];
      }
      if (results.length === 1) {
        const { id } = JSON.parse(contentText(results[0].content));
        assert.equal(typeof id, "string");
        childId = id;
        return steers.map((task, index) =>
          toolCall(`steer-${index}`, "subagent", {
            action: "send",
            delivery: "steer",
            id,
            task,
          }),
        );
      }
      assert.equal(
        results.length,
        1 + steers.length,
        "The parent must submit both steers",
      );
      if (deliveryScenario !== "idle") {
        await parentReplyHold.pause();
      }
      return "Finished the parent turn.";
    }
  });
}

test(
  "separate replies notify the parent, remain retrievable, and count once",
  { timeout: 15_000 },
  async (t) => {
    const tasks = [
      "Answer the first task.",
      "Answer again.",
      "Give a new answer.",
      "Answer the final task.",
    ];
    const answers = [
      "Same reply.",
      "Same reply.",
      "Earlier reply.",
      "Newest reply.",
    ];
    const usage = {
      input: 7,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 10,
      cost: {
        input: 0.125,
        output: 0.125,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.25,
      },
    };

    const { session, runTool, parentNotices } = await openSubagentSession(
      t,
      tasks[0],
      (inputs) => {
        const index = inputs.length - 1;
        assert.ok(
          index < tasks.length,
          "The child must receive each task once",
        );
        assert.deepEqual(inputs, tasks.slice(0, index + 1));
        return { text: answers[index], usage };
      },
    );

    const { id } = await runTool("spawn", { action: "spawn", task: tasks[0] });
    assert.equal(typeof id, "string");
    const submissions: number[] = [];
    for (const [index, answer] of answers.entries()) {
      if (index > 0) {
        await runTool(`send-${index}`, {
          action: "send",
          id,
          task: tasks[index],
        });
      }
      const notice = await waitForCompletion(t, session, index + 1);
      const text = contentText(notice.content);
      assert.ok(text.endsWith(answer));
      assert.equal(parentNotices.length, index + 1);
      assert.equal(parentNotices[index], text);
      const details = notice.details;
      assert.ok(
        details &&
          typeof details === "object" &&
          "id" in details &&
          "submission" in details,
        "The notice must identify its child and submission",
      );
      assert.equal(details.id, id);
      const { submission } = details;
      assert.ok(
        typeof submission === "number" && Number.isSafeInteger(submission),
      );
      submissions.push(submission);
      checkUsage(index);
    }

    const submission = submissions.at(-2);
    assert.ok(
      submission !== undefined,
      "The earlier submission must be recorded",
    );
    const result = await runTool("exact-result", {
      action: "result",
      id,
      submission,
    });
    assert.equal(result.id, id);
    assert.equal(result.status, "completed");
    assert.equal(
      result.submission,
      submission,
      "Result must identify the requested submission",
    );
    assert.equal(
      result.output,
      answers.at(-2),
      "Result must contain the requested reply",
    );
    checkUsage(answers.length);

    const latest = await runTool("latest-result", { action: "result", id });
    assert.equal(
      latest.output,
      answers.at(-1),
      "Omitted submission must return the latest reply",
    );
    assert.equal(latest.submission, submissions.at(-1));
    checkUsage(answers.length);

    await session.prompt(`/agents stop ${id}`);
    await session.waitForIdle();
    assert.equal(completionNotices(session).length, answers.length);
    assert.equal(parentNotices.length, answers.length);
    assert.equal(
      new Set(submissions).size,
      answers.length,
      "Each notice must identify a separate submission",
    );

    function checkUsage(chargedTurns: number) {
      const { tokens, cost } = session.getSessionStats();
      assert.equal(
        tokens.total,
        chargedTurns * usage.totalTokens,
        "Pi must charge each child turn once",
      );
      assert.equal(
        cost,
        chargedTurns * usage.cost.total,
        "Pi must charge each child turn's cost once",
      );
    }
  },
);

test(
  "child transcript keeps provider credentials out of the parent session",
  { timeout: 15_000 },
  async (t) => {
    const task = "Make a request the provider will reject.";
    const credential = "synthetic-provider-credential";
    const { session, runTool } = await openSubagentSession(t, task, () => ({
      error: `HTTP 401 request rejected with ${credential}`,
    }));

    const { id } = await runTool("spawn", { action: "spawn", task });
    await waitForCompletion(t, session, 1);
    const transcript = await runTool("transcript", {
      action: "transcript",
      id,
    });

    assert.ok(
      !JSON.stringify(session.sessionManager.getEntries()).includes(credential),
      "Parent session entries must omit the provider credential",
    );
    assert.match(transcript.output, /model request failed \(HTTP 401\)/);
  },
);

async function openSubagentSession(
  t: TestContext,
  childTask: string,
  reply: (inputs: string[]) => ScriptedReply,
) {
  let request: ToolCall | undefined;
  const parentNotices: string[] = [];
  const session = await openScriptedSession(t, async ({ messages }) => {
    const inputs = messages
      .filter((message) => message.role === "user")
      .map(({ content }) => contentText(content));
    if (inputs[0] === childTask) return reply(inputs);

    const prompt = inputs.at(-1);
    if (!request || prompt !== request.id) {
      assert.ok(prompt, "The parent must receive a completion or tool prompt");
      parentNotices.push(prompt);
      return "Received the completion.";
    }

    const callId = request.id;
    const answered = messages.some(
      (message) =>
        message.role === "toolResult" && message.toolCallId === callId,
    );
    return answered ? "Received the tool result." : [request];
  });

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

async function waitForCompletion(
  t: TestContext,
  session: AgentSession,
  count: number,
) {
  const notice = await t.waitFor(() => {
    const entry = completionNotices(session)[count - 1];
    assert.ok(entry, `Reply ${count} must notify the parent`);
    return entry;
  }, deliveryWait);
  await session.waitForIdle();
  return notice;
}

function completionNotices(session: AgentSession) {
  return customMessages(session, "durable-subagent-completion");
}

function customMessages(session: AgentSession, customType: string) {
  return session.sessionManager
    .getEntries()
    .filter(
      (entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === customType,
    );
}

function toolCall(
  id: string,
  name: string,
  args: ToolCall["arguments"],
): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

function hold() {
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

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
import { test } from "node:test";
import { openScriptedSession } from "./scripted-pi.ts";

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
  "the same child notifies twice for identical replies to separate tasks",
  { timeout: 15_000 },
  async (t) => {
    const firstTask = "Answer the first task.";
    const nextTask = "Answer the follow-up.";
    const spawn = "Start the child.";
    const followUp = "Send the child a follow-up.";
    const answer = "Same reply.";
    let childId = "";
    let parentCallsWithNotice = 0;
    const session = await openScriptedSession(t, async ({ messages }) => {
      const inputs = messages
        .filter((message) => message.role === "user")
        .map(({ content }) => contentText(content));
      if (inputs[0] === firstTask) {
        assert.deepEqual(
          inputs,
          inputs.length === 1 ? [firstTask] : [firstTask, nextTask],
          "The child must receive the follow-up as a separate task",
        );
        return answer;
      }
      const prompt = inputs.at(-1);
      if (prompt?.includes(answer)) {
        parentCallsWithNotice++;
        return "Received the completion.";
      }

      const results = messages.filter(
        (message) => message.role === "toolResult",
      );
      if (prompt === spawn) {
        const spawned = results.find(
          ({ toolCallId }) => toolCallId === "spawn",
        );
        if (!spawned) {
          return [
            toolCall("spawn", "subagent", { action: "spawn", task: firstTask }),
          ];
        }
        assert.equal(spawned.isError, false);
        childId = JSON.parse(contentText(spawned.content)).id;
        assert.equal(typeof childId, "string");
        return "Started the child.";
      }
      assert.equal(prompt, followUp);
      const sent = results.find(({ toolCallId }) => toolCallId === "send");
      if (!sent) {
        return [
          toolCall("send", "subagent", {
            action: "send",
            id: childId,
            task: nextTask,
          }),
        ];
      }
      assert.equal(sent.isError, false);
      return "Sent the follow-up.";
    });

    await session.prompt(spawn);
    await t.waitFor(
      () =>
        assert.ok(
          completionNotices(session).length >= 1,
          "The first reply must notify the parent",
        ),
      deliveryWait,
    );
    await session.waitForIdle();
    assert.equal(completionNotices(session).length, 1);
    assert.equal(parentCallsWithNotice, 1);

    await session.prompt(followUp);
    await t.waitFor(
      () =>
        assert.ok(
          completionNotices(session).length >= 2,
          "An identical follow-up reply must notify the parent again",
        ),
      deliveryWait,
    );
    await session.waitForIdle();
    await session.prompt(`/agents stop ${childId}`);
    await session.waitForIdle();
    const delivered = completionNotices(session);
    assert.equal(delivered.length, 2);
    const submissions = new Set<number>();
    for (const notice of delivered) {
      const text = contentText(notice.content);
      assert.ok(text.startsWith(`Subagent ${childId} `));
      assert.ok(text.endsWith(answer));
      const details = notice.details;
      assert.ok(
        details && typeof details === "object" && "submission" in details,
        "Each notice must identify its submission",
      );
      const { submission } = details;
      assert.ok(
        typeof submission === "number" && Number.isSafeInteger(submission),
        "Each notice must carry a valid submission ID",
      );
      submissions.add(submission);
    }
    assert.equal(
      submissions.size,
      2,
      "Each notice must identify a different submission",
    );
    assert.equal(parentCallsWithNotice, 2);
  },
);

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

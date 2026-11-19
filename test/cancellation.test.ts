import { contentText } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  hold,
  openScriptedSession,
  openSubagentSession,
  toolCall,
} from "./scripted-pi.ts";

test(
  "aborting the spawning parent leaves the child running",
  { timeout: 15_000 },
  async (t) => {
    const task = "Finish the child task.";
    const answer = "Child finished after the parent stopped.";
    const child = hold();
    const parent = hold();
    const notices: string[] = [];
    const session = await openScriptedSession(
      t,
      async ({ messages }, signal) => {
        const prompt = messages.filter(({ role }) => role === "user").at(-1);
        const text = prompt && contentText(prompt.content);
        if (text === task) {
          await child.pause();
          assert.equal(
            signal?.aborted,
            false,
            "Parent abort must leave the child request running",
          );
          return answer;
        }
        if (text?.endsWith(answer)) {
          notices.push(text);
          return "Received.";
        }
        if (
          messages.some(
            (m) => m.role === "toolResult" && m.toolCallId === "spawn",
          )
        ) {
          assert.ok(signal);
          signal.addEventListener("abort", parent.release, { once: true });
          await parent.pause();
          assert.ok(signal.aborted);
          return "Parent finished.";
        }
        return [toolCall("spawn", "subagent_spawn", { task })];
      },
      undefined,
      () => {
        child.release();
        parent.release();
      },
    );

    const run = session.prompt("Start the background task.");
    await Promise.all([parent.reached, child.reached]);
    await session.abort();
    await run;
    child.release();
    await t.waitFor(() => assert.equal(notices.length, 1), {
      interval: 10,
      timeout: 5_000,
    });
  },
);

test(
  "stopping an active child cancels its turn and permits another send",
  { timeout: 15_000 },
  async (t) => {
    const task = "Work until stopped.";
    const next = "Answer the next task.";
    const answer = "Finished the next task.";
    const child = hold();
    let first = true;
    const { session, runTool, parentNotices } = await openSubagentSession(
      t,
      task,
      async ({ messages }, signal) => {
        if (first) {
          first = false;
          assert.ok(signal);
          signal.addEventListener("abort", child.release, { once: true });
          await child.pause();
          assert.ok(signal.aborted, "Stop must abort the active model request");
          return "Interrupted.";
        }
        const prompt = messages.at(-1);
        assert.ok(prompt && prompt.role === "user");
        assert.equal(contentText(prompt.content), next);
        return answer;
      },
      undefined,
      child.release,
    );

    const { id } = await runTool("spawn", "spawn", { task });
    await child.reached;
    await runTool("stop", "stop", { id });
    await session.waitForIdle();
    const stopped = await runTool("stopped-result", "result", { id });
    assert.equal(stopped.status, "stopped");
    await runTool("resume", "send", { id, task: next });
    await t.waitFor(
      () => assert.ok(parentNotices.some((n) => n.endsWith(answer))),
      { interval: 10, timeout: 5_000 },
    );
    await session.waitForIdle();
    const resumed = await runTool("resumed-result", "result", { id });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.output, answer);
  },
);

test(
  "/agents stop cancels only the named child",
  { timeout: 15_000 },
  async (t) => {
    const targetTask = "Wait for the stop command.";
    const siblingTask = "Finish the sibling task.";
    const answer = "Sibling finished.";
    const target = hold();
    const sibling = hold();
    const { session, runTool, parentNotices } = await openSubagentSession(
      t,
      [targetTask, siblingTask],
      async ({ messages }, signal) => {
        assert.ok(signal);
        const prompt = messages.at(-1);
        assert.ok(prompt && prompt.role === "user");
        const turn =
          contentText(prompt.content) === targetTask ? target : sibling;
        signal.addEventListener("abort", turn.release, { once: true });
        await turn.pause();
        return turn === target ? "Target finished." : answer;
      },
      undefined,
      () => {
        target.release();
        sibling.release();
      },
    );

    const { id } = await runTool("spawn-target", "spawn", { task: targetTask });
    await runTool("spawn-sibling", "spawn", { task: siblingTask });
    await Promise.all([target.reached, sibling.reached]);
    await session.prompt(`/agents stop ${id}`);
    await session.waitForIdle();
    const stopped = await runTool("target-result", "result", { id });
    assert.equal(stopped.status, "stopped");
    sibling.release();
    await t.waitFor(
      () =>
        assert.ok(
          parentNotices.some((notice) => notice.endsWith(answer)),
          "The sibling must deliver its answer",
        ),
      { interval: 10, timeout: 5_000 },
    );
  },
);

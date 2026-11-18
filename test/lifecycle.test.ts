import { contentText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hold, openScriptedRuntime, toolCall } from "./scripted-pi.ts";

const task = "Run the shell until Pi closes the child.";
const spawnPrompt = "Start a background shell.";
const statusPrompt = "List the remaining subagents.";
const reply = "The old child finished.";
const wait = { interval: 10, timeout: 5_000 };

for (const [action, name] of [
  ["quit", "quit cleans up a running child without delivering a reply"],
  ["reload", "reload cleans up a running child without delivering a reply"],
  [
    "new session",
    "new session cleans up a running child without delivering a reply",
  ],
  ["tree", "tree navigation cleans up a running child and its widget"],
  ["cancel", "canceled tree navigation lets the child reply to its parent"],
  [
    "late reply",
    "a child reply during session_tree stays off the selected branch",
  ],
] as const) {
  test(
    name,
    { timeout: 15_000, skip: process.platform === "win32" },
    async (t) => {
      const treeHandler = hold();
      const { runtime, quit } = await openScriptedRuntime(
        t,
        async ({ messages }) => {
          const first = messages.find(({ role }) => role === "user");
          const last = messages.findLast(({ role }) => role === "user");
          if (first && contentText(first.content) === task) {
            return messages.some(({ role }) => role === "toolResult")
              ? reply
              : [
                  toolCall("shell", "bash", {
                    command:
                      "mkfifo shell.wait && exec 3<>shell.wait && " +
                      "printf '%s\\n' \"$$\" > shell.pid && read -r line <&3",
                  }),
                ];
          }

          const prompt = last && contentText(last.content);
          const usedTool = (id: string) =>
            messages.some(
              (message) =>
                message.role === "toolResult" && message.toolCallId === id,
            );
          if (prompt === spawnPrompt && !usedTool("spawn")) {
            return [toolCall("spawn", "subagent", { action: "spawn", task })];
          }
          if (prompt === statusPrompt && !usedTool("status")) {
            return [toolCall("status", "subagent", { action: "status" })];
          }
          return "Parent is idle.";
        },
        undefined,
        undefined,
        action === "cancel"
          ? {
              factory: (pi) => {
                pi.on("session_before_tree", async () => {
                  await treeHandler.pause();
                  return { cancel: true };
                });
              },
            }
          : action === "late reply"
            ? {
                beforeSubagents: true,
                factory: (pi) => {
                  pi.on("session_tree", () => treeHandler.pause());
                },
              }
            : undefined,
      );

      const initial = runtime.session;
      let widgetVisible = false;
      if (action === "tree" || action === "cancel" || action === "late reply") {
        await initial.bindExtensions({
          mode: "tui",
          uiContext: {
            ...initial.extensionRunner.getUIContext(),
            setWidget(key, content) {
              if (key === "durable-subagents")
                widgetVisible = content !== undefined;
            },
          },
        });
      }
      await initial.prompt("Create an earlier tree entry.");
      const target = initial.sessionManager.getLeafId();
      assert.ok(target);
      await initial.prompt(spawnPrompt);

      let pid: number | undefined;
      try {
        await t.waitFor(async () => {
          const path = join(runtime.cwd, "shell.pid");
          const reported = Number(await readFile(path, "utf8"));
          assert.ok(Number.isSafeInteger(reported) && reported > 0);
          pid = reported;
          process.kill(pid, 0);
        }, wait);
        assert.ok(pid, "The child shell must be running before cleanup");
        const shellPid = pid;

        switch (action) {
          case "quit":
            await quit();
            break;
          case "reload":
            await initial.reload();
            break;
          case "new session":
            assert.deepEqual(await runtime.newSession(), { cancelled: false });
            break;
          case "tree": {
            assert.ok(widgetVisible, "The working child must have a widget");
            const result = await initial.navigateTree(target);
            assert.equal(result.cancelled, false);
            assert.equal(
              widgetVisible,
              false,
              "Navigation must clear the old widget",
            );
            break;
          }
          case "cancel":
          case "late reply": {
            assert.ok(widgetVisible, "The working child must have a widget");
            const outgoing = initial.sessionManager.getLeafId();
            const navigation = initial.navigateTree(target);
            try {
              await treeHandler.reached;
              assert.equal(
                initial.sessionManager.getLeafId(),
                action === "cancel" ? outgoing : target,
              );
              await finishShell(runtime.cwd);
              await t.waitFor(
                () =>
                  assert.equal(
                    widgetVisible,
                    false,
                    "The child must finish while the earlier handler is still running",
                  ),
                wait,
              );
              if (action === "late reply") await initial.waitForIdle();
              assertNoChildNotice(initial);
            } finally {
              treeHandler.release();
              await navigation;
            }
            assert.equal((await navigation).cancelled, action === "cancel");
            if (action === "cancel") {
              await t.waitFor(() => {
                assert.ok(
                  initial.sessionManager
                    .getBranch()
                    .some(
                      (entry) =>
                        entry.type === "custom_message" &&
                        entry.customType === "durable-subagent-completion" &&
                        contentText(entry.content).includes(reply),
                    ),
                  "The child must still be able to reply to the outgoing branch",
                );
              }, wait);
              await initial.waitForIdle();
              pid = undefined;
              return;
            }
            break;
          }
        }

        await t.waitFor(() => {
          assert.throws(
            () => process.kill(shellPid, 0),
            { code: "ESRCH" },
            `Child shell ${shellPid} survived ${action}`,
          );
        }, wait);
        pid = undefined;

        const current = runtime.session;
        if (action !== "quit") {
          await current.waitForIdle();
          await current.prompt(statusPrompt);
          const status = current.messages.find(
            (message) =>
              message.role === "toolResult" && message.toolCallId === "status",
          );
          assert.ok(status && status.role === "toolResult");
          assert.equal(status.isError, false);
          assert.deepEqual(
            status.details ?? [],
            [],
            "Cleanup must leave no subagents",
          );
        }
        assertNoChildNotice(initial);
        if (current !== initial) assertNoChildNotice(current);
      } finally {
        if (pid !== undefined) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
    },
  );
}

async function finishShell(cwd: string) {
  const pipe = await open(
    join(cwd, "shell.wait"),
    constants.O_WRONLY | constants.O_NONBLOCK,
  );
  try {
    await pipe.writeFile("finish\n");
  } finally {
    await pipe.close();
  }
}

function assertNoChildNotice(session: AgentSession) {
  const notices = session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom_message" &&
        (entry.customType === "durable-subagent-completion" ||
          entry.customType === "durable-subagent-failure"),
    );
  assert.deepEqual(notices, [], "Lifecycle cleanup must not send old replies");
}

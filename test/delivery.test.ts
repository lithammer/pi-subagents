import { contentText, type ToolResultMessage } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { hold, openSubagentSession, toolCall } from "./scripted-pi.ts";

for (const delivery of [undefined, "followUp"] as const) {
  test(
    delivery
      ? "an explicit follow-up waits for the current child reply"
      : "a default follow-up waits for the current child reply",
    { timeout: 15_000 },
    async (t) => {
      const task = "Read the fixture and report its contents.";
      const nextTask = "Include a word count.";
      const firstReply = "The fixture says hello world.";
      const finalReply = "The fixture contains two words.";
      const firstTurn = hold();
      let modelCalls = 0;
      const { session, runTool, parentNotices } = await openSubagentSession(
        t,
        task,
        async ({ messages }) => {
          switch (++modelCalls) {
            case 1:
              await firstTurn.pause();
              return [
                toolCall("read-fixture", "read", { path: "fixture.txt" }),
              ];
            case 2: {
              const read = messages.find(
                (message): message is ToolResultMessage =>
                  message.role === "toolResult" &&
                  message.toolCallId === "read-fixture",
              );
              assert.ok(read, "The current tool call must finish");
              assert.equal(read.isError, false);
              assert.match(contentText(read.content), /hello world/);
              assert.deepEqual(
                messages
                  .filter(({ role }) => role === "user")
                  .map(({ content }) => contentText(content)),
                [task],
                "The current reply must see only the original task",
              );
              return firstReply;
            }
            case 3:
              assert.deepEqual(
                messages
                  .slice(-2)
                  .map((message) => [
                    message.role,
                    contentText(message.content),
                  ]),
                [
                  ["assistant", firstReply],
                  ["user", nextTask],
                ],
                "The follow-up must start after the current reply",
              );
              return finalReply;
            default:
              assert.fail("The child received an extra model turn");
          }
        },
        (cwd) => writeFile(join(cwd, "fixture.txt"), "hello world\n"),
        firstTurn.release,
      );

      const { id } = await runTool("spawn", "spawn", { task });
      await firstTurn.reached;
      await runTool("send", "send", {
        id,
        task: nextTask,
        ...(delivery && { delivery }),
      });
      assert.equal(modelCalls, 1, "Sending must leave the active turn running");
      firstTurn.release();

      await t.waitFor(
        () =>
          assert.ok(
            parentNotices.some((notice) => notice.endsWith(finalReply)),
            "The child must finish the sent task",
          ),
        { interval: 10, timeout: 5_000 },
      );
      await session.waitForIdle();
      await session.prompt(`/agents stop ${id}`);
      await session.waitForIdle();
      assert.equal(modelCalls, 3);
    },
  );
}

import { contentText } from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { test } from "node:test";
import { openSubagentSession } from "./scripted-pi.ts";

test(
  "spawn falls back to live auth when the cached provider list is stale",
  { timeout: 15_000 },
  async (t) => {
    const task = "Reply with hello.";
    const { runTool } = await openSubagentSession(t, task, () => "hello");
    // Pi keeps configured providers in a cache that a failed refresh leaves
    // stale. Make it say no while the live lookup still finds the key.
    const cached = ModelRegistry.prototype.hasConfiguredAuth;
    ModelRegistry.prototype.hasConfiguredAuth = () => false;
    t.after(() => {
      ModelRegistry.prototype.hasConfiguredAuth = cached;
    });

    const spawned = await runTool("spawn", "spawn", { task });
    assert.equal(
      spawned.model,
      "scripted/scripted",
      "An inherited spawn must start when only the auth cache is stale",
    );
  },
);

test("a rejected spawn starts no child", { timeout: 15_000 }, async (t) => {
  const task = "Reply with hello.";
  const { runTool, callTool } = await openSubagentSession(
    t,
    task,
    () => "hello",
  );

  // The scripted model has no reasoning, so it supports only "off".
  const rejected = await callTool("spawn", "spawn", {
    task,
    thinking: "high",
  });
  assert.equal(rejected.isError, true);
  assert.match(
    contentText(rejected.content),
    /does not support thinking level "high"/,
  );
  assert.deepEqual(
    await runTool("status", "status", {}),
    [],
    "Spawn must check the model before it creates a child",
  );
});

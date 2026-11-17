# Durable subagents prototype

A throwaway Pi extension: delegate work in the background, keep the child
conversation, and send it more work. This tests whether a small bridge to
upstream Durable can replace a broader subagent plugin.

**Use a disposable workspace first.** Children run local file and shell tools
with your OS permissions. They do not run parent permission hooks or custom
tool overrides. “Research only” is an instruction, not a sandbox.

## Run

Requires Pi 1.5.2 and Node 22.19 or newer. Dependencies are pinned to Durable
1.5.2, not a moving branch.

```sh
cd ~/dev/lithammer/pi-durable-subagents
npm ci --ignore-scripts
npm run check

cd /path/to/a/scratch/workspace
~/dev/lithammer/pi-durable-subagents/bin/pi-prototype
```

The launcher disables all other extensions for this invocation, including
pi-subagents, and loads only this prototype. It does not change Pi settings or
uninstall anything. Run normal `pi` to return to your usual setup.

Try this prompt:

> Use two background subagents to investigate different parts of this
> workspace. Research only; do not change files. Keep working while they run.
> When they finish, send one a follow-up question using its existing ID.

The parent gets one `subagent` tool:

| Action | Required fields | Behavior |
| --- | --- | --- |
| `spawn` | `task` | Returns an ID immediately; optional short `label` |
| `send` | `id`, `task` | Reuses the conversation; queues a follow-up by default |
| `result` | `id` | Returns the latest reply; optional `submission` selects an exact reply |
| `status` | None | Lists children and their current state |
| `stop` | `id` | Cancels current and queued work; retains the conversation |

For `send`, set `delivery: "steer"` to place a message at the next turn
boundary instead of waiting for the current task to finish. It does not
interrupt an in-flight model request or shell command.

Completion notifications identify the child and submission. A shortened
notification tells the parent how to fetch that exact reply. Results over
50 KB or 2,000 lines include a temporary file path holding the full answer.
Those overflow files remain in the OS temporary directory after Pi exits.

You can also use `/durable-agents` to list children and
`/durable-agents stop <id>` to stop one without asking the model.

## UI

Running children appear in a small widget above the editor, with their last
activity. Tool results and completion messages stay in the transcript; expand
them with Pi's tool-expansion key. Completion also wakes the parent, or queues
a follow-up if it is busy. No fleet view or separate child viewer is included.

## What runs where

```text
Pi CLI
  └── this extension
        └── Durable Harness + MemoryStorage
              ├── ownerless child conversation
              └── ownerless child conversation
```

Durable owns child conversations, turn scheduling, tool execution, message
queues, compaction, and cancellation. This extension bridges Pi's model
registry and authentication, admits child work, and delivers replies to Pi.

At spawn, a child receives the parent's current model, thinking level, working
directory, and system-prompt snapshot. It does not receive the parent's message
history. Existing children keep their original model and instructions;
new children use the parent's current selection.

Children use Durable's native `read`, `bash`, `edit`, and `write` tools, limited
to the names active in the parent at spawn. They do not inherit extensions,
MCP connections, agent Markdown definitions, or nested delegation. The prompt
snapshot carries the parent's instruction and skill text, but does not grant
the tools those instructions may mention. Image-file reading is not configured.

## Lifetime and limits

- Parent-turn cancellation leaves children running. Explicit `stop` cancels
  a child, which can accept another `send` afterward.
- Quit, reload, session replacement, or tree navigation closes all children.
  No reply from the old context is delivered into the new one.
- State lives in memory. Despite the Durable name, this prototype does not
  recover conversations or in-flight work after exit or a crash.
- Children share the workspace. There is no worktree isolation or concurrency
  limit; assign distinct file ownership if several agents may edit.
- Child spend is not added to Pi's parent-session usage totals. There is no
  aggregate cost display or budget guard.
- Durable's API is experimental. Keep the version pin until an upgrade has
  been checked against the bridge.

## Verification

`npm run check` typechecks the extension. Throwaway probes exercised a scripted
local provider through the real Pi CLI and SDK, with real file reads and shell
processes. They covered background overlap, retained context, queued follow-up,
steering, exact-reply lookup, overflow files, tool-name restrictions, provider
errors, cancellation, and cleanup on new/reload/tree boundaries. A terminal
smoke check exercised compact rendering at 90 and 48 columns.

The probes made no live Anthropic/OpenAI requests and were removed after use.
Peter's live session `01a1ea02-0cc0-7313-a058-3b3c34b56b50` then exercised
OpenAI Codex with `gpt-6.1-sol`: spawn returned in 10 ms, the parent continued,
and the child delivered a memory-usage report about 11 seconds later. The
completion woke the idle parent, which summarized the report.

Live session `01a1ea06-ae08-7653-95f1-221ac47c1247` also verified independent
parent work, two completion notifications, follow-up on the same child ID,
retained baseline figures, and exact-reply retrieval. The parent made six
`sleep` calls totaling 160 seconds before yielding for the first notification.
Follow-up notifications wait for the parent run to finish, so idle waiting
should end the turn rather than keep it busy with shell sleeps.

Live steering and Anthropic compatibility have not been exercised.

The upstream API notes are in [docs/durable-integration-research.md](docs/durable-integration-research.md).

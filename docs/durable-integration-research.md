# Durable integration notes

The prototype uses published `@earendil-works/pi-durable@1.5.2`.
Latest main was checked at `4afe78de1e51162c01c946dcf080e6a266685a01`
on November 17, 2026. The source checkout is read-only at
`~/.cache/checkouts/github.com/earendil-works/pi`.

## Boundaries

- `Harness` accepts a pi-ai `Models` collection. Pi's extension context exposes
  `ModelRegistry`, so the bridge delegates catalog, auth, and streaming to that
  registry. It does not read or copy credential files.
- The normal Pi parent is not a Durable conversation. Children are ownerless
  conversations; the extension closes them when the Pi session ends or changes.
  Background anchor tasks from upstream's example are not needed at this boundary.
- Ownerless conversations start without inherited agent configuration. The bridge
  copies model, thinking, cwd, and instructions explicitly at spawn.
- Durable `CodingTools` supplies read/write/edit/bash. `NodeExecutionEnv` supplies
  local execution. Both are upstream implementations, not adapted Pi CLI tools.
- `Conversation.submit()` admits work without waiting for its answer.
  `Submission.wait()` identifies the exact answer entry. `Conversation.abort()`
  cancels active work and queued inputs; it does not discard the conversation.
- `MemoryStorage` deliberately excludes restart recovery from this experiment.

## Upstream references

Paths below are relative to the pinned checkout:

- `packages/durable/README.md`: setup, ownership, watches, and busy-input behavior.
- `packages/durable/src/harness/types.ts`: conversation, submission, and registry contracts.
- `packages/durable/src/harness/agent.ts`: agent configuration and inheritance.
- `packages/durable/test/examples/22-subagent-background.ts`: background ownership
  and result delivery. Its reply helper uses a stale `content` field; current
  Durable tools return `output`. The prototype uses native tools instead.
- `packages/durable/test/examples/43-subagent-waits.ts`: a newer parked-task
  approach requiring APIs absent from published 1.5.2; not used here.
- `apps/p2/plugins/subagents/tools.ts`: a fuller implementation, coupled to p2.
  p2's README explicitly warns against depending on that application.

Published declarations under `node_modules/@earendil-works/pi-durable/dist/`
were checked against the implementation, especially `harness/types.d.ts`,
`tools/index.d.ts`, and `env/node.d.ts`.

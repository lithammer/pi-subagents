# From prototype to daily use

Support background research, review, and implementation in Pi. Keep model
inheritance and one general-purpose agent type.

## 1. End the parent turn when waiting

- [x] Tell the parent to end its turn when no useful work remains. Never run
  `sleep` or poll to wait for a child.
- [x] Verify that a completion wakes an idle parent and reaches a busy parent
  after its run ends, without being lost or delivered twice.
- [x] Repeat the live two-snapshot exercise without shell sleeps in the parent.

## 2. Fit the normal Pi setup

- [x] Load this package through Pi's normal package settings alongside other
  extensions. See the setup in [README.md](README.md).
- [x] Check coexistence with the normal parent tools, extensions, and MCP setup.
  Pi 1.5.2 ran built-in `read`, the installed `todo` extension, and a local MCP
  tool in the same session. The Slack MCP connection failed in the sandbox.
- [x] Verify that new children use the parent's current model and thinking level,
  while an existing child retains its original selection and conversation.
- [x] Limit support to trusted workspaces where children can run native tools
  directly. Durable's tools bypass parent permission hooks and custom overrides.

## 3. Show failures and spend

- [ ] Show child token usage and cost, and account for child spend in parent totals
  without counting it twice.
- [ ] Retain enough child transcript to diagnose failed model requests and tool
  calls. Define its lifetime and cleanup without exposing credentials.
- [ ] Surface runtime and completion-delivery failures in Pi, not only console logs.

## 4. Keep focused regression tests

Add tests for failures that would otherwise go unnoticed, not snapshots of the
current implementation.

- [ ] Lost or duplicate completion notifications, including merged steering inputs.
- [ ] Exact submission lookup after newer replies have arrived.
- [ ] Follow-up context retention, queued delivery, and steering boundaries.
- [ ] Parent cancellation leaving children alive, explicit child cancellation, and
  reuse after stop.
- [ ] Cleanup on quit, reload, session replacement, and tree navigation: no surviving
  shell processes or replies delivered into the wrong context.

## 5. Try real work before switching defaults

- [ ] Use the plugin for several real research and review tasks alongside the normal
  parent extensions. Note concrete failures and missing capabilities.
- [ ] Exercise an Anthropic model; live verification so far covers OpenAI Codex only.
- [ ] Decide whether the smaller feature set is sufficient, then switch the default
  setup or retain the experiment as opt-in.

## Outside the graduation requirements

Restart recovery, child MCP support, worktree isolation, scheduling, FleetView,
scripted workflows, and specialist agent presets are optional. Keep memory-only
children as an explicit contract unless real use justifies persistence.

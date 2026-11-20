# pi-subagents

A Pi extension for delegating research, review, and coding to agents that run
in the background.

- Keep working while agents run. Pi notifies you when they finish.
- Completion notices show each agent's cumulative token usage and cost. Pi
  adds pending child spend to its session totals on the next subagent tool call.
- New agents use your current model and thinking level, unless you ask for
  another, for example "use openai-codex/gpt-6-sol at high thinking". The
  provider must be logged in to Pi. Send a follow-up to the same agent to keep
  its model, thinking level, and conversation.
- Run `/agents` to list agents or `/agents stop <id>` to stop one. Agents
  live for the current Pi session.

## Install and try

Install with Pi 1.6.0 and Node.js 22.19 or newer.

```sh
pi install git:github.com/lithammer/pi-subagents
```

Start Pi and try this prompt.

> Ask a background agent to explain how to build and test this repo. Keep it read-only.

To uninstall, run `pi remove git:github.com/lithammer/pi-subagents` and restart Pi.

### Local development

Run these commands from your checkout.

```sh
npm ci
pi install "$PWD"
```

To uninstall the local copy, run `pi remove "$PWD"` from the same checkout and restart Pi.

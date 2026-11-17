# pi-subagents

A Pi extension for delegating research, review, and coding to agents that run
in the background.

- Keep working while agents run. Pi notifies you when they finish.
- New agents use your current model and thinking level. Send a follow-up to
  the same agent to keep its model, thinking level, and conversation.
- Run `/agents` to list agents or `/agents stop <id>` to stop one. Agents
  live for the current Pi session.

## Install and try

With Pi 1.5.2 and Node.js 22.19 or newer, run these commands from this checkout.

```sh
npm ci
pi install "$PWD"
```

Start Pi and try this prompt.

> Ask a background agent to explain how to build and test this repo. Keep it read-only.

To uninstall, run `pi remove "$PWD"` from this checkout and restart Pi.

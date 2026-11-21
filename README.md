# pi-subagents

A Pi extension for delegating research, review, and coding to agents that run
in the background.

Pi keeps working while agents run and tells you when they finish. Agents
use your current model and thinking level unless you ask for another, and
live for the current Pi session.

Run `/agents` to list them, `/agents stop` to stop one, or `/agents diagnose`
to see why one is stuck or failed.

Use it only in workspaces you trust: agents run `read`, `bash`, `edit`, and
`write` with your OS permissions and skip the parent's permission hooks.

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

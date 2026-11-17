# Durable subagents

A Pi extension for background agents, built on upstream Durable. Agents inherit
the parent's model, keep their own conversation for follow-up work, and notify
the parent when they finish.

This is a memory-only prototype: child conversations do not survive exit.
Children run with your OS permissions and bypass parent permission hooks and
custom tool overrides.

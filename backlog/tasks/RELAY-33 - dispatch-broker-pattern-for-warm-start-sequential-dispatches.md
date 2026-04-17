---
id: RELAY-33
title: 'dispatch: broker pattern for warm-start sequential dispatches'
status: To Do
labels: []
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Context

When running sequential dispatches (e.g. Release 11: #231→#236), each dispatch spawns a fresh `codex app-server` process. The startup cost adds up.

codex-plugin-cc solves this with a **broker** — a Unix socket proxy that keeps one `codex app-server` alive across multiple invocations.

## Current State (updated 2026-04-05)

As of #65, dispatch.js supports Codex + Claude Code executors. Sequential dispatches still spawn fresh processes for each run. The broker pattern only applies to Codex app-server, making this a Codex-specific optimization.

**Still relevant if:**
- Batch relay operations become frequent (many dispatches in sequence)
- App-server migration (#32) is completed first

**Reduced urgency because:**
- #32 (app-server migration) is itself backlogged
- Current sequential dispatch overhead is tolerable for typical batch sizes

## Proposal

After app-server migration (#32), add an optional broker mode:

1. First dispatch starts broker + app-server, writes socket path to state file
2. Subsequent dispatches connect to existing broker
3. Broker returns `-32001` (BUSY) if a turn is active; client waits or falls back to direct spawn
4. Session cleanup kills broker at end

## Prerequisites

- Depends on #32 (app-server migration)

## References

- Analysis: `docs/codex-app-server-analysis.md`
- Pattern source: `references/codex-plugin-cc/plugins/codex/scripts/lib/broker-lifecycle.mjs`
- Pattern source: `references/codex-plugin-cc/plugins/codex/scripts/app-server-broker.mjs`

## Effort

Large — broker process, socket management, session lifecycle, fallback logic.

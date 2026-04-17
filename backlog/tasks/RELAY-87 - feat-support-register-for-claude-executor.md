---
id: RELAY-87
title: 'feat: support --register for Claude executor'
status: To Do
labels:
  - backlog
priority: medium
milestone: 
created_date: '2026-04-12'
---
## Description
## Context

`dispatch.js:671-676` explicitly restricts `--register` to Codex executor only:

```js
if (REGISTER && EXECUTOR !== "codex" && !JSON_OUT) {
  console.log(`\n  Warning: --register is only supported for codex executor`);
}
```

The README describes app registration as "executor-agnostic" but this is currently not true.

## Acceptance Criteria

- [ ] `--register` flag works with `--executor claude`
- [ ] Claude executor registration creates a comparable session record to Codex's app thread
- [ ] Warning at `dispatch.js:674` removed or made conditional

## Context from CEO Review

Found during outside voice (Codex) review of README accuracy. The README claims executor-agnostic registration, so the code should match.

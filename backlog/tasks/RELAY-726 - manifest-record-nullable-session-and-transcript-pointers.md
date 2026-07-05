---
id: RELAY-726
title: 'manifest: record nullable session and transcript pointers'
status: To Do
labels:
  - enhancement
  - workflow
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
Parent: #718
Related: #439

## Problem

Run, review, and fleet artifacts can be reconstructed after the fact, but transcript/session lookup is expensive because manifests do not record stable pointers.

Relay should not store full transcripts. It should record nullable pointers when executor/reviewer adapters know them.

## Scope

Add minimal pointer fields to run manifests and/or route artifacts for audit recovery.

This is persistence plumbing, not model judgment.

## Proposed fields

- orchestrator session pointer
- executor session pointer
- reviewer session pointer
- executor transcript id/path
- reviewer transcript id/path
- execution evidence path
- browser evidence path

## Acceptance criteria

- Manifest schema accepts nullable pointer fields without requiring every adapter to populate them.
- Codex/Claude app registration paths populate what they already know without guessing missing values.
- Pointers are recorded as references only; transcript bodies are not copied into relay storage.
- Sensitive/local path concerns are documented.
- Tests cover absent pointers, populated pointers, and manifest round-trip stability.

## Non-goals

- No transcript database.
- No attempt to scrape transcripts that adapters cannot expose.
- No required pointer for legacy runs.


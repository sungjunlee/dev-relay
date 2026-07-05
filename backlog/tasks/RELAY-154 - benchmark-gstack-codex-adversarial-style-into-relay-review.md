---
id: RELAY-154
title: Benchmark gstack-codex adversarial style into relay-review
status: To Do
labels:
  - enhancement
  - backlog
priority: medium
milestone: 
created_date: '2026-07-05'
---
## Description
## Summary

The gstack-codex `challenge` mode surfaced **9 substantive findings** on PR #147 that relay-review's 6 sequential rounds missed — including real production bypasses (file deletion after dispatch, path escape, branch-reuse manifest inheritance, skip-path rubric bypass) and a sharp critique of compliance-theater rounds.

Relay-review is currently collaborative-critical (find issues the executor should fix). gstack-codex challenge is adversarial (try to break it; think like an attacker; no compliments). Different mode, different yield. Benchmark the style difference and decide which pieces to adopt.

## Observed style difference (empirical, from PR #147)

| Dimension | relay-review (6 rounds) | gstack-codex challenge (1 pass) |
|-----------|-------------------------|---------------------------------|
| Findings that were genuine code gaps | 4 rounds × 1-3 issues | 9 findings in 1 pass |
| Bypass vectors found | 0 explicit | 4 (file delete, path escape, branch reuse, skip-path) |
| Test-suite critique | 0 | "suite mostly proves bypasses work, not enforcement" |
| Compliance-theater detection | 0 (round 5 was theater, reviewer acknowledged but scored it as contract fail) | Round 4 + 5 explicitly called out as theater |
| Token spend | ~50-80k per round × 6 | 1.23M single pass |
| Latency | ~10-20 min × 6 = 1h 40min | ~5 min |

relay-review is thorough about rubric compliance. It's not adversarial about invariant surface area. Both styles are useful; neither replaces the other. But right now relay-review's rubric-grep-driven grading reinforces compliance thinking.

## Design options

### Option 1 (minimal): Add an adversarial pass after LGTM
When a round verdicts `lgtm`, run one final `codex exec --sandbox read-only` with the challenge prompt (adversarial, try-to-break, no-compliments, specific file:line). If challenge finds `[P1]` severity issues, demote verdict back to `changes_requested` and feed findings into round N+1's redispatch prompt. Otherwise merge with challenge report attached.

**Pros**: additive, doesn't disrupt rubric-based protocol. Catches exactly what PR #147 landed with.
**Cons**: adds ~5 min + ~1M tokens per PR. Risks "forever round" if challenge always finds something.

### Option 2 (medium): Second-opinion reviewer role
Add a `roles.adversary` field to the relay manifest. Every N-th round (or every round for high-stakes tasks), invoke the adversary alongside the normal reviewer. Verdicts must agree (or adversary's verdict wins if more restrictive).

**Pros**: codifies the two-reviewer pattern. Independent context for adversary prevents rubric-bias.
**Cons**: doubles review token cost. Manifest schema change. Role-binding complexity.

### Option 3 (structural): Challenge-mode rubric factors
Add quality-tier factors keyed on "attack surface" themes: "List 3 paths where this enforcement could be bypassed", "Write a test that attempts to defeat the invariant", etc. Reviewer must answer these explicitly, which forces adversarial framing within the rubric.

**Pros**: no new reviewer role. Rubric authoring becomes the locus of adversarial thinking. Reusable across tasks.
**Cons**: depends on rubric-author discipline. Doesn't catch rubric-grading loopholes (like round 5's grep-pattern compliance).

### Option 4 (hybrid): Challenge-mode as an opt-in tier
Rubric YAML gets a new `challenge:` section listing "try to break" prompts. When set, relay-review runs the normal rubric scoring AND a challenge pass. LGTM requires both to pass.

**Pros**: opt-in per task. High-stakes PRs get adversarial; low-stakes don't pay the cost.
**Cons**: decision load on planner ("do I need challenge mode?"). Easy to forget.

## Recommended next step

1. **Read the gstack-codex skill source** (`~/.claude/skills/gstack-codex/` — specifically the challenge prompt template) and compare against `skills/relay-review/references/reviewer-prompt.md`
2. **Post-mortem PR #147**: take the 9 findings codex produced and ask "what rubric language or review protocol change would have caused relay-review to find each one?" This is the empirical design input.
3. **Prototype Option 1** on a single future PR — measure latency + token cost + marginal finding count vs. baseline
4. **Decide**: adopt Option 1, 2, 3, 4, or "don't adopt" based on prototype data

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] Design doc `docs/relay-review-adversarial-benchmark.md` with the 9 findings from PR #147 mapped against "what change would have caught this"
- [ ] Prototype implementation of Option 1 on a feature branch (not merged)
- [ ] Single-PR comparison: run relay-review with and without the adversarial pass, report diff in findings, latency, token cost
- [ ] Decision recorded in `backlog/sprints/_context.md` under "Architecture Decisions" (or new ADR file)
- [ ] If adopted: SKILL.md + reviewer-prompt updated; otherwise: close with rationale
<!-- AC:END -->

## Priority

**Enhancement / idea** — not urgent, but high-leverage. The review process is the trust boundary that gates every PR; improving it compounds.

## Context

- gstack-codex location: `~/.claude/skills/gstack-codex/SKILL.md` (Challenge mode at Step 2B)
- PR #147 adversarial review output captured in session log (2026-04-12, codex 1.23M tokens, 9 findings)
- Related: any Phase 2+ of agentic-patterns-adoption doc

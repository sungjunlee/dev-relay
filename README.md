# dev-relay

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

**Delegate implementation to AI agents. Keep planning, review, and merge decisions in your hands.**

dev-relay is a bundle-installed relay runtime exposed through thin skill command surfaces. It turns a task handoff into a repeatable plan -> dispatch -> review loop. An executor agent implements the work in an isolated worktree, then an independent reviewer agent checks the PR in a fresh context against the frozen acceptance criteria. If the implementation misses the mark, relay sends it back with targeted review feedback. When the review passes, the PR stops at `ready_to_merge` until you explicitly land it.

## Who Is This For

dev-relay is built for developers who already use AI coding agents and want a stronger handoff boundary than "I prompted it, then I reviewed my own prompt." It is most battle-tested for solo developers, but the same audit trail and review isolation also fit small teams and maintainers evaluating AI-generated PRs.

## How It Flows

```text
You / orchestrator
  |
  +-- /relay natural-language handoff
        |
        +-- plan + rubric
        +-- executor implements in a worktree
        +-- PR opens on GitHub
        +-- reviewer checks in a fresh context
        +-- re-dispatch until LGTM or escalation
        +-- ready_to_merge
  |
  +-- /relay-merge when you decide to land it
```

The normal public operator surface is:

| Skill | Use it for |
| --- | --- |
| `/relay-config` | Configure company/personal route policy, OpenCode/Pi opt-ins, sidecars, and advisory review defaults |
| `/relay` | Hand off an issue, sprint item, or natural-language task and run through review |
| `/relay-merge` | Explicitly merge a reviewed PR and clean up relay state |

The lower-level phase skills still exist for advanced operations and debugging, but most day-to-day use should start with `/relay`. See [references/operator-surface.md](references/operator-surface.md) for the public/internal/optional surface tiers and [docs/relay-operator-guide.md](docs/relay-operator-guide.md) for manual phase control, batch dispatch, sidecars, extension points, and recovery tools.

## Install

```bash
npx skills add sungjunlee/dev-relay
```

Add `-g -y` for global install without prompts:

```bash
npx skills add sungjunlee/dev-relay -g -y
```

<details>
<summary>Install from a local clone</summary>

```bash
git clone https://github.com/sungjunlee/dev-relay.git
cd dev-relay
npx skills add . -g -y
```
</details>

### Prerequisites

- [Claude Code](https://claude.ai/code) or [Codex](https://chatgpt.com/codex)
- Optional agent harness CLIs for `opencode`, `pi`, `antigravity`, or `cursor` when selecting those adapters; route policy must allow the selected provider/model route.
- [`gh` CLI](https://cli.github.com/) authenticated with `gh auth login`
- Git 2.20+
- Node.js 18+

Adapter minimum versions, binary overrides, timeouts, capability gates, and provider-specific limits live in [skills/relay-dispatch/references/agent-adapter-platform.md](skills/relay-dispatch/references/agent-adapter-platform.md).

## Configure Routes

Relay distinguishes CLI harnesses from provider/model routes. Names such as `codex`, `claude`, `opencode`, `pi`, and `antigravity` describe how relay invokes an agent. The compliance boundary is the provider/model route, for example `kakao/opencode-glm-5-fp8`, `opencode-go/deepseek-v4-pro`, or `google/antigravity-cli`.

Without a policy file, relay stays conservative: managed Codex and Claude CLIs are allowed by default, while OpenCode, Pi, Antigravity, advisory reviewers, and sidecars require explicit route approval.

After installing skills, ask for setup in plain language:

```text
/relay-config Set up relay for my company environment. Only allow OpenCode through kakao/opencode-glm-*.
$relay-config For my personal setup, use opencode-go/deepseek-v4-pro for sidecar and advisory review.
```

Common starting points:

| Setup | Recommended request |
| --- | --- |
| Company default | `/relay-config Set up relay for my company environment` |
| Company internal OpenCode | `/relay-config Only allow OpenCode through the kakao/opencode-glm-* route at work` |
| Personal sidecars | `$relay-config Use opencode-go/deepseek-v4-pro for personal sidecar and advisory review` |
| Managed only | `/relay-config Keep the default Codex/Claude-only setup` |

For the full policy model and precedence order, see [docs/model-route-policy.md](docs/model-route-policy.md).

## Quick Start

Use `/relay` like a natural-language handoff:

```text
/relay Work through the issues above
/relay Handle the README setup documentation issue
/relay Fix the login redirect bug and open a reviewed PR
```

Short handles also work when they are convenient:

```text
/relay 42
/relay issue #42
```

Relay reads issue references, sprint context, backlog notes, or the task description you give it. It clarifies ambiguous work when needed, builds a rubric, dispatches an executor in a worktree, reviews the resulting PR, and stops at `ready_to_merge`. Use `/relay-merge` only when you explicitly want to land the reviewed PR.

## What You Get

| Concern | Without relay | With relay |
| --- | --- | --- |
| Review independence | Same context as the prompt | Reviewer has no memory of the plan |
| Audit trail | Chat history, maybe | Manifest, event journal, and PR comments |
| Scope drift | Easy to miss | Checked each review round |
| Iteration | Manual back-and-forth | Re-dispatch with prior review feedback |
| Working tree safety | Agent edits your checkout | Isolated git worktree |
| Merge safety | Trust and merge | Stale-review gate before merge |

## Design Notes

Relay is manifest-backed. Each run is stored under `~/.relay/runs/<repo-slug>/` with assigned role bindings, policy fields, review anchors, and an append-only event journal. Review-time overrides record the acting reviewer separately instead of mutating the assigned role binding.

GitHub PRs are the handoff boundary between executor and reviewer. The reviewer scores the diff against acceptance criteria and the rubric, not against the original prompt. Terminal runs are either merged or explicitly closed.

For the full architecture, see [references/architecture.md](references/architecture.md). For operator usage and advanced workflows, see [docs/relay-operator-guide.md](docs/relay-operator-guide.md).

## Limitations

- GitHub is currently required for PR handoff, review comments, gate checks, and merge flow.
- Nested Codex executor runs may need `--network-access enabled` for networked quality gates or PR/API calls.
- Antigravity dispatch has route-specific healthy live canary evidence for `google/antigravity-cli`; Antigravity primary and advisory review remain fail-safe experimental until healthy live reviewer canaries pass. Fake-bin tests alone do not prove live executor or reviewer success. See [docs/relay-operator-guide.md#antigravity-live-canary](docs/relay-operator-guide.md#antigravity-live-canary).
- Sprint-file automation works, but some sprint status updates can still require manual intervention.

## Contributing

Issues and PRs welcome. Please open an issue first for non-trivial changes.

Useful references:

- [docs/relay-operator-guide.md](docs/relay-operator-guide.md) — operator workflow, manual phase control, sidecars, batch mode, and recovery tools
- [docs/README.md](docs/README.md) — documentation index
- [references/architecture.md](references/architecture.md) — manifest schema, state transitions, and extension points
- [CLAUDE.md](CLAUDE.md) — project structure and working conventions

Run the test suites:

```bash
node --test tests/relay-ready/scripts/*.test.js
node --test tests/relay-plan/scripts/*.test.js
node --test tests/relay-dispatch/scripts/*.test.js
node --test tests/relay-review/scripts/*.test.js
node --test tests/relay-merge/scripts/*.test.js
node --test tests/relay-config/scripts/*.test.js
```

## License

MIT

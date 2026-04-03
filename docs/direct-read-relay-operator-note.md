# Direct-Read Relay Operator Note

Use this path when you want to operate relay from a local checkout of `dev-relay` without installing the skill package.

## Source of Truth

Start with `skills/relay/SKILL.md` in the checkout you are operating on. That file is the operator entry point for the full relay flow.

When `skills/relay/SKILL.md` calls into a phase-specific workflow, keep reading the files from the same repo:

- `skills/relay-dispatch/SKILL.md`
- `skills/relay-review/SKILL.md`
- `skills/relay-merge/SKILL.md`

Do not rely on globally installed skills for this path. The repo-local `SKILL.md` files are the source of truth for the checkout in front of you.

## Operator Flow

1. Start Codex in the target repo with `-C <repo-path>`.
2. Tell Codex to read `skills/relay/SKILL.md` from disk before it does any relay work.
3. Let that file drive the workflow, opening the phase skill files above when the relay steps require them.
4. Keep every relay command and follow-up step scoped to the same repo checkout.

## Fresh-Session Example

```bash
codex exec -C /Users/sjlee/workspace/active/harness-stack/dev-relay --full-auto "
Operate directly from the repo checkout. Do not rely on installed skills.

Repo root: /Users/sjlee/workspace/active/harness-stack/dev-relay

Read these files first:
- /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay/SKILL.md
- /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-dispatch/SKILL.md
- /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-review/SKILL.md
- /Users/sjlee/workspace/active/harness-stack/dev-relay/skills/relay-merge/SKILL.md

Use the repo-local skill files as the source of truth and run the relay operator flow against this repo.
"
```

If you only need one phase, start from the matching repo-local skill file. For the full operator path, always start with `skills/relay/SKILL.md`.

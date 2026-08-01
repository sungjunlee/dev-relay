# relay-fleet /goal session persistence

## Why this exists

`relay-fleet` is deliberately daemonless. There is no background coordinator,
heartbeat, or watcher chain; a fleet progresses only while an operator is
actively running the foreground commands. If that session dies, the fleet pauses
until the same drive command is re-run to derive child records and retry leaves
which have no run record.

For long fleets, the operator can use the host harness `/goal` feature to keep a
single orchestrating session driving the fleet to completion. `/goal` is a slash
command in Claude Code 2.1.139+ and Codex CLI. The operator activates it with a
condition string; the orchestrating agent cannot activate it for them.

Two consumers read the active goal: the main model treats it as a directive, and
a separate evaluator model decides done/not-done after every turn. The evaluator
cannot run tools and sees only the condition plus the conversation transcript.
Therefore a working condition MUST name a transcript-visible check command and a
measurable end state. It must state the end state, not the operator process:
"run the fleet commands after each change" is unenforceable, while "the status
JSON appears in the conversation and shows the fleet is closed" is checkable.

## Condition template

After the initial fan-out has created the fleet, the operator fills `<fleet-id>`
and `<N>`, then activates:

```text
/goal Keep driving relay-fleet <fleet-id> until this exact check command has been run and its output appears in the conversation transcript:

node skills/relay-fleet/scripts/relay-fleet.js --repo . --fleet-id <fleet-id> --status --json

Done means that JSON output contains `"fleet_state": "closed"` and every child is `merged`. Stop and report blocked instead if the same child cannot advance for <N> consecutive turns, or if <N> total turns pass without transcript-visible status output showing that end state.
```

## Operating loop

The loop is safe because the cohort is immutable and status is derived. Re-running
it never repairs fleet state: it sees each matching child record afresh and
retries only leaves with no child record.

On each orchestrator turn, re-run the same foreground drive command with the
same fleet id and, when available, the same leaves file:

```bash
node skills/relay-fleet/scripts/relay-fleet.js --repo . --fleet-id <fleet-id> --leaves-file <leaves-file>
node skills/relay-fleet/scripts/relay-fleet.js --repo . --fleet-id <fleet-id> --status --json
```

If the leaves file is unavailable after the cohort has been created, omit
`--leaves-file`; the command reads the immutable cohort.

The final `--status --json` command is load-bearing. Its output must appear in
the conversation transcript so the separate evaluator can decide whether the
condition is done.

## Sprint-level variant

The same pattern works one level up for sprint execution. The condition's end
state becomes "every Plan item in the active sprint file is `[x]`", and the
check command must print either that sprint file or a sprint-state JSON summary
into the conversation transcript. The single drive command can fan out, resume,
review, merge, and refresh fleet status underneath it, but the evaluator-friendly
proof remains the transcript-visible sprint check showing all Plan items
complete.

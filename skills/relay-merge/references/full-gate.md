# Full-suite gate runner

Use `run-full-gate.js` to serialize the expensive pre-merge suite across all
relay sessions on one machine:

```bash
node skills/relay-merge/scripts/run-full-gate.js --repo . --json
```

The default suite set is the nine CI globs for `relay-ready`, `relay-plan`,
`relay-dispatch`, `relay-review`, `relay-merge`, `relay`, `relay-config`,
`relay-fleet`, and `skills-lint`. Files run one at a time. Override them with a
quoted, comma-separated `--suites` glob set. Evidence defaults to
`<repo>/.relay/full-gate-<timestamp>-<invoker-pid>.log`; `--output` selects a
stable operator path. `<output>.done` is the completion sentinel.

The detached runner owns `~/.relay/locks/full-gate.lock`, which records its
`pid`, `pgid`, `host`, and `started_at`. The foreground command waits for the
sentinel, but terminating that invoker does not terminate the runner. A later
invocation honors a live owner, reclaims a dead local owner, and bounds its wait
with `--lock-timeout` (600 seconds by default).

Evidence contains a section headed `===== <file> =====` for every test file,
one `FAILED_FILE: <file>` line per failure, and `TOTAL_FAILED_FILES: N` plus
`TOTAL_FILES: N`. It is operator-readable evidence only; the `recover-commit
--test-result-file` surface that once consumed it was deleted with the recovery
command family.

Exit code 0 means all selected files passed, 1 means at least one suite file
failed, 2 means the lock wait timed out, and 3 means invocation or runner
failure. JSON output reports `result`, `duration_ms`, evidence paths, totals,
and `lock_wait` details.

## Kill discipline

Never pattern-kill relay or test processes (`pkill -f` is forbidden). Patterns
can match unrelated gates, agents, and invokers from other sessions.

When stopping owned work, read the lock or lease artifact, verify that its
owner belongs to the operation you intend to stop, and signal only its recorded
process group ID (for example, `kill -- -<pgid>`). The full-gate runner is a
detached process-group leader, so its recorded `pid` and `pgid` are normally
equal. Do not signal a PID or PGID copied from stale terminal output; re-read
the ownership file immediately before acting.

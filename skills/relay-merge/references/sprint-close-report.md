# Sprint Close Report

`sprint-close-report.js` is a report-only operator utility for the end of a sprint. Run it after the last PR in the sprint has merged and the sprint file's Plan checklist reflects the completed issue set.

```bash
node skills/relay-merge/scripts/sprint-close-report.js --repo . --sprint backlog/sprints/<sprint-file>.md --threshold 9 --min-runs 2
```

Flags:

- `--repo <path>`: repository root used to resolve relay manifests. Defaults to `.`.
- `--sprint <path>`: sprint markdown file containing the Plan checklist. Required.
- `--threshold N`: minimum numeric Score Log value for a factor to count. Overrides `backlog/config.yml`.
- `--min-runs N`: minimum distinct completed runs that must meet the threshold. Overrides `backlog/config.yml`.
- `--help` or `-h`: show usage.

If `--threshold` or `--min-runs` is omitted, the script reads `backlog/config.yml` keys `sprint_close.threshold_score` and `sprint_close.min_runs`; if those are absent, it uses `9` and `2`.

The report reads checked-off issues from the sprint Plan section, matches terminal relay manifests for those issues, loads the review Score Log from each PR body, and cross-checks the scored factor names against each run's persisted rubric. It prints candidate patterns that repeatedly scored at or above the threshold, including the factor name, number of runs, and scores observed.

Use the output as review input for sprint-close learning promotion. The script does not edit sprint files, manifests, PRs, or `_context.md`; it ends with a manual reminder to promote applicable patterns.

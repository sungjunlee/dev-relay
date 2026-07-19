# Legacy Score Reports

`scripts/sprint-close-report.js` is a compatibility command for completed runs
created before reviewer-only scoring. It reads historical executor Score Log
tables but never feeds current review, dispatch, assurance, or merge decisions.

Use it only when an operator must reproduce an older sprint-close analysis:

```bash
node skills/relay-merge/scripts/sprint-close-report.js \
  --repo . --sprint <historical-sprint.md>
```

Its output is advisory historical context. Promotion still requires current
evidence and human judgment. Do not add this command to the default relay or
merge flow, and do not restore executor score production.

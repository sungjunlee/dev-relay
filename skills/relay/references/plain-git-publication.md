# Plain Git publication

Publish an already closed Reviewed Result to a plain Git remote. This is not
review, recovery, Change Request creation, or Landing.

```bash
node "${RELAY_SKILL_ROOT:-skills}/relay/scripts/publish-reviewed-revision.js" \
  --run-dir "$RUN_DIR" \
  --remote "$REMOTE_URL" \
  --ref refs/heads/published \
  --expected-old "$EXPECTED_OLD_OID" \
  --json
```

The immutable input is the terminal `reviewed_result_ready` close plus its
bound passing review and verification. The push uses a compare-and-swap
`--force-with-lease=<ref>:<expected-old-oid>` update and confirms success with
`git ls-remote`. Retries are idempotent: an already-published OID converges to
`already_published`; concurrent destination movement fails closed without
`--force`. The receipt records remote URL identity, destination ref, expected
old OID, published OID, and the post-push observation. No run fact is appended.

Pre-refactor fixtures captured from commit `5e78def9da36ea18b08946345f1028057b452eeb`.

Capture harness:
- repo root: `/tmp/issue187-fixtures/repo`
- `RELAY_HOME=/tmp/issue187-fixtures/relay-home`
- `TMPDIR=/tmp/issue187-fixtures/tmp`
- `Date.now() = 2026-04-18T00:50:00.000Z`
- `crypto.randomBytes(4)` fixed to deterministic sequences per command

These files intentionally freeze current CLI stdout before the runtime refactor in #187.

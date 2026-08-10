# Anonymous Relay Run Inventory for #1209

Measured at `2026-08-10T12:13:55Z`:

```json
{
  "selector_class": "default os.homedir()/.relay/runs",
  "regular_run_json": {
    "total": 17,
    "by_schema_version": {
      "3": 15,
      "missing": 2
    }
  },
  "nonregular_run_json": 2,
  "malformed_run_json": 0,
  "events_only_legacy_directories": 1171,
  "symlinked_path_components": 7,
  "invalid_historical": {"versionless_regular_run_json": 2},
  "terminal": {"merged": 3, "closed": 6, "conflict": 0},
  "schema_v3_nonterminal": {"total": 6, "attempt_active": 0},
  "malformed_event_lines": 0
}
```

`regular_run_json.total` counts regular `run.json` files; only parseable
records appear in `by_schema_version`. Versionless regular records are invalid
historical inputs. `events_only_legacy_directories` counts directories that
have a regular `events.jsonl` but no `run.json`; that category is separate and
does not imply that every historical directory has a supported Relay reader.

The terminal counts are for schema-v3 records with a valid `merge_recorded` or
`run_closed` fact. A schema-v3 record is nonterminal whenever it has no valid
merge/close terminal fact; `attempt_active` is only a sub-count of those
nonterminal records, not the definition of nonterminal. The earlier five active
schema-v3 runs retain the drain-in-place decision recorded in Running Context;
this broader remeasurement currently reports six nonterminal records and no
currently unmatched attempt. Do not migrate or mutate them. Future schema work
is blocked until the measured nonterminal records become terminal or an
operator makes an explicit close decision.

## Bounded aggregate reproduction

The command below selects `RELAY_RUNS_BASE`, then `RELAY_HOME/runs`, then
`os.homedir()/.relay/runs`, and reports only that selector class—not its
absolute path. It traverses every directory under the selected store through
an explicit depth limit, an entry cap, and a run-directory cap. Every path
component is checked with `lstat`; symlinked path components fail closed by
stopping traversal at that component and reporting only a bounded aggregate
count. Symlinked `run.json`/`events.jsonl` leaves are counted as non-regular and
never followed. Regular reads use `O_NOFOLLOW`,
inode/size checks, and a 16 MiB file cap. Exceeding any cap returns
`inventory_validation_failed` rather than a truncated authoritative inventory.
The output contains no paths, file contents, prompts, credentials, branches,
issue content, or repository content.

```bash
node <<'NODE'
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_CAP = 16 * 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 100_000;
const MAX_RUN_DIRECTORIES = 10_000;
const RUN_FILE = 'run.json';
const EVENTS_FILE = 'events.jsonl';
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const selectorClass = process.env.RELAY_RUNS_BASE
  ? 'RELAY_RUNS_BASE'
  : process.env.RELAY_HOME
    ? 'RELAY_HOME/runs'
    : 'default os.homedir()/.relay/runs';
const base = process.env.RELAY_RUNS_BASE
  || (process.env.RELAY_HOME ? path.join(process.env.RELAY_HOME, 'runs') : null)
  || path.join(os.homedir(), '.relay', 'runs');
const out = {
  selector_class: selectorClass,
  regular_run_json: { total: 0, by_schema_version: {} },
  nonregular_run_json: 0,
  malformed_run_json: 0,
  events_only_legacy_directories: 0,
  symlinked_path_components: 0,
  invalid_historical: { versionless_regular_run_json: 0 },
  terminal: { merged: 0, closed: 0, conflict: 0 },
  schema_v3_nonterminal: { total: 0, attempt_active: 0 },
  malformed_event_lines: 0,
};
let entriesSeen = 0;
let runDirectoriesSeen = 0;

function fail(message) {
  throw new Error(message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function integer(value, minimum = Number.MIN_SAFE_INTEGER) {
  return Number.isInteger(value) && value >= minimum;
}

function sha(value, pattern) {
  return typeof value === 'string' && pattern.test(value);
}

function lstatPath(target, { allowFinalSymlink = false } = {}) {
  if (!path.isAbsolute(target)) fail('absolute path required');
  const root = path.parse(target).root;
  const components = target.slice(root.length).split(path.sep).filter(Boolean);
  let cursor = root;
  if (!components.length) return fs.lstatSync(root);
  for (let index = 0; index < components.length; index += 1) {
    cursor = path.join(cursor, components[index]);
    const stat = fs.lstatSync(cursor);
    const final = index === components.length - 1;
    if (stat.isSymbolicLink() && !(allowFinalSymlink && final)) {
      fail('symlink path component refused');
    }
    if (!final && !stat.isDirectory()) fail('path component is not a directory');
    if (final) return stat;
  }
  fail('path validation failed');
}

function boundedFile(target) {
  let stat;
  try {
    stat = lstatPath(target, { allowFinalSymlink: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'nonregular' };
  if (stat.size > FILE_CAP) fail('file cap exceeded');
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(target, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > FILE_CAP) fail('file cap exceeded');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (!after.isFile() || after.size > FILE_CAP || bytes.length > FILE_CAP
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || bytes.length !== after.size) {
      fail('file changed while being read');
    }
    return { kind: 'regular', bytes };
  } finally {
    fs.closeSync(fd);
  }
}

function validTerminalFact(event, runId) {
  if (!plainObject(event) || event.run_id !== runId || !nonEmpty(event.event_id)
    || !nonEmpty(event.actor) || !nonEmpty(event.type) || !plainObject(event.payload)) return false;
  const payload = event.payload;
  if (event.type === 'merge_recorded') {
    return integer(payload.pr_number, 1)
      && sha(payload.reviewed_source_sha, SHA1)
      && sha(payload.pr_head_sha, SHA1)
      && sha(payload.result_target_sha, SHA1)
      && ['squash', 'merge', 'rebase', 'external'].includes(payload.method)
      && nonEmpty(payload.operator)
      && (payload.override_reason === null || nonEmpty(payload.override_reason))
      && nonEmpty(payload.operation_id)
      && nonEmpty(payload.authorization_id)
      && nonEmpty(payload.observation_nonce)
      && sha(payload.done_criteria_sha256, SHA256);
  }
  if (event.type === 'run_closed') {
    return nonEmpty(payload.reason) && nonEmpty(payload.operator)
      && (payload.last_sha === null || sha(payload.last_sha, SHA1))
      && (payload.pr_number === null || integer(payload.pr_number, 1));
  }
  return false;
}

function readEvents(input) {
  if (input.kind !== 'regular') return [];
  const events = [];
  for (const line of input.bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      out.malformed_event_lines += 1;
    }
  }
  return events;
}

function eventSummary(events, runId) {
  const active = new Set();
  const terminal = [];
  for (const event of events) {
    if (validTerminalFact(event, runId)) terminal.push(event.type);
    if (!plainObject(event) || event.run_id !== runId || !nonEmpty(event.type)) continue;
    if ((event.type === 'attempt_started') && nonEmpty(event.attempt_id)) active.add(event.attempt_id);
    if ((event.type === 'attempt_finished' || event.type === 'attempt_interrupted')
      && nonEmpty(event.attempt_id)) active.delete(event.attempt_id);
  }
  return { terminal, activeAttempt: active.size > 0 };
}

function schemaVersion(run) {
  if (!Object.prototype.hasOwnProperty.call(run, 'version')) return 'missing';
  return Number.isInteger(run.version) ? String(run.version) : 'invalid';
}

function classifyDirectory(runDir, names) {
  const hasRun = names.includes(RUN_FILE);
  const hasEvents = names.includes(EVENTS_FILE);
  if (!hasRun && !hasEvents) return;
  runDirectoriesSeen += 1;
  if (runDirectoriesSeen > MAX_RUN_DIRECTORIES) fail('run-directory cap exceeded');

  const runInput = hasRun ? boundedFile(path.join(runDir, RUN_FILE)) : { kind: 'missing' };
  const eventsInput = hasEvents ? boundedFile(path.join(runDir, EVENTS_FILE)) : { kind: 'missing' };
  if ((hasRun && runInput.kind === 'missing') || (hasEvents && eventsInput.kind === 'missing')) {
    fail('store entry disappeared while being inventoried');
  }
  const events = readEvents(eventsInput);
  if (runInput.kind === 'nonregular') {
    out.nonregular_run_json += 1;
    return;
  }
  if (runInput.kind === 'missing') {
    if (eventsInput.kind === 'regular') {
      out.events_only_legacy_directories += 1;
    }
    return;
  }
  out.regular_run_json.total += 1;
  let run;
  try {
    run = JSON.parse(runInput.bytes.toString('utf8'));
  } catch {
    out.malformed_run_json += 1;
    return;
  }
  if (!plainObject(run)) {
    out.malformed_run_json += 1;
    return;
  }
  const version = schemaVersion(run);
  if (version === '3' && !nonEmpty(run.run_id)) {
    out.malformed_run_json += 1;
    return;
  }
  out.regular_run_json.by_schema_version[version]
    = (out.regular_run_json.by_schema_version[version] || 0) + 1;
  if (version === 'missing') out.invalid_historical.versionless_regular_run_json += 1;
  if (run.version !== 3) return;

  const summary = eventSummary(events, run.run_id);
  if (summary.terminal.length > 1) {
    out.terminal.conflict += 1;
    return;
  }
  if (summary.terminal[0] === 'merge_recorded') {
    out.terminal.merged += 1;
  } else if (summary.terminal[0] === 'run_closed') {
    out.terminal.closed += 1;
  } else {
    out.schema_v3_nonterminal.total += 1;
    if (summary.activeAttempt) out.schema_v3_nonterminal.attempt_active += 1;
  }
}

function walk(directory, depth) {
  const stat = lstatPath(directory);
  if (!stat.isDirectory()) fail('store entry is not a directory');
  const names = fs.readdirSync(directory).sort();
  entriesSeen += names.length;
  if (entriesSeen > MAX_ENTRIES) fail('entry cap exceeded');
  const children = [];
  for (const name of names) {
    const candidate = path.join(directory, name);
    const child = lstatPath(candidate, { allowFinalSymlink: true });
    if (child.isSymbolicLink()) {
      out.symlinked_path_components += 1;
      continue;
    }
    if (name === RUN_FILE || name === EVENTS_FILE) continue;
    if (child.isDirectory()) {
      if (depth >= MAX_DEPTH) fail('depth cap exceeded');
      children.push(candidate);
    }
  }
  classifyDirectory(directory, names);
  for (const child of children) walk(child, depth + 1);
}

try {
  if (!path.isAbsolute(base)) fail('selected store must be absolute');
  const root = lstatPath(base);
  if (!root.isDirectory()) fail('selected store must be a directory');
  walk(base, 0);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch {
  process.stdout.write(`${JSON.stringify({
    inventory_validation_failed: true,
    selector_class: selectorClass,
  })}\n`);
  process.exitCode = 1;
}
NODE
```

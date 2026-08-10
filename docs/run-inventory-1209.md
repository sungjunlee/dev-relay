# Anonymous Relay Run Inventory for #1209

Measured at `2026-08-10T13:56:23Z`:

```json
{
  "schema_versions": {
    "3": 15,
    "missing": 2
  },
  "schema_v3": {
    "terminal": 9,
    "nonterminal": 6
  }
}
```

The recorded aggregates count parseable `run.json` records by schema version.
Only schema-v3 records contribute to `schema_v3`: a record is terminal when it
has exactly one valid `merge_recorded` or `run_closed` fact, and nonterminal
when it has no terminal fact. An invalid or ambiguous terminal fact fails
closed. The six observed schema-v3 nonterminal records retain the
drain-in-place decision: do not migrate or mutate them; drain each in place
until it is terminal or an operator explicitly closes it. Future schema work is
blocked until all six are terminal or explicitly closed.

## Bounded aggregate reproduction

The command below selects `RELAY_RUNS_BASE`, then `RELAY_HOME/runs`, then
`os.homedir()/.relay/runs`, without emitting selector metadata or the absolute
path. It traverses every directory under the selected store through explicit
depth, entry, run-directory, and file-size caps. Every path component is
checked with `lstat`; symlinked child entries and non-regular `run.json` leaves
are excluded from the trusted input set and never followed. An `events.jsonl`
associated with a regular run must also be regular. Regular reads use
`O_NOFOLLOW` and stable inode/size checks. The command requires parseable
JSON/JSONL and valid, unambiguous terminal facts for every trusted input. Any
validation violation, including an exceeded cap, emits only
`{"inventory_validation_failed":true}` and exits 1. Success emits only the
schema-version and schema-v3 terminal/nonterminal aggregates; no output
contains paths, file contents, prompts, credentials, branches, issue content,
or repository content.

```bash
node <<'NODE'
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FILE_CAP = 16 * 1024 * 1024;
const MAX_DEPTH = 12;
const MAX_ENTRIES = 100_000;
const MAX_RUN_DIRECTORIES = 10_000;
const RUN_FILE = 'run.json';
const EVENTS_FILE = 'events.jsonl';
const SHA1 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const base = process.env.RELAY_RUNS_BASE
  || (process.env.RELAY_HOME ? path.join(process.env.RELAY_HOME, 'runs') : null)
  || path.join(os.homedir(), '.relay', 'runs');
const out = {
  schema_versions: {},
  schema_v3: { terminal: 0, nonterminal: 0 },
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
  if (input.kind === 'missing') return [];
  if (input.kind !== 'regular') fail('event file is not regular');
  const events = [];
  for (const line of input.bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      fail('event JSONL is not parseable');
    }
  }
  return events;
}

function hasTerminalFact(events, runId) {
  let terminalCount = 0;
  for (const event of events) {
    if (!plainObject(event)) continue;
    if (event.type !== 'merge_recorded' && event.type !== 'run_closed') continue;
    if (!validTerminalFact(event, runId)) fail('invalid terminal fact');
    terminalCount += 1;
  }
  if (terminalCount > 1) fail('ambiguous terminal facts');
  return terminalCount === 1;
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
  if (hasRun && runInput.kind === 'missing') {
    fail('store entry disappeared while being inventoried');
  }
  if (runInput.kind === 'nonregular') {
    return;
  }
  if (runInput.kind === 'missing') return;
  const eventsInput = hasEvents ? boundedFile(path.join(runDir, EVENTS_FILE)) : { kind: 'missing' };
  if (hasEvents && eventsInput.kind === 'missing') {
    fail('store entry disappeared while being inventoried');
  }
  const events = readEvents(eventsInput);
  let run;
  try {
    run = JSON.parse(runInput.bytes.toString('utf8'));
  } catch {
    fail('run JSON is not parseable');
  }
  if (!plainObject(run)) {
    fail('run JSON is not an object');
  }
  const version = schemaVersion(run);
  if (version === '3' && !nonEmpty(run.run_id)) {
    fail('schema-v3 run has no run ID');
  }
  out.schema_versions[version] = (out.schema_versions[version] || 0) + 1;
  if (run.version !== 3) return;

  if (hasTerminalFact(events, run.run_id)) {
    out.schema_v3.terminal += 1;
  } else {
    out.schema_v3.nonterminal += 1;
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
  process.stdout.write(`${JSON.stringify({ inventory_validation_failed: true })}\n`);
  process.exitCode = 1;
}
NODE
```

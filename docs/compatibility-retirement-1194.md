# Compatibility retirement evidence (#1194)

Measured 2026-08-09T21:08:16+09:00 against the installed scripts and local Relay
input store. Counts below are anonymous; no repository, branch, or run identifiers
were recorded.

## Reproduce

```bash
rg -n 'readManifestOwnership|resolveActiveSprint|findActiveSprint' \
  skills --glob '*.js'
rg -n 'resolveSprintOwner\(' skills --glob '*.js'
rg -n 'derived\?\.reviewed_sha|payload\?\.reviewed_sha' \
  skills/relay/scripts/run-preflight.js
node - <<'NODE'
const fs = require("fs"), os = require("os"), path = require("path");
const counts = {
  rootMissing: false, rootNotDirectory: false, inaccessibleDirectories: 0, skippedSymlinks: 0,
  runJson: { regular: 0, nonRegular: 0, oversized: 0, malformed: 0 },
  versions: { v3: 0, versionless: 0, other: 0 },
  v3Artifacts: {
    bothRegular: 0, rubricMissingOrNonRegular: 0,
    doneCriteriaMissingOrNonRegular: 0, oversized: 0, readErrors: 0,
    same: 0, different: 0,
  },
};
const MAX_BYTES = 16 * 1024 * 1024;
function regularFile(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() ? stat : null; }
  catch { return null; }
}
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { counts.inaccessibleDirectories += 1; return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(file); continue; }
    if (entry.isSymbolicLink() && entry.name !== "run.json") {
      counts.skippedSymlinks += 1; continue;
    }
    if (entry.name !== "run.json") continue;
    const runStat = regularFile(file);
    if (!runStat) { counts.runJson.nonRegular += 1; continue; }
    counts.runJson.regular += 1;
    if (runStat.size > MAX_BYTES) { counts.runJson.oversized += 1; continue; }
    let record;
    try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch { counts.runJson.malformed += 1; continue; }
    if (record.version === 3) counts.versions.v3 += 1;
    else if (record.version == null) { counts.versions.versionless += 1; continue; }
    else { counts.versions.other += 1; continue; }
    const runDir = path.dirname(file);
    const rubric = path.join(runDir, "rubric.yaml");
    const criteria = path.join(runDir, "done-criteria.md");
    const rubricStat = regularFile(rubric), criteriaStat = regularFile(criteria);
    if (!rubricStat) counts.v3Artifacts.rubricMissingOrNonRegular += 1;
    if (!criteriaStat) counts.v3Artifacts.doneCriteriaMissingOrNonRegular += 1;
    if (!rubricStat || !criteriaStat) continue;
    counts.v3Artifacts.bothRegular += 1;
    if (rubricStat.size > MAX_BYTES || criteriaStat.size > MAX_BYTES) {
      counts.v3Artifacts.oversized += 1; continue;
    }
    let same;
    try { same = fs.readFileSync(rubric).equals(fs.readFileSync(criteria)); }
    catch { counts.v3Artifacts.readErrors += 1; continue; }
    counts.v3Artifacts[same ? "same" : "different"] += 1;
  }
}
const configured = process.env.RELAY_RUNS_BASE
  || path.join(process.env.RELAY_HOME || path.join(os.homedir(), ".relay"), "runs");
if (!path.isAbsolute(configured)) throw new Error("configured Relay runs path must be absolute");
const root = path.resolve(configured);
let rootStat;
try { rootStat = fs.lstatSync(root); } catch { counts.rootMissing = true; }
if (rootStat?.isDirectory()) walk(root);
else if (rootStat) counts.rootNotDirectory = true;
console.log(counts);
NODE
```

## Caller and input evidence

| Surface | Current production callers | Decision |
| --- | ---: | --- |
| `sprint-owner.readManifestOwnership` plus `fleet_ownership`, `sprint_path`, `sprintPath`, and `track_slug` aliases | 0 | Delete. They were a future manifest/fleet promise, not a current CLI path. |
| `resolveSprintOwner({ owner })` injected-owner seam | 0 | Delete. The installed public surface is the CLI selectors; no current docs promise this internal injection contract. |
| `append-learnings.resolveActiveSprint` / `findActiveSprint` | 0 | Delete. They duplicated the production fallback and existed only for direct tests. |
| `sprint-owner.resolveSingleActiveFallback` | 1 (`resolveSprintOwner` no-selector path) | Keep while the no-owner CLI invocation is supported. Retire when the CLI requires `--sprint`, `--track`, or `--component`. |
| raw review-fact fallback in `run-preflight.snapshotReview` | 0 reachable states | Delete. `inspect` derives `reviewed_sha`; preflight consumes that canonical projection. |
| rubric-as-Done-Criteria fallback | current documented dispatch path | Keep. `relay-dispatch` documents omission of `--done-criteria-file`, and 1 of 10 local schema-v3 runs has byte-identical rubric/Done Criteria. Retire only after the CLI requires a separate Done Criteria file and persisted schema-v3 runs using the fallback have drained or been explicitly retired. |

At the measurement snapshot, the local store contained 12 regular run records: 10
schema-v3 and 2 without a version. All 10 schema-v3 records had both artifacts; 1
pair was byte-identical and 9 differed. Two non-regular `run.json` entries were
counted separately and not dereferenced.
The 2 versionless records are invalid historical inputs: `run-store` requires version
3. They do not justify a second reader or migration overlay. The store is mutable, so
the reproduction script may report larger current counts while preserving this measured-at snapshot.

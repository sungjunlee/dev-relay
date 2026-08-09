"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "test.yml");
const EXPECTED_RUNNERS = Object.freeze({
  "relay-ready": "ubuntu-latest",
  "relay-plan": "ubuntu-latest",
  "relay-dispatch": "macos-latest",
  "relay-review": "ubuntu-latest",
  "relay-merge": "macos-latest",
  relay: "ubuntu-latest",
  "relay-config": "ubuntu-latest",
  "relay-fleet": "ubuntu-latest",
  "skills-lint": "ubuntu-latest",
});
const EXPECTED_RUNNER_SCRIPT = [
  "files=()",
  "while IFS= read -r file; do",
  "  files+=(\"$file\")",
  "done < <(find \"tests/${{ matrix.suite }}/scripts\" -type f -name '*.test.js' -print | LC_ALL=C sort)",
  "count=${#files[@]}",
  "echo \"Matched $count test file(s)\"",
  "if [ \"$count\" -eq 0 ]; then",
  "  echo \"::error::No test files matched the suite globs; refusing vacuous CI pass\"",
  "  exit 1",
  "fi",
  "node --test --test-concurrency=1 \"${files[@]}\"",
].join("\n");
const EXPECTED_RUNNER_STEP = [
  "- name: Run test suites (${{ matrix.suite }})",
  "  run: |",
  ...EXPECTED_RUNNER_SCRIPT.split("\n").map((line) => `    ${line}`),
].join("\n");

function indent(line) { return line.length - line.trimStart().length; }

function walk(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? walk(absolute) : [absolute];
  });
}

function discoverTests(testsDir) {
  return walk(testsDir).filter((file) => file.endsWith(".test.js")).sort();
}

function discoverSuites(testsDir) {
  const tests = discoverTests(testsDir);
  const invalid = [];
  const suites = new Set();
  for (const file of tests) {
    const relative = path.relative(testsDir, file).split(path.sep);
    if (relative.length < 3 || relative[1] !== "scripts") invalid.push(relative.join("/"));
    else suites.add(relative[0]);
  }
  assert.deepEqual(invalid, [], `tests must live under tests/<suite>/scripts/**:\n${invalid.join("\n")}`);
  return [...suites].sort();
}

function suiteMatrices(workflow) {
  const lines = workflow.split(/\r\n|\n|\r/);
  const matrices = [];
  lines.forEach((line, matrixIndex) => {
    if (line.trim() !== "matrix:") return;
    const matrixIndent = indent(line);
    for (let index = matrixIndex + 1; index < lines.length; index += 1) {
      if (!lines[index].trim() || lines[index].trim().startsWith("#")) continue;
      if (indent(lines[index]) <= matrixIndent) break;
      if (lines[index].trim() !== "include:") continue;
      const includeIndent = indent(lines[index]);
      const entries = [];
      for (index += 1; index < lines.length; index += 1) {
        const text = lines[index].trim();
        if (!text || text.startsWith("#")) continue;
        if (indent(lines[index]) <= includeIndent) break;
        const match = /^-\s+suite:\s+([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(text);
        if (!match) continue;
        const entryIndent = indent(lines[index]);
        const runners = [];
        for (let field = index + 1; field < lines.length; field += 1) {
          const value = lines[field].trim();
          if (!value || value.startsWith("#")) continue;
          if (indent(lines[field]) <= entryIndent) break;
          const runner = /^runner:\s+([a-z0-9-]+)$/.exec(value);
          if (runner) runners.push(runner[1]);
        }
        assert.equal(runners.length, 1, `${match[1]} must declare exactly one runner`);
        entries.push({ suite: match[1], runner: runners[0] });
      }
      matrices.push(entries);
      break;
    }
  });
  return matrices;
}

function runnerStep(workflow) {
  const lines = workflow.split(/\r\n|\n|\r/);
  const steps = lines.map((line, index) => ({ line, index }))
    .filter(({ line }) => /^- name: Run test suites/.test(line.trim()));
  assert.equal(steps.length, 1, "workflow must contain exactly one Relay suite runner");
  const stepIndent = indent(steps[0].line);
  const body = [];
  for (let index = steps[0].index + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && indent(lines[index]) <= stepIndent) break;
    if (lines[index].trim() && !lines[index].trimStart().startsWith("#")) {
      body.push(lines[index].slice(Math.min(lines[index].length, stepIndent)));
    }
  }
  return [steps[0].line.slice(stepIndent), ...body].join("\n");
}

function assertGuardedRunner(workflow) {
  assert.equal(runnerStep(workflow), EXPECTED_RUNNER_STEP,
    "Relay suite step must use the exact name, run key, and ordered fail-closed shell program");
}

function assertJobEnvelope(workflow) {
  const lines = workflow.split(/\r\n|\n|\r/);
  const jobs = lines.map((line, index) => ({ line, index })).filter(({ line }) => line === "  test:");
  assert.equal(jobs.length, 1, "workflow must contain exactly one canonical jobs.test job");
  const fields = [];
  for (let index = jobs[0].index + 1; index < lines.length; index += 1) {
    if (lines[index].trim() && indent(lines[index]) <= 2) break;
    if (!lines[index].trim() || lines[index].trimStart().startsWith("#") || indent(lines[index]) !== 4) continue;
    fields.push(lines[index].trim());
  }
  assert.deepEqual(fields, [
    "name: test (${{ matrix.suite }})",
    "runs-on: ${{ matrix.runner }}",
    "strategy:",
    "steps:",
  ], "jobs.test must keep the exact current name, runner binding, and job-level policy envelope");
}

function assertCiContract({ testsDir, workflow }) {
  assertJobEnvelope(workflow);
  const matrices = suiteMatrices(workflow);
  assert.equal(matrices.length, 1, "workflow must define exactly one suite matrix");
  const entries = matrices[0];
  const matrixSuites = entries.map((entry) => entry.suite);
  const duplicates = matrixSuites.filter((suite, index) => matrixSuites.indexOf(suite) !== index);
  assert.deepEqual(duplicates, [], `matrix contains duplicate suites: ${duplicates.join(", ")}`);
  assert.deepEqual(matrixSuites.slice().sort(), discoverSuites(testsDir),
    "filesystem test suites and matrix suites must match exactly");
  assert.deepEqual(Object.fromEntries(entries.map(({ suite, runner }) => [suite, runner])), EXPECTED_RUNNERS,
    "each suite must use its exact supported runner");
  assertGuardedRunner(workflow);
}

function write(file, source = "// fixture\n") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ci-matrix-"));
  for (const suite of Object.keys(EXPECTED_RUNNERS)) write(path.join(root, suite, "scripts", "nested", "x.test.js"));
  const include = Object.entries(EXPECTED_RUNNERS)
    .map(([suite, runner]) => `          - suite: ${suite}\n            runner: ${runner}`).join("\n");
  const runner = EXPECTED_RUNNER_SCRIPT.split("\n").map((line) => `          ${line}`).join("\n");
  const workflow = `jobs:\n  test:\n    name: test (\${{ matrix.suite }})\n    runs-on: \${{ matrix.runner }}\n    strategy:\n      matrix:\n        include:\n${include}\n    steps:\n      - name: Run test suites (\${{ matrix.suite }})\n        run: |\n${runner}\n`;
  return { root, workflow };
}

test("Relay CI matrix exactly covers filesystem suites and guarded execution", () => {
  assertCiContract({ testsDir: path.join(REPO_ROOT, "tests"), workflow: fs.readFileSync(WORKFLOW_PATH, "utf8") });
});

test("CI contract rejects missing, extra, duplicate, and multiple matrix suites", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertCiContract({ testsDir: value.root, workflow: value.workflow }));
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: value.workflow.replace("          - suite: relay-ready\n            runner: ubuntu-latest\n", "") }), /match exactly/);
  write(path.join(value.root, "extra", "scripts", "x.test.js"));
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: value.workflow }), /match exactly/);
  fs.rmSync(path.join(value.root, "extra"), { recursive: true });
  const duplicate = value.workflow.replace("          - suite: relay-plan", "          - suite: relay-ready\n            runner: ubuntu-latest\n          - suite: relay-plan");
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: duplicate }), /duplicate suites/);
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: `${value.workflow}\n  other:\n    matrix:\n      include:\n` }), /exactly one suite matrix/);
});

test("CI contract rejects wrong runners, layout escapes, and weakened execution guards", (t) => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: value.workflow.replace("runner: macos-latest", "runner: ubuntu-latest") }), /exact supported runner/);
  write(path.join(value.root, "escaped.test.js"));
  assert.throws(() => assertCiContract({ testsDir: value.root, workflow: value.workflow }), /tests must live under/);
  fs.rmSync(path.join(value.root, "escaped.test.js"));
  for (const weakened of [
    value.workflow.replace("files=()", ""),
    value.workflow.replace(/\s+count=\$\{#files\[@\]\}[\s\S]*?\s+fi\n/, "\n"),
    value.workflow.replace("--test-concurrency=1", "--test-concurrency=2"),
    value.workflow.replace("\"${files[@]}\"", "tests/**/*.test.js"),
    value.workflow.replace("            exit 1", "            # exit 1"),
    value.workflow.replace("          node --test", "          # node --test"),
    `${value.workflow.replace("          node --test", "          echo disabled #")}
      - name: Decoy
        run: |
          node --test --test-concurrency=1 "\${files[@]}"`,
    value.workflow.replace("          files=()", "          exit 0\n          files=()"),
    value.workflow.replace("          node --test --test-concurrency=1 \"\${files[@]}\"",
      "          cat <<'DECOY'\n          node --test --test-concurrency=1 \"\${files[@]}\"\n          DECOY\n          echo disabled"),
    value.workflow.replace("        run: |", "        if: always()\n        run: |"),
    value.workflow.replace("        run: |", "        continue-on-error: true\n        run: |"),
    value.workflow.replace("    strategy:", "    if: always()\n    strategy:"),
    value.workflow.replace("    strategy:", "    continue-on-error: true\n    strategy:"),
  ]) assert.throws(() => assertCiContract({ testsDir: value.root, workflow: weakened }), /runner|step|exact|array|zero|serialize|guarded/i);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  compareShadow,
  foldRunFacts,
  projectLegacyRun,
} = require("../../../skills/relay-dispatch/scripts/run-fold");
const runtime = require("../../../skills/relay-dispatch/scripts/runtime-vnext");

const START = "a".repeat(40);
const HEAD = "b".repeat(40);
const TARGET = "c".repeat(40);
const HASH = "d".repeat(64);

function runRecord() {
  return {
    run_id: "r1",
    repo: { remote: "owner/repo" },
    git: { branch: "work", base_branch: "main" },
    contract: { done_criteria_sha256: HASH },
  };
}

function fact(type, index, payload, attemptId = null) {
  return {
    event_id: `e${index}`,
    run_id: "r1",
    ...(attemptId ? { attempt_id: attemptId } : {}),
    type,
    at: `2026-07-31T00:00:${String(index).padStart(2, "0")}Z`,
    actor: "owner",
    payload,
  };
}

function started(index = 1, attemptId = "a1") {
  return fact("attempt_started", index, {
    executor: "codex", model: null, start_sha: START, host_kind: "local",
    host_handle: "host-1", stdout_path: "/r/out", stderr_path: "/r/err",
    result_path: "/r/result", timeout_ms: 1000,
  }, attemptId);
}

function finished(index = 2, attemptId = "a1") {
  return fact("attempt_finished", index, {
    status: "completed", start_sha: START, final_sha: HEAD, tree_sha: HEAD,
    result_path: "/r/result", exit_code: 0, verification_status: "passed",
  }, attemptId);
}

function pr(index = 3) {
  return fact("pull_request_recorded", index, {
    pr_number: 42, repo: "owner/repo", head_ref: "work", base_ref: "main",
    head_sha: HEAD, created_by_relay: true,
  });
}

function review(verdict, index = 4, reviewedSha = HEAD, hash = HASH) {
  return fact("review_recorded", index, {
    round: 1, verdict, reviewed_sha: reviewedSha, done_criteria_sha256: hash,
    reviewer: "claude", review_artifact: "/r/review.json", override: null,
  });
}

function livePrFacts(prNumber = 42, overrides = {}) {
  return {
    available: true,
    pr_number: prNumber,
    repo: "owner/repo",
    pr_head_sha: HEAD,
    head_ref: "work",
    base_ref: "main",
    pr_state: "OPEN",
    ...overrides,
  };
}

test("fold implements active, publication, review, stale, changes, and ready precedence", () => {
  assert.deepEqual(
    foldRunFacts({ runRecord: runRecord(), facts: [started()], hostFacts: { live: true } }).action,
    "wait",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started()],
      hostFacts: { live: false },
      githubFacts: { available: true },
    }).reason,
    "attempt_liveness_unknown",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started(), finished()],
      gitFacts: { head_sha: HEAD, reviewable_work: true },
      githubFacts: { available: true, pr_lookup_complete: true },
    }).reason,
    "publication_incomplete",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [started(), finished(), pr()],
      githubFacts: livePrFacts(),
    }).reason,
    "review_missing",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), review("pass", 4, START)],
      githubFacts: livePrFacts(),
    }).reason,
    "review_stale",
  );
  assert.equal(
    foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), review("changes_requested")],
      githubFacts: livePrFacts(),
    }).action,
    "redispatch",
  );
  const ready = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: livePrFacts(),
  });
  assert.equal(ready.action, "merge");
  assert.equal(ready.reason, "ready_to_merge");
});

test("exact criteria binding, external revalidation, and identity conflicts fail closed", () => {
  const staleCriteria = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass", 4, HEAD, "e".repeat(64))],
    githubFacts: livePrFacts(),
  });
  assert.equal(staleCriteria.action, "review");
  assert.equal(staleCriteria.reason, "review_stale");

  const unavailable = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: { available: false, pr_head_sha: HEAD },
  });
  assert.equal(unavailable.action, "none");
  assert.equal(unavailable.reason, "github_unavailable");

  const conflict = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr()],
    githubFacts: livePrFacts(42, { repo: "other/repo" }),
  });
  assert.equal(conflict.action, "none");
  assert.equal(conflict.reason, "fact_conflict");

  for (const missing of ["pr_number", "repo", "pr_head_sha", "head_ref", "base_ref", "pr_state"]) {
    const incomplete = livePrFacts();
    delete incomplete[missing];
    const result = foldRunFacts({
      runRecord: runRecord(),
      facts: [pr(), review("pass")],
      githubFacts: incomplete,
    });
    assert.equal(result.action, "none", missing);
    assert.equal(result.reason, "github_unavailable", missing);
  }
  const closedPr = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: livePrFacts(42, { pr_state: "CLOSED" }),
  });
  assert.equal(closedPr.action, "none");
  assert.equal(closedPr.reason, "fact_conflict");

  const branchConflict = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr()],
    githubFacts: livePrFacts(42, { head_ref: "other-work" }),
  });
  assert.equal(branchConflict.reason, "fact_conflict");

  const staleRequested = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("changes_requested", 4, HEAD, "e".repeat(64))],
    githubFacts: livePrFacts(),
  });
  assert.equal(staleRequested.action, "review");
  assert.equal(staleRequested.reason, "review_stale");

  const incompletePublicationLookup = foldRunFacts({
    runRecord: runRecord(),
    facts: [started(), finished()],
    gitFacts: { head_sha: HEAD, reviewable_work: true },
    githubFacts: { available: true },
  });
  assert.equal(incompletePublicationLookup.action, "none");
  assert.equal(incompletePublicationLookup.reason, "github_unavailable");
});

test("terminal facts are irreversible and conflicting terminal history fails closed", () => {
  const closed = fact("run_closed", 2, {
    reason: "operator", operator: "owner", last_sha: HEAD, pr_number: null,
  });
  const folded = foldRunFacts({
    runRecord: runRecord(),
    facts: [started(), closed, started(3, "a2")],
  });
  assert.equal(folded.phase, "terminal");
  assert.equal(folded.action, "none");
  assert.equal(folded.reason, "closed");
  assert.equal(folded.activeAttempt, null);
  assert.ok(folded.diagnostics.some((entry) => entry.code === "active_fact_after_terminal"));

  const merged = fact("merge_recorded", 4, {
    pr_number: 42, reviewed_source_sha: HEAD, pr_head_sha: HEAD,
    result_target_sha: TARGET, method: "squash", operator: "owner",
    override_reason: null, operation_id: "merge-op-1",
    authorization_id: "merge-auth-1", observation_nonce: "merge-observation-1",
    done_criteria_sha256: HASH,
  });
  const conflict = foldRunFacts({ runRecord: runRecord(), facts: [closed, merged] });
  assert.equal(conflict.reason, "fact_conflict");
  assert.equal(conflict.action, "none");

  const repeatedClose = {
    ...closed,
    event_id: "e5",
    at: "2026-07-31T00:00:05Z",
  };
  assert.equal(
    foldRunFacts({ runRecord: runRecord(), facts: [closed, repeatedClose] }).reason,
    "fact_conflict",
  );
  const repeatedMerge = {
    ...merged,
    event_id: "e6",
    at: "2026-07-31T00:00:06Z",
  };
  assert.equal(
    foldRunFacts({ runRecord: runRecord(), facts: [merged, repeatedMerge] }).reason,
    "fact_conflict",
  );
  const contradictoryMerge = {
    ...merged,
    payload: { ...merged.payload, pr_head_sha: START },
  };
  const contradictoryTerminal = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), contradictoryMerge],
    githubFacts: livePrFacts(42, { pr_state: "MERGED", merge_sha: TARGET }),
  });
  assert.equal(contradictoryTerminal.reason, "fact_conflict");
  assert.equal(contradictoryTerminal.terminal, true);
});

test("fold replay is deterministic and append position, not timestamps, controls precedence", () => {
  const facts = [pr(), review("changes_requested")];
  const input = {
    runRecord: runRecord(),
    facts,
    githubFacts: livePrFacts(),
  };
  assert.deepEqual(foldRunFacts(input), foldRunFacts(JSON.parse(JSON.stringify(input))));
  const passWithOlderTimestamp = {
    ...review("pass", 5),
    at: "2020-01-01T00:00:00Z",
  };
  assert.equal(
    foldRunFacts({ ...input, facts: [...facts, passWithOlderTimestamp] }).action,
    "merge",
  );
});

test("a live PR head advance is review staleness, not an identity conflict", () => {
  const advanced = "f".repeat(40);
  const result = foldRunFacts({
    runRecord: runRecord(),
    facts: [pr(), review("pass")],
    githubFacts: livePrFacts(42, { pr_head_sha: advanced }),
  });
  assert.equal(result.reason, "review_stale");
  assert.equal(result.action, "review");
});

test("property replay preserves ordering, rejects duplicate delivery, and never leaves terminal", () => {
  const closed = fact("run_closed", 8, {
    reason: "operator",
    operator: "owner",
    last_sha: HEAD,
    pr_number: 42,
  });
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const firstVerdict = iteration % 2 === 0 ? "pass" : "changes_requested";
    const secondVerdict = firstVerdict === "pass" ? "changes_requested" : "pass";
    const sequence = [
      pr(),
      { ...review(firstVerdict, 5), event_id: `property-first-${iteration}` },
      { ...review(secondVerdict, 6), event_id: `property-second-${iteration}` },
    ];
    const input = {
      runRecord: runRecord(),
      facts: sequence,
      githubFacts: livePrFacts(),
    };
    const folded = foldRunFacts(input);
    assert.deepEqual(folded, foldRunFacts(JSON.parse(JSON.stringify(input))));
    assert.equal(
      folded.action,
      secondVerdict === "pass" ? "merge" : "redispatch",
      `ordering iteration ${iteration}`,
    );
    const duplicate = foldRunFacts({
      ...input,
      facts: [...sequence, { ...sequence[0] }],
    });
    assert.equal(duplicate.reason, "fact_conflict");
    const terminal = foldRunFacts({
      ...input,
      facts: [...sequence, { ...closed, event_id: `closed-${iteration}` }, started(7, `late-${iteration}`)],
    });
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.action, "none");
  }
});

test("legacy projection and shadow comparison write telemetry only", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-shadow-"));
  const telemetryPath = path.join(root, "shadow-comparisons.jsonl");
  const legacyEventsPath = path.join(root, "events.jsonl");
  fs.writeFileSync(legacyEventsPath, "legacy bytes\n");
  const before = fs.readFileSync(legacyEventsPath);
  const manifest = {
    run_id: "r1",
    state: "ready_to_merge",
    git: { working_branch: "work", base_branch: "main", pr_number: 42, head_sha: HEAD },
    paths: { repo_root: "/repo", worktree: "/wt" },
    anchor: { done_criteria_path: "/run/done.md", done_criteria_sha256: HASH },
    roles: { orchestrator: "codex", executor: "cursor", reviewer: "claude" },
    review: { rounds: 1, latest_verdict: "lgtm", last_reviewed_sha: HEAD, last_reviewer: "claude" },
    timestamps: { created_at: "2026-07-31T00:00:00Z" },
  };
  const projection = projectLegacyRun({
    manifest,
    observations: {
      remote: "owner/repo",
      gitFacts: { head_sha: HEAD },
      githubFacts: { pr_number: 42, pr_head_sha: HEAD },
      doneCriteriaSha256: HASH,
    },
  });
  const comparison = compareShadow({
    legacyDecision: { state: "ready_to_merge" },
    ...projection,
    githubFacts: livePrFacts(),
    telemetryPath,
    at: "2026-07-31T00:00:00Z",
  });
  assert.equal(comparison.agree, true);
  assert.equal(comparison.vnext.action, "merge");
  assert.deepEqual(fs.readFileSync(legacyEventsPath), before);
  assert.equal(fs.existsSync(path.join(root, "run.json")), false);
  assert.equal(fs.readFileSync(telemetryPath, "utf8").trim().length > 0, true);
});

test("first shadow telemetry creation fsyncs file and directory and surfaces boundary faults", () => {
  const manifest = {
    run_id: "r1",
    state: "draft",
    git: { working_branch: "work", base_branch: "main", head_sha: HEAD },
    paths: { repo_root: "/repo", worktree: "/wt" },
    anchor: { done_criteria_path: "/run/done.md", done_criteria_sha256: HASH },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    timestamps: { created_at: "2026-07-31T00:00:00Z" },
  };
  const projection = projectLegacyRun({
    manifest,
    observations: {
      remote: "owner/repo",
      gitFacts: { head_sha: HEAD },
      doneCriteriaSha256: HASH,
    },
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-shadow-durability-"));
  let fileSyncs = 0;
  let directorySyncs = 0;
  const fsSpy = {
    ...fs,
    fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) directorySyncs += 1;
      else fileSyncs += 1;
      return fs.fsyncSync(fd);
    },
  };
  const result = compareShadow({
    legacyDecision: { state: "draft" },
    ...projection,
    telemetryPath: path.join(root, "telemetry", "shadow.jsonl"),
    telemetryIo: { fsModule: fsSpy },
  });
  assert.equal(result.telemetry_error, undefined);
  assert.equal(fileSyncs, 1);
  assert.equal(directorySyncs, 1);
  for (const stage of ["open", "write", "fsync", "dir_fsync"]) {
    const failed = compareShadow({
      legacyDecision: { state: "draft" },
      ...projection,
      telemetryPath: path.join(root, `fault-${stage}`, "shadow.jsonl"),
      telemetryIo: {
        fault(current) {
          if (current === stage) throw new Error(`injected ${stage}`);
        },
      },
    });
    assert.match(failed.telemetry_error, new RegExp(`injected ${stage}`));
  }
});

test("shadow source reader derives manifest/events bytes and durably emits provenance telemetry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-production-shadow-"));
  const telemetryDirectory = path.join(root, "telemetry");
  const runId = "shadow-r1-20260731000000000";
  const manifestPath = path.join(root, `${runId}.md`);
  const eventsPath = path.join(root, runId, "events.jsonl");
  fs.mkdirSync(path.dirname(eventsPath));
  const manifest = {
    run_id: runId,
    state: "ready_to_merge",
    git: { working_branch: "work", base_branch: "main", pr_number: 42, head_sha: HEAD },
    paths: { repo_root: "/repo", worktree: "/wt" },
    anchor: { done_criteria_path: "/run/done.md", done_criteria_sha256: HASH },
    roles: { orchestrator: "codex", executor: "codex", reviewer: "claude" },
    review: {
      rounds: 1,
      latest_verdict: "lgtm",
      last_reviewed_sha: HEAD,
      last_reviewer: "claude",
    },
    timestamps: { created_at: "2026-07-31T00:00:00Z" },
  };
  const store = require("../../../skills/relay-dispatch/scripts/manifest/store");
  store.writeManifest(manifestPath, manifest);
  fs.writeFileSync(eventsPath, "");
  const telemetryPath = path.join(telemetryDirectory, `${runId}.jsonl`);
  runtime.evaluateLegacyShadow({
    manifestPath,
    eventsPath,
    observations: {
      remote: "owner/repo",
      doneCriteriaSha256: HASH,
      gitFacts: { head_sha: HEAD, branch: "work", base_branch: "main" },
      githubFacts: livePrFacts(),
      hostFacts: {},
    },
    legacyDecision: { state: "ready_to_merge" },
    telemetryPath,
  });
  const persisted = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
  assert.equal(persisted.provenance.kind, "production-source-bytes");
  assert.equal(
    persisted.provenance.manifest_sha256,
    crypto.createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
  );
  assert.throws(() => runtime.evaluateLegacyShadow({
    manifestPath,
    eventsPath,
    expectedManifest: { ...manifest, state: "closed" },
    observations: {},
    telemetryPath,
  }), /does not match source bytes/);
  assert.throws(() => runtime.evaluateLegacyShadow({
    manifestPath,
    eventsPath,
    expectedEvents: [{ event: "forged" }],
    observations: {},
    telemetryPath,
  }), /events do not match source bytes/);
  assert.throws(() => runtime.evaluateLegacyShadow({
    manifestPath,
    eventsPath,
    observations: {},
    legacyDecision: { state: "closed" },
    telemetryPath,
  }), /decision does not match manifest source state/);
});

test("shadow parity agrees for 30 representative comparable legacy runs", () => {
  const corpusPath = path.resolve(
    __dirname,
    "../fixtures/vnext-shadow-parity-corpus.json",
  );
  const variants = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  assert.equal(variants.length, 30);
  assert.equal(new Set(variants.map((entry) => entry.id)).size, 30);
  assert.equal(new Set(variants.map((entry) => entry.provenance.scenario)).size, 30);
  const comparisons = [];
  for (const [index, variant] of variants.entries()) {
    const sourceRef = variant.provenance.source;
    let sourcePath;
    if (sourceRef.startsWith("manifest/")) {
      sourcePath = path.resolve(__dirname, "../../../skills/relay-dispatch/scripts", sourceRef.split(":")[0]);
    } else if (sourceRef.startsWith("finalize-run") || sourceRef.startsWith("review-gate")) {
      sourcePath = path.resolve(__dirname, "../../../skills/relay-merge/scripts", sourceRef.split(":")[0]);
    } else if (sourceRef.startsWith("review-runner/")) {
      sourcePath = path.resolve(__dirname, "../../../skills/relay-review/scripts", sourceRef.split(":")[0]);
    } else if (sourceRef === "review-runner.js") {
      sourcePath = path.resolve(__dirname, "../../../skills/relay-review/scripts/review-runner.js");
    } else if (sourceRef.startsWith("relay-fleet")) {
      sourcePath = path.resolve(__dirname, "../../../skills/relay-fleet/scripts/relay-fleet.js");
    } else {
      sourcePath = path.resolve(
        __dirname,
        "../../../skills/relay-dispatch/scripts",
        sourceRef.split(":")[0],
      );
    }
    assert.equal(variant.provenance.kind, "legacy-golden", `sample ${index + 1} kind`);
    assert.equal(fs.existsSync(sourcePath), true, `sample ${index + 1} source ${sourceRef}`);
    assert.equal(typeof variant.provenance.scenario, "string", `sample ${index + 1} scenario`);
    assert.equal(
      crypto.createHash("sha256").update(variant.golden_snapshot.manifest_bytes).digest("hex"),
      variant.golden_snapshot.manifest_sha256,
      `sample ${index + 1} manifest bytes`,
    );
    assert.equal(
      crypto.createHash("sha256").update(variant.golden_snapshot.events_bytes).digest("hex"),
      variant.golden_snapshot.events_sha256,
      `sample ${index + 1} event bytes`,
    );
    const { parseFrontmatter } = require("../../../skills/relay-dispatch/scripts/manifest/store");
    const capturedManifest = parseFrontmatter(variant.golden_snapshot.manifest_bytes).data;
    assert.equal(capturedManifest.state, variant.state, `sample ${index + 1} captured state`);
    assert.match(variant.golden_snapshot.source_commit, /^[0-9a-f]{40}$/);
    const manifest = capturedManifest;
    const legacyEvents = variant.golden_snapshot.events_bytes
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const prRequired = Number.isInteger(manifest.git.pr_number);
    const active = variant.shape.startsWith("active-live");
    const interrupted = variant.shape.startsWith("interrupted");
    const reviewableWork = variant.shape.startsWith("publication")
      || variant.shape === "interrupted-work";
    const githubFacts = variant.pr
      ? livePrFacts(manifest.git.pr_number, {
        head_ref: manifest.git.working_branch,
        pr_state: variant.state === "merged" ? "MERGED" : "OPEN",
        merge_sha: variant.state === "merged" ? TARGET : undefined,
      })
      : {
        available: true,
        pr_lookup_complete: true,
      };
    if (prRequired) {
      Object.assign(githubFacts, livePrFacts(manifest.git.pr_number, {
        head_ref: manifest.git.working_branch,
        pr_state: variant.state === "merged" ? "MERGED" : "OPEN",
        merge_sha: variant.state === "merged" ? TARGET : undefined,
      }));
    }
    const projection = projectLegacyRun({
      manifest,
      events: legacyEvents,
      observations: {
        remote: "owner/repo",
        gitFacts: { head_sha: HEAD },
        githubFacts,
        doneCriteriaSha256: HASH,
        merge_sha: TARGET,
        mergeMethod: variant.shape === "merged-rebase" ? "rebase" : "squash",
      },
    });
    const comparison = compareShadow({
      legacyDecision: {
        state: variant.state,
        host_live: active ? true : (interrupted ? false : undefined),
        reviewable_work: reviewableWork,
      },
      ...projection,
      gitFacts: {
        head_sha: HEAD,
        reviewable_work: reviewableWork,
        tree_differs_from_start: variant.shape === "publication-tree",
        branch_commit_exists: variant.shape === "publication-commit",
        result_artifact_regular: variant.shape === "publication-result",
      },
      githubFacts,
      hostFacts: { live: active ? true : (interrupted ? false : undefined) },
      at: "2026-07-31T00:02:00Z",
      provenance: variant.provenance,
      expectedDiscrepancy: variant.expected_discrepancy,
    });
    assert.equal(comparison.vnext.action, variant.expected, `sample ${index + 1}`);
    assert.equal(comparison.comparable, true, `sample ${index + 1}`);
    assert.equal(comparison.agree, true, `sample ${index + 1}`);
    assert.deepEqual(comparison.provenance, variant.provenance, `sample ${index + 1}`);
    assert.equal(
      comparison.expected_discrepancy,
      variant.expected_discrepancy,
      `sample ${index + 1}`,
    );
    comparisons.push({
      fixture_id: variant.id,
      provenance: variant.provenance,
      expected_discrepancy: variant.expected_discrepancy,
      comparison,
    });
  }
  assert.equal(comparisons.length, 30);
});

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateReadyLightRubric,
} = require("../../../skills/relay-plan/scripts/rubric-validation");

function rubricWithFactors(factors) {
  return [
    "rubric:",
    "  prerequisites:",
    "    - command: \"node --test tests/relay-plan/scripts/ready-light-rubric-validation.test.js\"",
    "      target: \"exit 0\"",
    "  factors:",
    ...factors.flatMap((factor) => [
      `    - name: ${factor.name}`,
      `      tier: ${factor.tier || "contract"}`,
      `      type: ${factor.type || "automated"}`,
      ...(factor.command ? [`      command: "${factor.command}"`] : []),
      ...(factor.criteria ? [`      criteria: "${factor.criteria}"`] : []),
      `      target: "${factor.target || "exit 0"}"`,
    ]),
  ].join("\n");
}

test("allows a one-factor ready-light S mechanical rubric", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      {
        name: "Preflight proceeds without Q&A",
        command: "node --test tests/relay/scripts/run-preflight.test.js",
      },
    ]),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "allow");
  assert.equal(result.substantive_total, 1);
  assert.deepEqual(result.errors, []);
});

test("blocks a ready-light S rubric with no substantive factors", () => {
  const result = validateReadyLightRubric({
    rubricYaml: [
      "rubric:",
      "  factors:",
      "    - name: Repo suite remains green",
      "      tier: hygiene",
      "      type: automated",
      "      command: \"node --test tests/relay-plan/scripts/*.test.js\"",
      "      target: \"exit 0\"",
    ].join("\n"),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "block");
  assert.equal(result.substantive_total, 0);
  assert.ok(result.errors.some((error) => error.code === "ready_light_factor_count"));
});

test("blocks a three-factor ready-light S mechanical rubric without explicit risk rationale", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      {
        name: "Route decision is preserved",
        command: "node --test tests/relay/scripts/run-preflight.test.js",
      },
      {
        name: "New unsupported helper abstraction covers route shape",
        type: "evaluated",
        criteria: "Requires a new unsupported helper abstraction for route shape even though Done Criteria do not ask for it.",
        target: ">= 8/10",
      },
      {
        name: "Repo suite remains green",
        command: "node --test tests/relay-plan/scripts/*.test.js",
      },
    ]),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "block");
  assert.equal(result.substantive_total, 3);
  assert.ok(result.errors.some((error) => error.code === "ready_light_factor_count"));
  assert.ok(result.errors.some((error) => error.code === "repo_hygiene_in_factor"));
  assert.ok(result.warnings.some((warning) => warning.code === "over_engineering_risk"));
});

test("blocks repo-wide hygiene commands written as block scalars in ready-light factors", () => {
  const result = validateReadyLightRubric({
    rubricYaml: [
      "rubric:",
      "  factors:",
      "    - name: Repo suite remains green",
      "      tier: contract",
      "      type: automated",
      "      command: >",
      "        node --test tests/relay-plan/scripts/*.test.js",
      "      target: \"exit 0\"",
    ].join("\n"),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "block");
  assert.ok(result.errors.some((error) => error.code === "repo_hygiene_in_factor"));
});

test("blocks repo-wide hygiene block scalars when command starts the factor item", () => {
  const result = validateReadyLightRubric({
    rubricYaml: [
      "rubric:",
      "  factors:",
      "    - command: >",
      "        node --test tests/relay-plan/scripts/*.test.js",
      "      name: Repo suite remains green",
      "      tier: contract",
      "      type: automated",
      "      target: \"exit 0\"",
    ].join("\n"),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "block");
  assert.ok(result.errors.some((error) => error.code === "repo_hygiene_in_factor"));
});

test("blocks bare repo-wide test runners in ready-light factors", () => {
  const commands = [
    "node --test",
    "node --test --test-reporter=spec",
    "node --test tests/**/*.test.js --test-reporter=spec",
    "pytest",
    "pytest -q",
    "go test ./...",
    "go test ./... -race",
  ];

  for (const command of commands) {
    const result = validateReadyLightRubric({
      rubricYaml: rubricWithFactors([
        {
          name: "Repo suite remains green",
          command,
        },
      ]),
      taskProfile: { planning_profile: "ready_light", size: "S" },
    });

    assert.equal(result.action, "block", command);
    assert.ok(
      result.errors.some((error) => error.code === "repo_hygiene_in_factor"),
      command
    );
  }
});

test("allows path-scoped pytest commands in ready-light factors", () => {
  const commands = [
    "npm test tests/foo.test.js",
    "pnpm test tests/foo.test.js",
    "yarn test tests/foo.test.js",
    "pytest tests/foo_test.py",
    "python -m pytest tests/foo_test.py::test_case",
  ];

  for (const command of commands) {
    const result = validateReadyLightRubric({
      rubricYaml: rubricWithFactors([
        {
          name: "Task-specific pytest coverage passes",
          command,
        },
      ]),
      taskProfile: { planning_profile: "ready_light", size: "S" },
    });

    assert.equal(result.action, "allow", command);
    assert.deepEqual(result.errors, [], command);
  }
});

test("does not flag ordinary helper text as over-engineering", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      {
        name: "Helper output stays stable",
        type: "evaluated",
        criteria: "Inspect the changed helper output and confirm the existing behavior is preserved.",
        target: ">= 8/10",
      },
    ]),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "allow");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("warns on explicitly unsupported helper requirements", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      {
        name: "Unsupported helper requirement is visible",
        type: "evaluated",
        criteria: "Requires an unsupported helper abstraction beyond the Done Criteria.",
        target: ">= 8/10",
      },
    ]),
    taskProfile: { planning_profile: "ready_light", size: "S" },
  });

  assert.equal(result.action, "allow");
  assert.ok(result.warnings.some((warning) => warning.code === "over_engineering_risk"));
});

test("allows a three-factor ready-light rubric as a warning when explicit design rationale exists", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      { name: "Prompt chooses the compact route", command: "node --test tests/relay/scripts/run-preflight.test.js" },
      {
        name: "Operator-facing copy is reviewable",
        type: "evaluated",
        criteria: "Inspect the changed prompt copy and confirm the user-visible guidance remains concrete.",
        target: ">= 8/10",
      },
      {
        name: "Design rationale is recorded",
        type: "evaluated",
        criteria: "Inspect the quality card rationale for the design-bearing exception.",
        target: ">= 8/10",
      },
    ]),
    taskProfile: {
      planning_profile: "ready_light",
      size: "S",
      design_rationale: "User-visible prompt guidance can be structurally correct but misleading.",
    },
  });

  assert.equal(result.action, "allow");
  assert.equal(result.substantive_total, 3);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((warning) => warning.code === "ready_light_factor_count"));
});

test("allows a three-factor non-ready-light rubric without ready-light compact warnings", () => {
  const result = validateReadyLightRubric({
    rubricYaml: rubricWithFactors([
      { name: "Parser accepts new field", command: "node --test tests/parser.test.js" },
      { name: "CLI renders new field", command: "node --test tests/cli.test.js" },
      {
        name: "Error copy remains actionable",
        type: "evaluated",
        criteria: "Inspect CLI error paths for clear next actions.",
        target: ">= 8/10",
      },
    ]),
    taskProfile: { planning_profile: "standard", size: "M" },
  });

  assert.equal(result.action, "allow");
  assert.equal(result.substantive_total, 3);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

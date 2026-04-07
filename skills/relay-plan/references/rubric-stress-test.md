# Rubric Stress-Test for L/XL Tasks

For complex tasks (5+ AC items), stress-test the rubric before dispatch. A subagent with fresh context attempts to "game" the rubric — finding minimal implementations that technically pass but a senior engineer would reject.

## Task Size Classification

| Size | Criteria | Rubric Review |
|------|----------|---------------|
| S/M | 1-4 AC items | None (current flow) |
| L | 5-6 AC items | Stress-test (1 subagent) |
| XL | 7+ AC items or cross-domain | Stress-test + Calibration simulation (parallel) |

**Cross-domain**: task spans frontend + backend, infra + application, or multiple services.

## Process: Validate → Review → Generate

Insert this between "Validate the rubric" (step 3) and "Generate dispatch prompt" (step 4):

```
Step 3 (Validate) → Step 3.5 (Rubric Review) → Step 4 (Generate dispatch prompt)
```

## Stress-Test (L and XL)

Launch a subagent with **fresh context** (no planning conversation). Hand it the rubric YAML + original AC as a structured artifact.

### Prompt Template

```
You are reviewing a scoring rubric for quality before it goes to an executor.
You have NOT seen the planning conversation — only the rubric and the AC.

## Task AC
{paste original acceptance criteria}

## Rubric
{paste rubric YAML}

## Your Job

For each rubric factor, answer these four questions:

### 1. Gaming Vector
Describe the MINIMAL implementation that PASSES this factor's target
but a senior engineer would reject. Be concrete — name the shortcut,
not "could be gamed."

### 2. Coverage Gap
What does this factor fail to catch that the AC implies should be checked?
Look for AC items with no corresponding factor, or factor criteria that
miss an AC dimension.

### 3. Disappear Test
If this specific AC item disappeared from the task, would this factor
still be a worthwhile quality check? If yes → the factor may be generic
filler rather than task-specific.

### 4. Padding Test
For each factor: would this check PASS for any implementation of
any task in this tech stack? If yes, it's a hygiene check disguised
as a factor — move it to prerequisites.

The rubric should probe what's SPECIFIC and HARD about THIS task,
not what's universally true of competent code.

## Output Format

| Factor | Gaming Vector | Coverage Gap | Disappear Test | Padding Test |
|--------|---------------|--------------|----------------|--------------|
| {name} | {specific minimal implementation} | {what's missed} | {pass/fail + reason} | {move to prerequisites? why/why not} |

## Summary
- Factors that need tightening: {list}
- Missing factors for uncovered AC: {list}
- Generic factors to reconsider: {list}
```

## Calibration Simulation (XL only)

Run **parallel** with stress-test. A second subagent imagines three implementations and scores each against evaluated factors.

### Prompt Template

```
You are calibrating a scoring rubric by testing whether it discriminates
between good and bad implementations.

## Rubric (evaluated factors only)
{paste evaluated factors with scoring_guide}

## Your Job

Imagine 3 implementations of this task:

A) TERRIBLE — technically runs, a senior engineer would reject it.
   Describe in 2-3 sentences what makes it bad.

B) ADEQUATE — meets the bar, nothing special.
   Describe in 2-3 sentences what it does right.

C) EXCELLENT — a senior engineer would praise this.
   Describe in 2-3 sentences what makes it stand out.

Now score each implementation against every evaluated factor using
the scoring_guide anchors (low/mid/high → 1-3/4-6/7-10).

## Output Format

| Factor | Terrible (A) | Adequate (B) | Excellent (C) | Spread |
|--------|-------------|--------------|---------------|--------|
| {name} | {score} | {score} | {score} | {C - A} |

## Flags
- Any factor where Terrible scores > 3: RUBRIC TOO LENIENT
  → Tighten criteria or lower the "low" anchor
- Any factor where Excellent scores < 8: RUBRIC TOO STRICT
  → Relax criteria or raise the "high" anchor
- Any factor where Spread < 3: NO DISCRIMINATING POWER
  → Factor cannot distinguish quality levels, rewrite or remove
```

## Orchestrator Rubric-Patch Protocol

After receiving stress-test (and calibration) results:

1. **Triage**: For each flagged issue, decide: patch rubric, add factor, or accept risk
2. **Patch**: Apply changes to rubric YAML — tighten criteria, add missing factors, remove generic ones
3. **Max 1 round**: Do NOT re-run stress-test after patching. Research shows diminishing returns on 2+ rounds (SupervisorAgent: 29.7% token waste in iterative debate). One round catches 80%+ of issues.
4. **Proceed to dispatch**: Generate dispatch prompt with the patched rubric

### Patch Actions

| Finding | Action |
|---------|--------|
| Gaming vector found | Tighten criteria to close the loophole |
| Coverage gap | Add factor or expand existing criteria |
| Disappear test fails | Consider removing or merging with another factor |
| Calibration: too lenient | Lower the "low" anchor, tighten criteria |
| Calibration: too strict | Raise the "high" anchor, relax edge-case requirements |
| Calibration: no spread | Rewrite factor with sharper criteria, or convert to automated |

## When to Skip

- **S/M tasks** (1-4 AC): Rubric is simple enough that stress-testing adds overhead without proportional value
- **Re-dispatches with iteration history**: The rubric was already stress-tested on the first dispatch; re-dispatch focuses on addressing reviewer feedback, not rubric quality
- **All-automated rubrics**: No evaluated factors to calibrate — stress-test adds nothing
- **Time-critical hotfixes**: Skip to dispatch immediately; accept rubric risk

## Token Budget

| Size | Overhead | Mechanism |
|------|----------|-----------|
| L | ~2-3K tokens | 1 subagent (stress-test) |
| XL | ~5-6K tokens | 2 subagents parallel (stress-test + calibration) |

Compared to a failed dispatch + re-dispatch cycle (~50-100K tokens), the overhead is negligible for tasks where rubric quality is the primary risk.

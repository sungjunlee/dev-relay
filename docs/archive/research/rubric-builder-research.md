# Rubric-Builder Skill — Research & Analysis

> Research conducted 2026-03-30. Explores evolving relay-plan into a standalone rubric-builder skill.

## Background

relay-plan converts task acceptance criteria into scored rubrics for autonomous iteration. The idea: evolve it into a dedicated rubric-builder skill — a guided workflow for designing evaluation criteria, similar to how prompt-builder guides prompt creation.

## Why Now

**"2026 is the Year of AI Quality"** — industry KPIs shifting from speed to correctness, maintainability, and merge confidence.

Three converging signals:

1. **Anthropic** published evaluation patterns as a first-class concern: "Demystifying Evals for AI Agents" (Jan 2026) and "Harness Design for Long-Running Apps" (Mar 2026, GAN-inspired Planner-Generator-Evaluator triad)
2. **Boris Cherny** (Claude Code creator): "The most important thing is giving Claude a way to verify its work — it will 2-3x the quality." Verification feedback loops as the #1 quality multiplier.
3. **Karpathy's autoresearch** (Mar 2026, 21K+ stars): proved that a single metric with binary keep/discard can produce remarkable results across 700+ autonomous experiments. Community rapidly generalizing the pattern.

## Key Findings

### 1. Task-Specific Rubrics Dramatically Outperform Generic Ones

**"Rubric Is All You Need"** (arXiv 2503.23989) — task-specific rubrics vs. generic rubrics: Spearman correlation 0.510 → 0.763. Three evaluation modes:
- CRE (complete rubric at once): 0.912 Pearson correlation
- PRE (per-criterion pointwise): stricter, better for enforcement
- EME (ensemble majority voting): most reliable

relay-plan's 5 domain-specific rubrics (backend, frontend, design, docs, refactoring) are exactly the right approach.

### 2. Per-Dimension Isolated Judges

Anthropic's eval guide and academic research both recommend **separate LLM-as-judge calls per criterion**, not one holistic judgment. Improves accuracy and makes calibration tractable.

relay-plan already does this: each factor is evaluated independently with its own criteria and target.

### 3. The Autoresearch Trinity

The generalizable pattern behind autoresearch:

| Element | Autoresearch | relay-plan |
|---------|-------------|------------|
| Objective metric | val_bpb | automated check commands |
| Automated measurement | `grep val_bpb run.log` | command exit code / output |
| Single mutation point | train.py only | implementation code only |
| Immutable ground truth | prepare.py (read-only) | rubric itself (Codex can't modify) |

Community generalizations: autoresearch-anything ("if you can measure it, you can optimize it"), goal-md (agent constructs fitness function first), SICA (17-53% improvement on SWE-bench via self-editing loops).

### 4. Anti-Scaffolding Principle

Boris Cherny: "Don't try to box the model in... scaffolding can improve performance maybe 10-20% but often these gains just get wiped out with the next model."

Implication: rubric-builder should be a **lightweight guided workflow** (good questions in the right order), not a heavyweight framework.

### 5. Existing Landscape — The Gap

| Project | Approach | Gap |
|---------|----------|-----|
| evaluation-rubrics (lyndonkl/claude) | Generic rubric builder skill | Not code/agent-specific |
| skill-optimizer (tessl.io) | Judge-scored eval for skills | Skill-specific, not general |
| autoresearch-anything | Generalizes the loop | Assumes metric exists |
| goal-md | Agent constructs fitness function | Doesn't guide rubric quality |
| mager.co eval loop | Description as learnable parameter | Methodology, not a tool |

**The gap**: tools that run evaluation loops are plentiful. Tools that guide the **design** of the evaluation criteria — the rubric itself — don't exist. This mirrors the gap prompt-builder filled.

### 6. Anthropic's Evaluation Best Practices

From "Demystifying Evals for AI Agents":
- Three grader types: code-based (fast, reproducible), model-based (flexible, needs calibration), human (gold standard, expensive)
- "Vague rubrics produce inconsistent judgments"
- Grade **outcomes not paths** — agents find valid approaches designers didn't anticipate
- Always provide LLM judges an escape hatch ("Unknown")
- Start with 20-50 tasks drawn from real failures for calibration

From "Harness Design for Long-Running Apps":
- Self-evaluation is unreliable — agents confidently praise their own mediocre work
- Separate evaluator agent is essential
- Hard thresholds per criterion, not just overall averages

### 7. Meta-Patterns from Domain Rubrics

Analysis of the 5 existing relay-plan rubric references reveals consistent patterns:

- **Layered gates**: Design uses Value → Usability → Delight; Backend uses Failure Modes → Data Integrity → Resource Discipline → API Contract. Prevents premature optimization.
- **Automated before subjective**: Objective pass/fail gates first, then scored evaluation.
- **Role-specific language**: Each rubric speaks as a domain specialist would.
- **score_low_if anchoring**: Explicit description of what failure looks like prevents generous self-scoring.
- **Reader/user-centric success**: "Did the end user succeed?" beats "Did I follow best practices?"

## Current Strengths (What relay-plan Already Has)

- 5 domain-specific rubric references (backend, frontend, design, docs, refactoring)
- Layered evaluation gates
- automated + evaluated factor separation
- Baseline → delta measurement pattern
- Score Log for iteration tracking
- `score_low_if` anchoring
- Autoloop-style iteration protocol (max 5 iterations, stuck detection)

## Evolution Path

### Phase 1: Strengthen Within relay-plan

1. **Guided rubric design workflow** — step-by-step questions to build each rubric
2. **Meta-evaluation of generated rubrics** — validate rubric quality before dispatch
3. **Rubric calibration** — consistency testing across multiple scoring runs

### Phase 2: Standalone rubric-builder Skill (Backlog)

4. **Custom domain support** — beyond the 5 built-in domains
5. **Rubric self-improvement** — autoloop pattern applied to rubric criteria themselves
6. **Export formats** — CI/CD, PR templates, eval harnesses (beyond relay-dispatch YAML)
7. **Rubric library** — save, reuse, and share validated rubrics

## Sources

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — Anthropic, Jan 2026
- [Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps) — Anthropic, Mar 2026
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — Anthropic, Nov 2025
- [Building Claude Code with Boris Cherny](https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny) — Pragmatic Engineer
- [Head of Claude Code: What happens after coding is solved](https://www.lennysnewsletter.com/p/head-of-claude-code-what-happens) — Lenny's Podcast, Feb 2026
- [8 Insights from Anthropic's Claude Code Boris Cherny](https://waydev.co/8-game-changing-insights-from-anthropic-claudecode-boris-cherny/)
- [Rubric Is All You Need](https://arxiv.org/html/2503.23989v1) — arXiv, Mar 2025
- [karpathy/autoresearch](https://github.com/karpathy/autoresearch) — GitHub
- [awesome-autoresearch](https://github.com/alvinunreal/awesome-autoresearch) — Community ecosystem
- [I Turned Karpathy's Autoresearch Into a Universal Skill](https://medium.com/@k.balu124/i-turned-andrej-karpathys-autoresearch-into-a-universal-skill-1cb3d44fc669)
- [Claude Code: How to Write, Eval, and Iterate on a Skill](https://www.mager.co/blog/2026-03-08-claude-code-eval-loop/)
- [2025 was the year of AI speed. 2026 will be the year of AI quality.](https://www.coderabbit.ai/blog/2025-was-the-year-of-ai-speed-2026-will-be-the-year-of-ai-quality)

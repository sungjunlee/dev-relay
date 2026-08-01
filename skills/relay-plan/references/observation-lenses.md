# Observation Lenses

Use these as non-binding questions after the planner identifies the artifact, intended
user, usage context, and available observation surfaces. Lenses expand inquiry; they
do not create requirements or Earned Rubric factors.

Select, combine, replace, or omit questions according to task evidence. A planner may
record `lenses: []` when no domain lens would change an implementation or review
decision. The presence of a lens never earns a scored factor.

## Design and Product

Observe rendered output through the relevant user flows and viewports, not code
inspection alone.

- Where does the user look first, and is the next safe action discoverable?
- What changes across loading, empty, failure, recovery, and success states?
- Does hierarchy, interaction feedback, accessibility, and product character survive
  the actual viewport and input conditions?

## Documentation

- Can the intended reader complete and verify the task without unwritten context?
- Where might ordering, terminology, or missing failure cues interrupt the reader?
- Which examples or links can be executed, and which reader outcomes require a
  walkthrough rather than a command?

## Operations and Security

- What state remains after partial failure, interruption, retry, or rollback?
- Where do data, credentials, authority, logs, and artifacts cross trust boundaries?
- Would an operator understand blast radius, safe next action, and audit provenance
  under pressure?

## No Domain Lens

For a mechanical change with no remaining quality gradient, use targeted diff or
command evidence, record why no expert lens changes the decision, and leave
`earned_rubric.factors: []`.

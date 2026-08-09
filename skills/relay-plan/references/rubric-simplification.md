# Rubric Simplification

Prefer the smallest set of independent Done Criteria that proves the requested
outcome. Remove criteria that merely restate another criterion, prescribe an
internal implementation detail, or require a retired lifecycle surface.

Good criteria identify:

- the externally visible behavior or safety property;
- the precise scope boundary when it matters;
- a deterministic verification command or inspection proof; and
- the trusted source when the change crosses a security boundary.

Avoid points, review-round quotas, mutable lifecycle vocabulary, execution
sidecars, executor registration, route catalogs, and legacy recovery command
names. The current runtime has one immutable run record, append-only facts, and
one derived action; plan against that model.

When a task needs broad validation, split it into orthogonal criteria rather
than duplicating the same full-suite command. State performance and flake
observations as bounded measurements, never as universal reliability claims.

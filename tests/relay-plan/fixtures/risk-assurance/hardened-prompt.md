## Task Profile

```yaml
task_profile:
  size: L
  change_type: infra
  authority: external-write
  reversibility: difficult
  blast_radius: multi-system
  trust_boundaries:
    - deployment
    - persistent-data
  execution_mode: fresh-context
  guidance_packs:
    - trust-boundary
```

## Task

Change a deployment path that writes persistent data across systems.

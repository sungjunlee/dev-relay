# ADR-0007: Routes Are the Single Model-Routing Concept

Status: Accepted (issue #781, Phase A1)

## Context

Relay previously split model-routing intent across global `policy.json`, project `routes.json`, and `executors.json`. That made the common question, "which agent and model should run this phase?", depend on multiple files with different schemas and precedence rules.

The fail-closed no-config default also blocked explicit unmanaged executor requests before the requested CLI could run. That behavior was useful as an accident guard for configured strict environments, but it made personal setups pay a configuration cost before trying a route.

## Decision

Introduce unified `routes.json` loading as the engine source of truth:

1. Global `~/.relay/routes.json` uses schema version 2.
2. Project `~/.relay/projects/<slug>/routes.json` may use the existing version 1 project-default schema or the new version 2 schema.
3. When global `routes.json` exists, legacy `policy.json`, repo/project policy files, and `executors.json` are ignored for route policy/default-model decisions.
4. The loader maps routes config into the existing in-memory policy shape:
   - `routes` becomes `allowed_model_routes`
   - `strict` becomes `deny_unknown_model_routes`
   - `denied_routes` becomes `denied_model_routes`
   - `defaults` remains `defaults`
5. `evaluateRelayRoute()` remains unchanged. Open mode uses the existing `unknown_allowed` reason.
6. With neither routes config nor legacy policy config, Relay now defaults to open mode: managed model-less CLIs remain allowed, and explicit unmanaged executor plus provider/model routes proceed with an `UNREGISTERED_ROUTE_USED` event.

Strict mode remains available through routes config and preserves fail-closed unknown-route behavior for repositories or operators that want an accident guard.

## Consequences

- Routes become the only new user-facing concept for registration: registering a route means allowing it.
- No derived `policy.json` is written, avoiding drift between generated and source files.
- Legacy policy users keep existing behavior until a global routes config is introduced.
- The no-config posture flip is intentional and observable: unregistered open-mode usage is recorded in the run journal for later gap reporting.
- Future relay-config work can migrate `policy.json` and `executors.json` into routes config without changing the policy gate function.

## Evidence

- Design: [route-config-simplification-design.md](../route-config-simplification-design.md)
- Implementation: `skills/relay-dispatch/scripts/relay-routing.js`, `skills/relay-dispatch/scripts/relay-policy.js`

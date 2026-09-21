# Forge change-request adapters (#1210)

`scripts/forge-adapters.js` holds the native forge seam: the smallest provider
surface demonstrated by both the retained GitHub route and the native GitLab
change-request adapter. The seam observes the forge-owned Change Request only.
Publication remains canonical-recovery-owned, review remains relay-review-owned,
and authorization and Landing remain explicit `relay-merge` steps; no adapter
adds a lifecycle writer, and no GitLab-specific state enters core run lifecycle
records. The core Git `ReviewSubject` is unchanged: Git identity stays the
content authority and a forge supplies transport plus change-request identity.

The production source gate is unchanged: GitLab remotes still classify as
unsupported delivery. This module is the extracted observation seam, not a
second Relay route.

## Documented consumer

The concrete consumer the seam is extracted from is the retained GitHub Change
Request observer in `recover.js` (`observeGithub`, `selectGithubPr`,
`exactPublishedPr`). Review and Landing already bind through that observer's
exact live `pr_head_sha`. The GitLab adapter is the second native
implementation of the same operator workflow.

Shared workflow (publication, change request, review, authorization, and
landing stay distinct):

1. Canonical recovery publishes the exact Git revision to a remote ref.
2. The adapter observes the forge-owned PR/MR for
   `{ project, source branch, base branch }` and returns provider-specific
   identity plus the exact live head SHA.
3. Review binds only when `exactPublishedChangeRequest` is true for that head.
4. Landing uses the same exact-head decision; authorization remains explicit
   `relay-merge`.

### GitHub consumer (extraction source)

| Trigger | Evidence |
| --- | --- |
| Repository / workflow | Identity-matching `github.com` origin (`owner/repo`). Operator path is recover → review → explicit merge. |
| Credentials | Owned by recover (`GH_TOKEN` / `GITHUB_TOKEN` or `gh auth login`). The seam issues the same `gh pr list` observation (`RELAY_GH_BIN`). |
| Open / update | Push to the head ref. |
| Approve / merge | GitHub repository permissions plus the explicit `relay-merge` actor (`git user.name`; recover does not call GitHub REST `/user`). |
| Fork vs same-project | `headRepository.nameWithOwner` must equal the canonical repo. Cross-repository PRs never identity-match. |
| Crash / retry | `gh` failure leaves observation `available: false`. Recover records retryable `github_unavailable` and keeps the string `error`. The seam types the same failure as `GITHUB_OBSERVATION_FAILED` (`retryable: true`) without rewriting recover. |

Equivalent GitHub facts stay byte/decision compatible: the seam reuses
`selectGithubPr` from its definition site and mirrors `exactPublishedPr`.

### GitLab consumer (second implementation)

| Trigger | Evidence |
| --- | --- |
| Repository / workflow | `gitlab.com` project `namespace/project` (nested groups allowed). Self-managed hosts through `RELAY_GITLAB_HOSTS`. Same observe → exact-head review/landing bind as GitHub. |
| Credentials | `GITLAB_TOKEN` or `GITLAB_API_TOKEN` (personal access token). Fallback `glab auth token` (`RELAY_GLAB_BIN`). Observation is `GET` with `PRIVATE-TOKEN`. Missing credentials fail closed as `GITLAB_AUTH_REQUIRED` before any request. |
| Permission boundaries | Observe requires `read_api` (or `api`) on the target project: 401 `GITLAB_AUTH_INVALID`, 403 `GITLAB_PERMISSION_DENIED`. Opening or updating an MR needs Developer (or above) with push to the source branch; approval follows project rules; merge needs project merge permission plus explicit `relay-merge`. This adapter does not open, approve, or merge. |
| Fork vs same-project | Identity-match only when `source_project_id === target_project_id`. Fork MRs increment `fork_mr_count` and are never selected implicitly. |
| Identity | Project-scoped `iid` (`mr_number`), `head_ref` / `base_ref`, `head_project_id` / `target_project_id`. Live head is `diff_refs.head_sha`, falling back to MR `sha`. |
| Crash / retry | `GET /merge_requests` is side-effect free. 429 / 5xx / network → `GITLAB_OUTAGE` (`retryable: true`). Re-observation is a pure read. |

## Seam contract

Every adapter implements exactly these members, with no unused extension
points:

| Member | Purpose |
| --- | --- |
| `provider` | `"github"` or `"gitlab"`. |
| `classifyRemote(remoteUrl)` | `{ provider, project, ... }` for a supported forge remote, otherwise `null`. |
| `observeChangeRequest(input)` | Fresh provider-specific change-request facts for `{ project, branch, baseBranch, localHeadSha?, recordedCrNumber? }`. |
| `exactPublishedChangeRequest(observation, { branch }, headSha)` | True only for a unique identity-matched change request whose exact live head equals `headSha`. Review and Landing bind through this decision. |

`classifyForgeRemote(remoteUrl)` and `getForgeAdapter(remoteUrl)` select the
adapter for a remote. GitHub remotes are classified with the exact decision of
the retained production route (`owner/repo` shorthand included); GitLab
classification never claims that shorthand.

## GitHub adapter

`observeChangeRequest` runs the same `gh pr list` observation and reuses
`selectGithubPr` from its definition site in `recover.js`, so equivalent facts
produce byte/decision-compatible GitHub observations (`pr_number`, `pr_state`,
`pr_head_sha`, `pr_base_sha`, `head_repo`, counts). Failures return
`available: false` with the typed, retryable `GITHUB_OBSERVATION_FAILED` error.

## GitLab adapter

Native GitLab merge-request observation through the GitLab REST API
(`GET /projects/:id/merge_requests?source_branch=...&state=all`):

- **Credentials**: `GITLAB_TOKEN` or `GITLAB_API_TOKEN`; otherwise
  `glab auth token` (`RELAY_GLAB_BIN` override). Missing credentials fail
  closed as `GITLAB_AUTH_REQUIRED` before any request.
- **Hosts**: `gitlab.com` by default; self-managed instances through
  `RELAY_GITLAB_HOSTS` (comma-separated). `GITLAB_API_URL` overrides the
  derived `https://<host>/api/v4` base.
- **Identity mapping**: merge-request identity maps to provider-specific facts
  `mr_number` (project-scoped iid), `mr_state`, `head_ref`/`base_ref`,
  `head_project_id`/`target_project_id`, `merge_sha`, and `url`.
- **Exact live head**: `mr_head_sha` is `diff_refs.head_sha` (the head GitLab
  binds the live diff version to), falling back to the MR head `sha`. A
  lagging or diverging head fails `exactPublishedChangeRequest`, so review and
  Landing never bind to a stale head.
- **Fork vs same-project**: only same-project MRs
  (`source_project_id === target_project_id`) identity-match, mirroring the
  GitHub head-repo identity requirement. Fork MRs are counted in
  `fork_mr_count` and never selected implicitly.
- **Selection**: reject MRs whose `target_branch` is not the requested
  `baseBranch` before identity-match or exact-head bind. After that, the
  same ladder as the GitHub route — identity matches win, a recorded closed
  iid is adoptable, exact-head matches beat looser pools, and only a unique
  candidate is selected. A same-source-branch MR targeting a different base
  is not reused; no match is an empty lookup (`matching_mr_count: 0`) so a
  new MR can still be created.
- **Typed failures**: `GITLAB_AUTH_INVALID` (401), `GITLAB_PERMISSION_DENIED`
  (403), `GITLAB_NOT_FOUND` (404), `GITLAB_REQUEST_REJECTED` (other 4xx),
  `GITLAB_OUTAGE` (429/5xx/network, `retryable: true`), and
  `GITLAB_RESPONSE_INVALID`. Outages are retry-safe: re-observation is a pure
  read with no forge-side effect.

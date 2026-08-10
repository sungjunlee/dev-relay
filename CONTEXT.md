# Relay Glossary

This repository glossary names the domain terms used by Relay documentation.
The current contract and authority boundaries are defined by
[ADR-0007](docs/decisions/0007-review-subject-contract-freeze.md) and the
[runtime architecture](references/architecture.md); this file is not a
runtime, schema, or lifecycle authority.

## Language

**Source**:
The Git repository and immutable run start that provide content identity.

**ReviewSubject**:
The derived content-bound value defined by ADR-0007.

**Publication**:
Placing an exact revision on a remote ref. It is not Change Request creation
and does not imply Landing.

**Change Request**:
A forge-owned PR/MR identity for a proposed revision.

**Reviewed Result**:
Terminal proof of exact verification and independent review for one
ReviewSubject. It does not imply Publication or Landing.

**Landing**:
Applying a reviewed revision to a target and independently observing that
result.

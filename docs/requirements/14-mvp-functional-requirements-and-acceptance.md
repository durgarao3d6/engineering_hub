# 14 — MVP Functional Requirements, User Stories and Acceptance
**Date:** 2026-11-21 | **Status:** Proposed for refinement | **Related:** CR-MKT-001 (13)

## Requirement catalogue
| ID | Priority | Requirement | Source / existing asset |
|---|---|---|---|
| MKT-FR-001 | Must | Scan configured local clones/worktrees and expose actionable unfinished-work findings | `collectors/worktrees.js` |
| MKT-FR-002 | Must | Explain every finding with evidence, confidence/unknown state, observed timestamp and safe next action | Git collector |
| MKT-FR-003 | Must | Show recovery evidence for each supported stash clear/restore/rework and move | `stashmgr.js`, `mover.js` |
| MKT-FR-004 | Must | Export explicit user-selected work context to Markdown and JSON with redaction | `bin/hub.js`, store |
| MKT-FR-005 | Must | Allow local-only setup without Azure, Claude or provider credentials | `bin/setup.js` |
| MKT-FR-006 | Must | Preserve local-only, no-remote-write safety contract and existing backup semantics | README, tests |
| MKT-FR-007 | Must | Show loading, empty, stale, partial and failed-source states honestly | UI/server |
| MKT-FR-008 | Must | Maintain regression coverage and recovery fault-injection cases | `test/` |
| MKT-FR-009 | Should | Support `--json` for CLI context/status and stable machine-readable errors | `bin/hub.js` |
| MKT-FR-010 | Should | Search local branches, notes, stashes and worktrees with source and path | SQLite/collectors |
| MKT-FR-011 | Could | Export commit-bound readiness evidence with stale/missing/failed semantics | testing/Git |
| MKT-FR-012 | Could | Link GitHub issues/PRs through read-only adapter | future provider |

## User stories and Gherkin acceptance criteria

### US-01 — Find unfinished work (MKT-FR-001, 002, 007)
As a developer returning after an interruption, I want to see actionable local changes across repositories.
- **Given** a configured repository with modified files, **when** a scan completes, **then** a finding includes repo, worktree path, branch, observation time and evidence for the change.
- **Given** an unpushed branch, **when** upstream is known, **then** ahead/behind state is shown; **when** upstream is absent, **then** show “upstream unknown,” not “unpushed.”
- **Given** an old but clean worktree, **then** do not imply it is abandoned or safe to remove solely because of age.
- **Given** a repository fails scanning, **then** report the error without hiding successful results from other repos.
- **Given** no findings, **then** show an explicit clean/none-found state and scan scope.

### US-02 — Understand recovery (MKT-FR-003, 006, 008)
As a developer, I want to know exactly how to reverse a supported stash or move operation.
- **Given** a stash clear, **when** confirmation is accepted, **then** record original stash hash, recovery ref/patch location, timestamp, operation status and tested recovery instructions.
- **Given** backup/ref creation fails, **then** no destructive follow-up proceeds.
- **Given** a restore/rework operation fails partway, **then** present partial state and recoverable artifacts without falsely declaring success.
- **Given** a purge, **then** irreversible effects require separate, explicit confirmation and warning.
- **Given** concurrent operations on the same repo, **then** existing guards reject unsafe overlap.

### US-03 — Export context (MKT-FR-004, 006)
As a developer, I want to hand work to another agent without copying private transcript content.
- **Given** a worktree/branch selection, **when** I request a handoff, **then** Markdown and JSON exports include only available repo, branch, commit, status, user-approved notes, unresolved questions, and check provenance.
- **Given** Azure or Claude is not configured, **then** export succeeds with missing optional fields marked unavailable.
- **Given** notes contain secret-like values, **then** preview and export apply redaction; user must explicitly confirm inclusion of sensitive content if ever supported.
- **Given** a file path, **then** exports default to relative paths or user-visible redaction; no silent sharing.
- **Given** the same source snapshot, **then** export is deterministic and includes schema version and generated-at timestamp.

### US-04 — Local-only activation (MKT-FR-005, 007)
As a new user, I want to discover unfinished work without creating cloud credentials.
- **Given** Node and Git are installed, **when** I configure a repository folder, **then** local scan works with Azure/Claude disabled.
- **Given** invalid folders or permission errors, **then** explain how to fix them and avoid exposing private path details in logs/exports.
- **Given** unsupported OS behavior, **then** report an explicit compatibility limitation rather than assuming success.

### US-05 — Agent-neutral consumption (MKT-FR-009)
As an agent integration author, I want stable JSON output.
- **Given** `hub context --json`, **then** return schema version, source provenance, structured fields, and documented nonzero exit codes on failure.
- **Given** Hub server is unavailable, **then** retain current offline note-spooling behavior; no new direct concurrent SQLite writers.

### US-06 — Readiness evidence (MKT-FR-011)
As a reviewer, I want test evidence tied to the exact commit.
- **Given** checks run on commit A and branch now points to B, **then** evidence is marked stale.
- **Given** a check has not run, **then** show unknown/missing rather than passing.
- **Given** a failed check, **then** never aggregate status into “ready” without explaining the failure.

## Proposed data contracts (design, not existing schema)
```json
{
  "schemaVersion": "1.0",
  "findingId": "stable-local-identifier",
  "repository": {"key": "example", "path": "[redacted]"},
  "worktree": {"branch": "feature/example", "head": "full-git-sha"},
  "observedAt": "ISO-8601",
  "signals": [{"type": "dirty-worktree", "evidence": "3 modified files", "confidence": "observed"}],
  "unknowns": ["upstream"],
  "suggestedAction": {"kind": "inspect", "destructive": false}
}
```
Handoff export: `schemaVersion`, `generatedAt`, `sourceCommit`, `worktree`, `taskRef?`, `notes[]`, `openQuestions[]`, `checks[]`, `redactions[]`. Recovery event: `operationId`, `type`, `repoKey`, `startedAt`, `completedAt?`, `status`, `sourceRef`, `recoveryRefs[]`, `artifactPaths[]`, `verificationStatus`. Final naming and persistence require architecture review.

## Non-functional requirements
- **NFR-01:** no new network calls for local-only Radar, search or handoff.
- **NFR-02:** no raw prompts or complete agent transcripts stored or exported by default.
- **NFR-03:** no automatic remote writes, merge, push, stash purge or worktree removal.
- **NFR-04:** backups and restore verified before changing destructive paths.
- **NFR-05:** keyboard-accessible navigation, labels, error announcements and focus management; WCAG 2.2 AA as target, not a current compliance claim.
- **NFR-06:** maintain existing behavior under current Windows baseline; add Linux/macOS smoke coverage before support claims.
- **NFR-07:** define scan performance budgets after baseline measurements; don't invent fixed latency targets.
- **NFR-08:** source freshness, partial errors and evidence timestamps visible.
- **NFR-09:** no opt-out-required analytics; local metrics or explicit opt-in only.

## Test matrix
| Test ID | Requirements | Method | Pass condition |
|---|---|---|---|
| T-01 | 001/002/007 | Fixture repos: dirty, clean, detached, missing upstream | Accurate explainable classifications |
| T-02 | 001/007 | One repo inaccessible | Partial results + error state |
| T-03 | 003/006/008 | Stash clear with backup failure | No data loss, operation blocked |
| T-04 | 003/008 | Restore/rework fault injection | Recoverable state + accurate status |
| T-05 | 004 | Markdown/JSON snapshot tests | Deterministic schema and correct redaction |
| T-06 | 004/005 | Azure/Claude disabled | Local export works |
| T-07 | 005 | Fresh setup without provider auth | First local scan succeeds |
| T-08 | 009 | CLI JSON and error codes | Stable output, no direct DB writes |
| T-09 | 011 | Check on SHA A, branch at SHA B | Mark stale |
| T-10 | 006 | Network/remote-write audit | No unauthorized writes |

## Definition of Done
Code + tests; source-linked evidence; threat/restore review for mutating flows; documented migration and rollback if data changes; keyboard and empty-state checks; updated README and user-facing recovery instructions; product owner acceptance.

## Traceability and release gates
MKT-FR-001/002/007 -> US-01 -> T-01/02; 003/006/008 -> US-02 -> T-03/04/10; 004 -> US-03 -> T-05/06; 005 -> US-04 -> T-07; 009 -> US-05 -> T-08; 011 -> US-06 -> T-09.
**Release gate:** no unresolved critical safety issue, accurate source provenance, independently successful local onboarding. **Commercial gate:** external repeat usage and genuine willingness-to-pay evidence; see 13/15.

# 13 — Market-led Product Change Request (BA + Stakeholder)
**Date:** 2026-11-21 | **Status:** Proposed, not approved | **Change request:** CR-MKT-001 | **Sponsor:** Product owner (approval pending)

## Decision requested
Approve a **narrow validation MVP** for Engineering Hub focused on *unfinished work discovery, safe recovery, and portable handoff*. Defer generic agent orchestration, all-provider parity, team SaaS, and dashboard proliferation. This **re-prioritizes** documents 03/07; it does not silently supersede approved requirements (none recorded).

## Business problem
Developers juggling repositories, worktrees, stashes and coding agents may lose track of unfinished changes, spend time reconstructing context, and lack trustworthy recovery evidence. **Market existence and willingness to pay are unverified.** Current Hub already has Git scanning, stash safety, local notes and CLI; the proposed work combines these capabilities into one outcome.

## Stakeholders and interests
| Role | Interest | Approval/input |
|---|---|---|
| Product owner / founder | Personal utility, market validation, constrained investment | Scope and budget approval |
| Solo developer / pilot user | Find work quickly, recover safely, low setup friction | Observed usability and retention |
| Engineering lead / reviewer | Evidence of checks and handoffs | Interview only in MVP; later pilot |
| Security/privacy reviewer | No exfiltration, least privilege, safe exports | Review before external pilots |
| Maintainer | Supportable integrations and migrations | Technical feasibility sign-off |
| QA / tester | Deterministic acceptance, regression and restore testing | Release sign-off |

## Scope and MoSCoW
**Must (pilot MVP):** CR-01 Unfinished Work Radar; CR-02 portable Context Handoff Pack; CR-03 Recovery Ledger evidence improvements; CR-04 folder-only onboarding and trustworthy empty/error states; CR-05 non-destructive behavior by default; CR-06 test and measurement baseline.
**Should:** CR-07 agent-neutral CLI JSON; CR-08 unified local search; CR-09 evidence provenance for test results.
**Could (post validation):** CR-10 commit-bound Readiness Passport; CR-11 GitHub issues/PR adapter selected by pilot demand.
**Won't now:** agent terminal hosting, agent orchestration, automatic cleanup, cloud synchronization, team roles, multi-provider parity, autonomous push/merge, employee productivity ranking.

## Current state / desired state / gap
| Area | Current repository | Desired outcome | Gap |
|---|---|---|---|
| Worktree discovery | `collectors/worktrees.js` exposes Git status and branch metadata | Actionable, explained unfinished-work queue | Cross-repo prioritization and explainability |
| Stash safety | `stashmgr.js` maintains recoverable clear/restore/rework | User-visible recovery proof and instructions | Consistent ledger UI and verification |
| Local moves | `mover.js` retains patches and uses confirmation | End-to-end evidence of affected refs and recovery | Auditable consolidated history |
| Context | `bin/hub.js` exposes task context and notes | Redacted portable handoff without Azure or Claude | Branch/worktree-centric export and schema |
| Agent sessions | `sessions.js` reads Claude transcript metadata | Optional, source-labeled context | No vendor-neutral contract; avoid requiring agent |
| Setup | Node 24+, Git, optional Azure/Claude; Windows tested | Folder-only first value | Cross-OS tests, setup funnel, permission clarity |
| UI | Many separate views | One actionable Radar home | Simplified first-use information architecture |

## Personas / jobs to be done
**Primary:** experienced developer managing multiple repos/worktrees. *When returning after interruption, I want to locate what changed and what is recoverable so I can resume without losing work.*
**Secondary:** reviewer/tech lead. *When handed a change, I want evidence tied to the exact commit and explicit missing/stale checks.*
**Excluded initial persona:** enterprise agent administrator.

## Business rules
BR-01 No push, merge, remote tracker writes or automatic stash deletion. BR-02 All classifications are heuristics with visible reasons; “old” does not equal “safe to delete.” BR-03 Missing evidence is **unknown**, never pass. BR-04 Exports are explicit, locally generated and redacted by default. BR-05 No provider credentials required for local-only use. BR-06 All write operations preserve existing confirmation and recovery contracts. BR-07 Existing Azure and Claude behavior remains compatible.

## Dependencies and constraints
Node >=24 built-in SQLite; local Git availability; existing configuration and branch-prefix assumptions; Windows currently tested, other OSes not verified; no real market data. Do not create a cloud account requirement. Preserve SQLite backup/restore behavior and `127.0.0.1` binding.

## Hypotheses and proposed success gates
H1: At least 8/12 interviewees report recurring costly context-recovery pain before demo.
H2: At least 6/8 external pilots reach first meaningful outcome without founder assistance.
H3: At least 5/8 return for meaningful use in week 2.
H4: No unresolved critical data-loss or credential-exposure incident.
H5: If commercialization is pursued, at least two credible paid commitments.
These are **proposed decision thresholds**, not measurements or guarantees.

## Change impact
Product: new default landing workflow, optional exports, no replacement of current views.
Engineering: local collector aggregation, schema/versioned export, evidence journal and tests.
Support: setup instructions, compatibility matrix, recovery runbooks.
Commercial: free-core versus paid-packaging decision remains open.
Security: path/prompt/secret redaction and no telemetry by default.

## Approval record
- Product owner: **PENDING**
- Engineering feasibility: **PENDING**
- QA/security: **PENDING**
- Pilot recruitment: **PENDING**
- Budget and delivery capacity: **TBD**

**Recommendation:** Approve discovery and thin vertical slice only. Stop broad expansion until the hypotheses are tested.

# 07 — Prioritized Backlog and Delivery Roadmap

## Prioritization method
RICE-lite qualitative: user value, dependency unlock, implementation complexity, safety risk. **Effort sizes are provisional** (S ~ 1–3 dev days, M ~ 4–10, L ~ 2–4 weeks for one familiar developer), not commitments. Validate against code spikes and test execution.

| Epic | Priority | Size | Scope / requirements | Dependencies |
|---|---|---|---|---|
| E-01 Baseline and compatibility | P0 | M | Characterization tests, config migration, API compatibility; FR-006, FR-026, NFR-008 | None |
| E-02 Domain and provider interfaces | P0 | L | Provider-qualified keys, normalized work items/PRs/comments, capability contracts; FR-001–005, FR-030 | E-01 |
| E-03 GitHub provider | P0 | L | GitHub Issues/PRs/reviews, pagination, credentials, health; FR-001–002, FR-018 | E-02 |
| E-04 Attention inbox | P0 | L | Signals, prioritization, ack/snooze, stale/empty states; FR-007–010, FR-027 | E-02, E-03 |
| E-05 Agent abstraction | P1 | M–L | Claude characterization, second agent session collector, neutral context; FR-011–013 | E-01 |
| E-06 Worktree readiness | P1 | M | Git evidence, check adapters, explicit unknown states; FR-014, FR-019 | E-03 |
| E-07 Cross-repo links | P1 | M | Explicit task↔repo↔PR↔session links; FR-015, FR-030 | E-02 |
| E-08 Journal and export | P1 | M | Evidence-linked drafts, Markdown export; FR-016, FR-029 | E-04, E-07 |
| E-09 Universal search | P1 | M | Keyboard search across normalized resources; FR-017, FR-028 | E-02 |
| E-10 Knowledge memory | P2 | L | Opt-in curated lessons/decisions; FR-020 | E-08 |
| E-11 Agent metrics | P2 | L | Quality/cost evidence, no false comparisons; FR-021 | E-05, E-06 |
| E-12 Extensibility | P2 | L | GitLab, MCP, notifications, guided handoff; FR-022–025 | Stable provider contracts |

## Milestones and exit gates
### M0 — Baseline safety
Existing tests pass; backup/restore verified; old Azure+Claude setup documented; key route behaviors snapshotted. No user-facing regression.

### M1 — Provider foundation
Can run with zero remote providers. Azure task identity migrates safely. GitHub Issue and GitHub PR appear through separate adapters. Duplicate numeric IDs are distinct. Auth failures are safe and actionable.

### M2 — Attention MVP
Failed check, review request, unread actionable comment and overdue ask display with source links. Ack/snooze persists. Refresh is idempotent. Provider outage shows stale state.

### M3 — Multi-agent and readiness
Second agent's sessions can link to task/worktree where metadata permits. Worktree readiness distinguishes pass/fail/unknown and commit freshness. Existing Git safety preserved.

### M4 — Evidence and insight
Cross-repo links and weekly journal export work. All factual claims trace to sources. Optional analytics are added only after event quality is validated.

## Example backlog stories
**US-001 (E-02, P0):** As an engineer using Azure and GitHub, I want issue 42 in each system to remain distinct so my notes and plans never cross-link incorrectly. **AC:** two provider-qualified keys, distinct UI URLs, distinct note rows, migration safe.

**US-002 (E-03, P0):** As a GitHub-only engineer, I want to see assigned issues and related PRs without Azure CLI. **AC:** setup works without Azure, pagination tested, source deep links valid.

**US-003 (E-04, P0):** As an engineer, I want to see failed CI checks requiring action. **AC:** check tied to commit SHA, source link, stale state, ack/snooze.

**US-004 (E-04, P0):** As an engineer, I want one actionable alert per unresolved event. **AC:** repeated refresh does not duplicate; new source update reopens alert.

**US-005 (E-05, P1):** As a Codex user, I want sessions linked to my worktree when supported. **AC:** collector reports capability; missing metadata remains unknown, not invented.

**US-006 (E-06, P1):** As an engineer, I want worktree readiness evidence before handoff. **AC:** unknown checks never yield Ready; no automatic push/merge.

**US-007 (E-08, P1):** As an engineer, I want a weekly Markdown report I can edit. **AC:** evidence links, date filtering, redaction preview, no auto-post.

## Delivery principles
Prefer vertical slices over large refactors; feature-flag new providers; ship contract tests before adding third provider; avoid unsupported live agent statuses; maintain current behavior until migration is proven.

## Definition of Ready
Story has user value, source evidence, contract, dependencies, failure/empty states, acceptance examples, security impact, and test approach.

## Definition of Done
Tests green; regression coverage; accessibility pass; provider outage tested; secrets redacted; docs/setup updated; rollback/backup plan; product owner accepts story.

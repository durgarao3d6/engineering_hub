# 09 — Decision Log, Assumptions, Dependencies and Risks

## Proposed decisions (NOT approved)
| ID | Decision proposal | Rationale | Status |
|---|---|---|---|
| ADR-001 | Keep local-first Node.js app and SQLite | Lowest migration risk; existing capabilities | Proposed |
| ADR-002 | Separate work-item, code-host, CI, agent-session, and AI-inference contracts | These are independent capabilities | Proposed |
| ADR-003 | Use provider-qualified resource keys | Prevent numeric-ID collision | Proposed |
| ADR-004 | Keep remote integrations read-only by default | Preserve trust and current safety model | Proposed |
| ADR-005 | Implement GitHub second; GitLab after contracts stabilize | Demonstrates portability with familiar API | Proposed |
| ADR-006 | Implement second agent collector before orchestration | Provides value without remote execution risks | Proposed |
| ADR-007 | Store metadata not raw agent transcripts | Privacy and data minimization | Proposed |
| ADR-008 | Readiness is evidence-based and commit-bound | Avoid false assurance | Proposed |

## Assumptions requiring confirmation
- A1: Primary user is a single engineer; team features are not MVP.
- A2: Windows compatibility is important because `hub.cmd` and setup paths exist.
- A3: Existing Azure DevOps data is the migration baseline.
- A4: GitHub is the next most valuable issue/PR provider.
- A5: Codex is the preferred second coding agent.
- A6: Local-first and read-only provider behavior should remain default.
- A7: User is willing to authorize provider access through CLI/OAuth/PAT with least privilege.

## Dependencies
Provider auth and API access; stable local Git; versioned schema migrations; documented agent CLI/session metadata; test fixtures; backup and restore; browser accessibility; owner feedback on scope.

## Risk register
| ID | Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|---|
| R-01 | Existing notes/plan links corrupt during key migration | M / Critical | Backup, idempotent migration, dual-read compatibility, fixture tests | Engineering |
| R-02 | Agent session formats change between versions | High / Medium | Versioned collectors, capability checks, unknown state | Engineering |
| R-03 | Provider API rate limits or auth restrictions | Medium / High | Backoff, incremental sync, caching, least privilege | Engineering |
| R-04 | AI prompt injection from comments/issues | Medium / High | Data isolation, schema validation, no tools, user approval | Security |
| R-05 | Sensitive code or tokens leak via journal/telemetry | Medium / Critical | Metadata only, redaction preview, local opt-in | Security |
| R-06 | False 'ready' status encourages risky merges | Medium / High | Evidence freshness and fail-closed status | Product/QA |
| R-07 | Feature sprawl obscures daily planner | High / Medium | Attention-first UX, feature flags, staged navigation | Product |
| R-08 | Multiple providers create duplicate work items | High / Medium | Canonical IDs, explicit linking, dedupe rules | Engineering |
| R-09 | Linux/macOS paths differ from Windows behavior | Medium / Medium | Platform matrix, path abstraction, smoke tests | QA |
| R-10 | Benchmark features assumed without validation | Medium / Medium | Spike and test each capability before commitment | Product |

## Stakeholder questions to resolve before implementation
1. Confirm primary audience: solo engineer, tech lead, or team?
2. Rank first two external systems: GitHub, GitLab, Bitbucket, Jira, Linear, Azure DevOps?
3. Rank first two agents: Claude Code, Codex, Gemini CLI, OpenCode, Cursor?
4. Is a local web UI sufficient or is remote access required?
5. Are external writes permanently out of scope or future opt-in?
6. What are acceptable retention periods for sessions, attention, journal, and logs?
7. Which OS and CLI versions are supported?
8. Which existing features must not change visually or behaviorally?
9. What metrics are useful and which feel invasive?
10. What is the available engineering capacity and desired milestone date?

## Research follow-up
Validate agent session/resume behavior empirically; inspect `store.js` schema in depth; measure current test coverage and baseline latency; perform five task-resumption observations; confirm API scopes; capture owner-approved ADRs. Update this document after discovery, rather than presenting assumptions as settled facts.

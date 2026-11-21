# 06 — Data, Privacy, Security and Non-Functional Requirements

## Data classification
| Data | Storage rule | Exposure |
|---|---|---|
| Provider IDs, URLs, titles, states | Local DB; scoped cache | UI with source link |
| Task notes and journal drafts | Local DB; backups | Never sync externally without explicit action |
| OAuth/PAT/CLI tokens | OS credential manager or provider CLI; never Hub DB/log | In-memory use only |
| Agent session metadata | Local DB; minimize and expire | User-visible provenance |
| Full transcripts, prompts, private source code | **Not collected by default** | Optional future opt-in with explicit retention |
| Test/CI evidence | Metadata and URLs by default | No raw logs unless user requests |

## Non-functional requirements
| ID | Priority | Requirement | Verification |
|---|---|---|---|
| NFR-001 | P0 | Existing destructive Git operations retain explicit confirmation and safety checks | Regression tests and manual negative tests |
| NFR-002 | P0 | Provider credentials never appear in DB, logs, exports, API responses or error text | Secret-canary tests |
| NFR-003 | P0 | Hub functions with zero remote providers and without Claude CLI | Offline smoke test |
| NFR-004 | P0 | Provider outage does not block local Git, planner notes or backups | Fault-injection tests |
| NFR-005 | P0 | Local-only binding by default; remote access requires explicit auth design | Network inspection |
| NFR-006 | P0 | Read-only external integrations by default | Mock provider denies all writes |
| NFR-007 | P0 | All provider data treated as untrusted; HTML sanitized; AI prompt injection isolated | Malicious fixture tests |
| NFR-008 | P0 | Schema migrations are versioned, reversible where feasible and backup-aware | Upgrade/rollback tests |
| NFR-009 | P1 | Attention initial render target <2s for cached data on reference machine | Instrumented benchmark; target to validate |
| NFR-010 | P1 | Provider refresh target <30s for typical 100-task scope, excluding throttling | Synthetic performance test; target to validate |
| NFR-011 | P1 | Accessibility: WCAG 2.2 AA target for new UI | Automated + manual keyboard/screen-reader checks |
| NFR-012 | P1 | Every derived status has timestamp, source and freshness metadata | API contract tests |
| NFR-013 | P1 | Export and delete local generated journal/knowledge records | User acceptance tests |
| NFR-014 | P1 | Linux/macOS/Windows supported where existing CLI dependencies permit | CI matrix + manual smoke |
| NFR-015 | P1 | Telemetry opt-in, anonymized where possible, off by default | Settings and network tests |
| NFR-016 | P1 | Sync is idempotent and tolerant of duplicate/out-of-order events | Replay tests |
| NFR-017 | P1 | Backups include new tables and restore without provider credentials | Backup/restore tests |
| NFR-018 | P1 | Rate-limit handling uses retry-after/backoff and avoids busy loops | Simulated 429/503 tests |
| NFR-019 | P2 | User-configurable retention by record class | Retention tests |
| NFR-020 | P0 | Never mark readiness 'Ready' without required evidence | Missing-evidence tests |

## Threat model
- **Prompt injection:** malicious issue/comment text influences an AI model. Mitigate by treating provider text as data, tool isolation, schema validation and user approval.
- **Credential leakage:** provider tokens passed to agent subprocess. Extend existing `ai.js` environment filtering to all providers and future CLIs; do not assume current regex covers GitHub/GitLab tokens.
- **SSRF / host confusion:** user-supplied provider URLs. Validate schemes/host allowlists, redirect policy, private address behavior and authorization scope.
- **Command injection:** branch names, issue titles or CLI options. Never interpolate untrusted strings into shell commands; use argument arrays and validate paths.
- **Data cross-contamination:** two tasks both numbered 123. Require provider-qualified keys and scoped queries.
- **Stale confidence:** cached green checks after a new commit. Bind evidence to commit SHA and observed timestamp.
- **Destructive worktree operations:** preserve existing guards, confirmation, backup patch and failure recovery.
- **Local web server exposure:** enforce loopback binding unless explicit secure remote mode is designed.

## Data migration requirements
Before introducing composite keys: inventory existing foreign keys/IDs in `store.js`; write a deterministic migration with backup and idempotent rerun; preserve Azure IDs in legacy API responses temporarily; map old notes/plan rows to default configured Azure provider only when unambiguous; log unresolved associations for manual review; never silently merge distinct tasks.

## Operational readiness
Structured redacted logs, provider health states, retry diagnostics, manual refresh, last-success timestamps, backup verification, documented recovery procedure, and a compatibility matrix by agent/provider/OS.

# 08 — Acceptance Criteria, UAT and Requirements Traceability

## Test strategy
1. Unit tests for canonical IDs, mapping, priority rules, sanitization, and state transitions.
2. Provider contract tests with recorded redacted fixtures and fake clocks.
3. Integration tests against mocked HTTP/CLI boundaries, including pagination, 401/403/429/5xx and timeouts.
4. Regression suite for Azure+Claude, worktree/stash/move safety, planner and backups.
5. Manual UAT on configured providers and offline-only mode.
6. Cross-platform smoke on Windows, macOS and Linux as feasible.

## UAT scenarios
| Test | Given | When | Then | Requirements |
|---|---|---|---|---|
| UAT-01 | No providers or Claude installed | Hub starts | Local Git, notes and planner usable; onboarding visible | FR-010, NFR-003 |
| UAT-02 | Azure work item #42 and GitHub issue #42 | Both sync | Two distinct records and note histories | FR-003, FR-030 |
| UAT-03 | Azure task and GitHub PR | User links them | Task drawer displays both source links | FR-030 |
| UAT-04 | GitHub-only configuration | User opens task board | Issues load without Azure CLI | FR-001, FR-006 |
| UAT-05 | Failed check on commit A | User opens inbox | Failure linked to commit A with observed timestamp | FR-007, FR-019 |
| UAT-06 | Same event polled twice | Sync repeats | Exactly one attention event | FR-008, NFR-016 |
| UAT-07 | Alert acknowledged then new source event | Sync occurs | New event reopens attention | FR-009 |
| UAT-08 | Provider returns 401/429 | Refresh | Clear auth/rate-limit state, no secret exposure, no crash | FR-010, NFR-002 |
| UAT-09 | Second agent has no cost field | Session list loads | Cost shown unknown, no invented value | FR-011, FR-013 |
| UAT-10 | Session has no supported resume command | User opens session | Resume unavailable with explanation | FR-013 |
| UAT-11 | Worktree has no CI data | Readiness loads | Unknown, not Ready | FR-014, NFR-020 |
| UAT-12 | New commit after green check | Readiness refresh | Old check marked stale or not applicable | FR-014, NFR-012 |
| UAT-13 | User requests weekly journal | Draft generated | Claims have source links, no auto-post | FR-016, FR-029 |
| UAT-14 | Existing Azure/Claude config | App upgrades | Existing setup, notes and hooks still work | FR-006, NFR-008 |
| UAT-15 | Untrusted issue contains prompt-injection text | AI planning runs | Text treated as data; no unauthorized actions | NFR-007 |
| UAT-16 | Move-to-live destructive action | User cancels | No Git mutation | FR-026, NFR-001 |
| UAT-17 | Two refreshes and provider offline | UI viewed | Cached data marked stale with last-success time | FR-010, NFR-012 |
| UAT-18 | Screen-reader/keyboard user | Navigates attention list | All actions accessible with descriptive labels | NFR-011 |
| UAT-19 | User restores backup | Restore completes | Provider links/attention/notes preserved; no tokens stored | NFR-017 |
| UAT-20 | Mixed local repos across hosts | Open task detail | Repo links resolve without forcing same host | FR-015, FR-030 |

## BDD examples
```gherkin
Feature: Provider-safe task identities
  Scenario: Same issue number on different hosts
    Given Azure Boards work item 42 exists
    And GitHub issue 42 exists in owner/repo
    When Engineering Hub synchronizes both providers
    Then each task has a unique provider-qualified key
    And a note on one task does not appear on the other

Feature: Readiness requires fresh evidence
  Scenario: CI result belongs to previous commit
    Given worktree HEAD is commit B
    And the last passing CI result belongs to commit A
    When the readiness panel loads
    Then CI status is stale or unknown
    And overall readiness is not Ready
```

## Traceability conventions
- PRD functional IDs: FR-001 through FR-030.
- Non-functional IDs: NFR-001 through NFR-020.
- Backlog epics: E-01 through E-12.
- UAT: UAT-01 through UAT-20.
- Every implementation PR must cite affected IDs and associated test IDs.
- Any new requirement must have a unique ID, priority, owner, evidence, and test.

## Release sign-off checklist
- [ ] Owner approves scope and priority
- [ ] Provider capability matrix verified against real installed versions
- [ ] Existing tests pass unchanged or with documented intentional migration
- [ ] No unexpected provider writes
- [ ] Secret and prompt-injection tests pass
- [ ] Backup/restore verified
- [ ] Accessibility and offline smoke completed
- [ ] User documentation and setup checks updated

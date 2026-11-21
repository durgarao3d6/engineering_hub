# 03 — Product Requirements Document (PRD)

## Product scope and release strategy
MVP = provider foundation + one cross-provider vertical slice + attention inbox. Phase 2 = multi-agent and worktree readiness. Phase 3 = journal/knowledge and measured analytics. Preserve all existing workflows.

## Functional requirements
| ID | Priority | Requirement | Acceptance intent |
|---|---|---|---|
| FR-001 | P0 Must | Configurable work-item providers (Azure Boards, GitHub Issues first) | Either can be enabled independently |
| FR-002 | P0 Must | Configurable code-host providers (Azure Repos, GitHub first) | PRs/links work independently of work-item source |
| FR-003 | P0 Must | Provider-qualified immutable resource keys | Same numeric issue ID across hosts never collides |
| FR-004 | P0 Must | Normalize task, change request, comment, check, and repository summaries | Common UI does not branch on provider |
| FR-005 | P0 Must | Preserve raw provider metadata and capability flags | Unsupported operations show explicit unavailable state |
| FR-006 | P0 Must | Existing Azure DevOps + Claude behavior remains functional | Existing tests and smoke flows pass |
| FR-007 | P0 Must | Unified attention inbox of actionable signals | Each signal includes cause, timestamp, source and deep link |
| FR-008 | P0 Must | Deduplicate attention signals across refreshes | No duplicate alert for same source event |
| FR-009 | P0 Must | Acknowledge/snooze attention items locally | Provider is not mutated; reactivation rules explicit |
| FR-010 | P0 Must | Degrade gracefully when a provider is offline or unconfigured | Stale cache clearly labeled; local Git unaffected |
| FR-011 | P1 Should | Agent adapters for Claude and one second CLI | Sessions show source and supported capabilities |
| FR-012 | P1 Should | Agent-neutral task context and note commands | Context JSON schema stable; writes retain provenance |
| FR-013 | P1 Should | Agent session timeline and resume affordance | No invented cost/resume command when unsupported |
| FR-014 | P1 Should | Worktree verification/readiness summary | Local tests, CI checks and review status distinguish unknown from pass |
| FR-015 | P1 Should | Cross-repo task-to-branch/worktree/PR graph | One task can link multiple repos and PRs |
| FR-016 | P1 Should | Evidence-linked daily/weekly engineering journal | Each factual statement links to source evidence |
| FR-017 | P1 Should | Global search/command palette | Keyboard search across tasks, branches, sessions and notes |
| FR-018 | P1 Should | Configurable provider health/setup checks | Auth and permission failures actionable but non-sensitive |
| FR-019 | P1 Should | Optional CI provider adapters (GitHub Actions, Azure Pipelines) | Failed checks appear in attention and readiness |
| FR-020 | P2 Could | Knowledge cards from accepted notes/decisions | Explicit opt-in, source links and retention controls |
| FR-021 | P2 Could | Agent quality metrics and trend views | Missing denominators/cost shown as unknown |
| FR-022 | P2 Could | User-configured alert rules and notification channels | Quiet hours, dedupe and no alert storms |
| FR-023 | P2 Could | Optional MCP server for context/notes | Read-only by default; writes authenticated and scoped |
| FR-024 | P2 Could | Multi-provider PR review aggregation | Provider-specific review semantics preserved |
| FR-025 | P2 Could | Guided task handoff to an agent | Requires explicit user approval and scoped workspace |
| FR-026 | P0 Must | Provider-independent Git worktree and stash operations | Existing safety/confirmation rules unchanged |
| FR-027 | P0 Must | Explain why an item is prioritized | Rule, timestamp, and supporting evidence visible |
| FR-028 | P1 Should | Provider-specific deep links | Navigate to original item/PR/check |
| FR-029 | P1 Should | Export work journal to Markdown | Export contains no hidden prompt/session transcript |
| FR-030 | P0 Must | Support multiple repos and mixed provider configurations | Azure task can link GitHub PR through explicit association |

## Detailed feature rules
### Attention inbox (FR-007–010, FR-027)
Signal kinds: CI failed, review requested, review changes requested, unread actionable comment, tracked ask overdue, worktree conflict, agent awaiting approval, blocked task, stale worktree (opt-in threshold). Default order: safety/blocking > direct request > overdue > informational. Each row has reason, source, task/repo, observed time, last successful sync, link, acknowledge and snooze. Acknowledgement is local only. Reopen on a new source event or materially changed status. Never infer an agent is blocked solely from inactivity.

### Provider interoperability (FR-001–006, FR-030)
Support zero, one or multiple providers. Work-item providers and code hosts are independent capabilities. Mixed-provider links may be manual first; automated linking uses configurable branch patterns or explicit references and exposes confidence/source. Distinguish unavailable, unsupported, empty, permission denied and sync failed.

### Agent sessions (FR-011–013)
Session states: running, idle, awaiting-input, completed, failed, unknown. State is displayed only when evidenced; otherwise unknown. Store metadata (agent, session ID, repo/worktree, task ref, timestamps, optional resume/cost), not raw conversations. Prefer CLI/hook event collection; transcript parsers are adapter-specific and versioned.

### Readiness (FR-014)
Show local cleanliness, branch divergence, tests last run, CI state, review state, unresolved threads and conflicts separately. Overall status is **Ready / Needs attention / Unknown**, never 'Ready' when required evidence is absent. The hub does not automatically merge or push.

### Journal (FR-016, FR-029)
Create editable draft from observed commits, work items, PRs, plans and notes. Each claim must carry evidence references. AI paraphrasing optional and opt-in; no automatic publication. User can remove sensitive details.

## UX states
All features must have loading, empty, disconnected, permission-denied, stale, partial and error states. Actions must be keyboard accessible and announce results.

## Explicit non-goals
Full autonomous coding execution, automatic changes to external trackers, unconditional CI execution, central storage of agent conversations, mandatory cloud services, and replacing existing task planner.

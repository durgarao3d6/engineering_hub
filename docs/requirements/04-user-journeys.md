# 04 — Personas, User Journeys and UX Requirements

## Journey J-01: Start my engineering day
**Actor:** Engineer. **Trigger:** Opens Hub before work. **Preconditions:** At least one provider or local repo configured.
1. Hub shows current date, last-sync time, attention count and planned tasks.
2. Attention items are grouped by urgency and actionable reason; each links to evidence.
3. Engineer acknowledges an alert, snoozes a follow-up, or opens linked task.
4. Engineer drags relevant task into Today; existing planner rules remain intact.
**Alternate flows:** Provider offline -> show cached items marked stale; no provider -> show local Git and onboarding. **Success:** No hidden critical items; action changes only Hub state unless explicitly authorized.

## Journey J-02: Resume work on a task
1. Search by provider-qualified task reference or title.
2. Open task detail: description, notes, associated repos, branches, worktrees, PRs, CI and sessions.
3. Copy/open worktree path or supported agent resume command.
4. Append a note using UI or `hub note`.
**Alternates:** No worktree, multiple worktrees, missing permissions, conflicting task IDs. **Success:** Every association is explainable and reversible.

## Journey J-03: GitHub issue with Codex, no Azure or Claude
1. Configure GitHub work-item and source-control providers, local Git scan, Codex collector.
2. GitHub issue appears with provider key; associate branch/worktree.
3. Run Codex separately; Hub detects supported session metadata or user links it manually.
4. Add task note; verify CI/checks and review status; plan completion.
**Success:** Core flow works without Azure CLI or Claude executable.

## Journey J-04: Azure task with GitHub PR
1. Load Azure work item and GitHub repo/PR from separate providers.
2. Link explicitly by reference; preserve origin identities.
3. Display both in task drawer and attention inbox.
**Success:** No assumption that work item and PR share provider or integer ID.

## Journey J-05: Review a worktree before handoff
1. Open worktree; view branch state, uncommitted changes, last test run, checks and PR review.
2. Read individual evidence and unknowns.
3. If changes are risky, Hub recommends manual review; existing destructive operations still require confirmation.
**Success:** No false-ready label; no automatic merge/push.

## Journey J-06: Create weekly status
1. Choose date range, repositories, providers and redaction options.
2. Hub assembles observed completed tasks, merged PRs, commits, test evidence and unresolved blockers.
3. User edits a Markdown draft and exports it.
**Success:** All factual claims trace to evidence; missing provider data disclosed.

## UX information architecture (proposed)
Home: Today + Attention. Work: Tasks, Worktrees, PRs, Sessions. Reflect: Journal, Knowledge, Workflow ratings. System: Integrations, Provider health, Backups.
Preserve current navigation wherever possible; introduce new items progressively.

## Accessibility and usability
Keyboard navigation, visible focus, semantic status labels, screen-reader announcements for sync and action results, reduced motion, high contrast, non-color-only status, time-zone-aware timestamps, clear stale-data indicator, reversible local dismiss/snooze, confirmation before destructive operations.

## Example empty/error copy
- “GitHub not connected — configure a provider to see issues and pull requests.”
- “Agent status unavailable — this agent does not expose live session state.”
- “Checks not loaded — readiness cannot be confirmed.”
- “Last synced 2 hours ago — results may be outdated.”

# 01 — Product Vision and Business Case

## Problem statement
Engineering work is fragmented across issue trackers, Git worktrees, pull/merge requests, local coding-agent sessions, comments, CI results, and personal notes. Engineers spend time reconstructing context and deciding what requires attention. The current Engineering Hub addresses many of these needs but is tightly coupled to Azure DevOps for work items/PRs and Claude Code for AI execution/session telemetry.

## Vision
**One trustworthy, local-first view of what matters now, where work lives, what agents are doing, and what evidence is needed to ship safely.**

## Target personas
| Persona | Primary jobs | Pain |
|---|---|---|
| Individual engineer (primary) | Plan day, track tasks, manage worktrees and agent sessions | Context switching and forgotten follow-ups |
| Tech lead (secondary) | Review PRs, track blockers, communicate delivery | Dispersed signals; ambiguous ownership |
| AI-assisted engineer | Delegate bounded tasks to coding agents and validate output | Agent/session fragmentation; unclear readiness |
| Privacy-conscious contributor | Work locally with minimal cloud exposure | Sensitive source code and discussion content |

## Jobs to be done
- When starting work, show prioritized, explainable items requiring my action.
- When resuming a task, retrieve its branch, worktree, notes, PR, checks and agent sessions.
- When a coding agent runs, understand progress, status and whether intervention is needed.
- When reviewing delivery, see evidence: tests, builds, review status and outstanding blockers.
- When preparing an update, generate a cited work journal without fabricating accomplishments.

## Business outcomes and hypotheses
| Outcome | Hypothesis | Suggested measurement |
|---|---|---|
| Lower context-switching cost | Unified attention queue reduces manual checking | Self-reported minutes/day spent checking systems |
| Faster resumption | Task context unifies local and remote artifacts | Median time from opening task to meaningful action |
| Fewer missed follow-ups | Actionable comments and build failures are visible | Unacknowledged actionable events older than 2 working days |
| Greater portability | Agent and provider adapters avoid lock-in | End-to-end workflows proven across 2 agents and 2 provider combinations |
| Safer changes | Evidence-based readiness improves decisions | % worktrees with explicit test/check evidence before handoff |

Baseline values are **unknown**; instrument and collect consented measurements before setting numerical improvement targets.

## In scope
Read-only provider integrations, normalized task/change-request model, attention inbox, multi-agent session discovery, worktree readiness, shared context, daily/weekly journal, provider-aware configuration, accessibility and safety.

## Out of scope for first release
Automatic merge/push, autonomous multi-agent task assignment, hosted multi-tenant SaaS, replacing Azure Boards/GitHub/GitLab, unrestricted remote command execution, organization-wide analytics, and claims of precise agent productivity from tokens alone.

## Success gates
- Existing Azure DevOps + Claude Code workflow remains functional.
- At least one GitHub-backed issue/PR workflow works without Azure DevOps.
- At least one additional agent is discoverable and linked to a task without Claude Code.
- An attention item always links to underlying evidence and can be dismissed or acted on.
- Offline/unconfigured providers degrade gracefully; local Git features remain available.

## Product principles
Local-first; evidence over guesses; human-controlled destructive operations; explicit capabilities; optional integrations; progressive disclosure; accessible by keyboard; no secrets in logs; transparent AI usage/cost; backwards compatibility.

## Open business questions
Single-user vs small-team priority? Windows-only vs macOS/Linux target? Which second agent first (Codex/OpenCode)? Which first remote provider (GitHub/GitLab)? Does the owner want read-only forever, or opt-in write actions later? Which work item system is primary when multiple are connected?

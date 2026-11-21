# 02 — Current-State Assessment and Competitive Research

## Evidence classification
**Observed in source** = inspected repository tree, README, and selected implementation files. **External reference** = documented design/API of another project, not proof of feature parity. **Proposal** = feature recommendation. Findings are as of 2026-11-21; upstream projects may evolve.

## Current repository inventory
| Area | Evidence in Engineering Hub | Assessment |
|---|---|---|
| Dashboard / API | `server.js`, `ui/app.js`, `ui/index.html` | Existing UI/API; extend rather than rewrite |
| Local Git | `collectors/git.js`, `collectors/worktrees.js`, `collectors/wtcontext.js` | Provider-neutral local Git foundation |
| Stash / move safety | `stashmgr.js`, `mover.js`, `collectors/stashinfo.js` | Valuable guarded workflows; preserve safety semantics |
| Work items and PRs | `collectors/ado.js`, `collectors/tasks.js` | Azure DevOps API assumptions embedded in task aggregation |
| Comments | `commentwatch.js`, `ui/comments.js` | Existing actionable comment tracking; extend with adapters |
| Planning | `planner.js`, `planboard.js`, `planai.js`, `plan-score.js` | Reuse normalized work-item data and review-first AI flow |
| AI invocation | `ai.js` | Headless Claude CLI, process isolation and secret filtering |
| Agent sessions | `sessions.js`, `hooks/session-start.js`, `hooks/stop-reminder.js` | Claude transcript/hook-specific |
| Shared context | `bin/hub.js`, `inbox.js` | Reusable CLI note/context interface |
| Storage | `store.js`, `backup.js` | Local persistence and backup; migration needed for provider IDs |
| Setup | `config.js`, `bin/setup.js`, `hub.config.example.json` | Azure/Claude-specific configuration and checks |
| Quality | `test/` (multiple test files) | Existing regression suite; expand contract fixtures |

### Specific coupling observed
- `ai.js` resolves `HUB_CLAUDE_BIN` or `claude`, invokes the CLI and checks its version.
- `sessions.js` reads Claude session records; `config.js` defaults sessions to `~/.claude/projects`.
- `collectors/ado.js` obtains a token via Azure CLI, restricts requests to `dev.azure.com` and guards read-only access.
- `collectors/tasks.js` builds Azure PR URLs and joins Azure work-item IDs to local Git state.
- `bin/setup.js` checks Azure CLI and Claude CLI.
- `config.js` recognizes `organization`, `project`, `azureDevOps` and `sessions` rather than a general provider registry.

## External benchmark and transferable patterns
| Project/reference | Verified pattern | Adaptation for Engineering Hub | Do not copy blindly |
|---|---|---|---|
| OpenHands Agent Canvas | UI/backend boundary and multiple agent-server endpoints | Keep Hub UI separate from optional execution adapters | Full remote agent runtime is not needed for read-only session tracking |
| OpenHands Automation | Automation scheduling separate from execution | If future automations are added, isolate dispatch/approval policy | No autonomous execution in MVP |
| Langfuse | Open-source LLM tracing/evaluation ecosystem | Optional event schema for agent quality and cost evidence | Avoid invasive capture of prompt content by default |
| GitLab Merge Requests API | Provider-specific states, approvals and checks | Normalize common fields; retain raw provider metadata | Do not collapse all GitLab statuses into a false boolean |
| GitHub REST APIs | Issues, PRs, checks and notifications as separate resources | Separate work-item, code-host and CI capabilities | Avoid equating GitHub issues with Azure Boards feature set |
| MCP specification | Standard tool integration transport | Optional interface for exposing Hub context/notes | MCP does not standardize transcript storage or agent lifecycle hooks |

## Opportunity gaps
1. No general provider contract for work items/PRs/comments.
2. No general agent session collector or agent capability detection.
3. No unified attention model across comments, CI, PRs and sessions.
4. No explicit readiness summary per worktree.
5. No evidence-linked journal/export spanning all providers.
6. Provider-qualified identities and collision-safe cross-links are needed before mixing Azure/GitHub tasks.

## Competitive positioning
**Do:** coordinate existing engineering tools and preserve personal workflow state. **Do not:** compete with full IDEs, code-host platforms, or autonomous agent execution frameworks. Differentiator is the intersection of local Git state + human attention + daily planning + safe agent context.

## Source register (primary links)
- Engineering Hub: https://github.com/durgarao3d6/engineering_hub
- OpenHands architecture: https://github.com/OpenHands/OpenHands/blob/main/docs/architecture.md
- OpenHands project boundaries: https://github.com/OpenHands/OpenHands/blob/main/README.md
- OpenHands automation: https://github.com/OpenHands/automation
- Langfuse: https://github.com/langfuse/langfuse
- GitLab MR API: https://docs.gitlab.com/api/merge_requests/
- GitHub REST API: https://docs.github.com/en/rest
- MCP specification: https://modelcontextprotocol.io/specification

The links document patterns, not a claim that every feature is currently implemented or compatible. Agent-specific CLI/session capabilities require a discovery spike against installed versions.

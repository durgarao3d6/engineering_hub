# 05 — Integration and Technical Requirements

## Architecture decision proposal
Keep the existing single-process Node.js Hub, local Git collectors, SQLite persistence, CLI and browser UI. Add **small capability-based adapters**, a normalized model, and an aggregation layer. Avoid microservices or mandatory agent runtimes.

```text
UI / existing planner, notes, scorecard, attention, journal
                 |
       Hub services + normalized domain model
          /                 |                 \
 Work-item providers   Code-host/CI providers   Agent adapters
 Azure Boards/GitHub   Azure Repos/GitHub        Claude/Codex
          \                 |                 /
           Local Git collectors + SQLite + CLI
```

## Provider contracts (conceptual JavaScript/TypeScript)
```ts
type ResourceKey = string; // e.g. github:owner/repo/issues/42
interface WorkItemProvider {
  id: string;
  capabilities(): Promise<{comments:boolean; search:boolean; write:boolean}>;
  listAssigned(cursor?:string): Promise<{items:WorkItem[]; cursor?:string}>;
  get(key:ResourceKey): Promise<WorkItem|null>;
  listComments?(key:ResourceKey, cursor?:string): Promise<CommentPage>;
}
interface CodeHostProvider {
  id:string;
  listChangeRequests(repo:ResourceKey, cursor?:string): Promise<ChangeRequestPage>;
  getChangeRequest(key:ResourceKey): Promise<ChangeRequest|null>;
  getChecks?(repo:ResourceKey, ref:string): Promise<CheckSummary[]>;
}
interface AgentSessionProvider {
  id:string;
  capabilities(): Promise<{sessions:boolean; resume:boolean; cost:boolean; liveState:boolean}>;
  listSessions(filter:{repoPath?:string; since?:string}): Promise<AgentSession[]>;
}
interface AiInferenceProvider {
  id:string;
  available(): Promise<boolean>;
  completeStructured(input:{purpose:string; schema:object; prompt:string; budgetUsd?:number}): Promise<unknown>;
}
```
Agent session collection and AI inference are **different contracts**: a CLI can provide one but not the other. Capability negotiation prevents fabricated feature support.

## Canonical entities
- WorkItem: `key, providerId, sourceId, title, state, priority?, assignee?, url, updatedAt, raw?`
- ChangeRequest: `key, providerId, repoKey, title, state, draft?, reviewers?, checks?, url, raw?`
- Repo: `key, localPaths[], remoteUrl?, defaultBranch?, hostProviderId?`
- Worktree: `localId, repoKey, path, branch, gitStatus`
- AgentSession: `key, agentId, repoKey?, worktreePath?, taskKey?, startedAt, state?, resumeCommand?, costUsd?`
- AttentionEvent: `id, sourceKey, eventFingerprint, kind, severity, observedAt, sourceUpdatedAt?, status, snoozeUntil?, evidenceUrls[]`
- Link: `fromKey, toKey, kind, origin(manual|branch|provider), confidence?, createdAt`
- Evidence: `key, kind, sourceUrl?, observedAt, status, rawMetadata?`

## Identity and linking
Never use bare numeric IDs as global keys. Provider IDs are configured and stable. Canonical keys must be escaped/normalized and include host/namespace where needed; avoid storing credentials in keys. Link precedence: explicit user association > provider-native relation > validated branch pattern > heuristic suggestion. Heuristic suggestions are never silently accepted.

## Repository-specific migration map
| Current module | Proposed seam |
|---|---|
| `collectors/ado.js` | `providers/azure/client.js` preserving auth/read-only guard |
| `collectors/tasks.js` | `services/work-items.js` + provider-specific adapters |
| `commentwatch.js` | `services/attention/comments.js` consuming normalized comments |
| `ai.js`, `planai.js` | `providers/ai/claude.js` and later second AI inference adapter |
| `sessions.js` | `providers/agents/claude-sessions.js` plus another collector |
| `config.js`, `bin/setup.js` | versioned providers config + per-provider diagnostics |
| `store.js` | additive migrations for provider keys, links, attention, evidence |
| `server.js` | route handlers call services; preserve existing endpoints initially |
| `collectors/git.js`, `collectors/worktrees.js` | remain shared and local |

## Example configuration (proposed, not currently supported)
```json
{
  "configVersion": 2,
  "providers": {
    "workItems": [{"id":"work","type":"azureBoards"},{"id":"personal","type":"githubIssues"}],
    "codeHosts": [{"id":"work-repos","type":"azureRepos"},{"id":"personal-repos","type":"github"}],
    "ci": [{"id":"gh-actions","type":"githubActions"}]
  },
  "agents": {
    "sessions": [{"id":"claude","type":"claudeCode"},{"id":"codex","type":"codex"}],
    "inference": {"default":"claude"}
  }
}
```
Existing `organization`, `project`, `azureDevOps`, `sessions.projectsDir` and `HUB_CLAUDE_BIN` continue to work via v1 config migration.

## API proposals
`GET /api/providers/health`, `GET /api/attention`, `POST /api/attention/:id/ack`, `POST /api/attention/:id/snooze`, `GET /api/sessions`, `GET /api/worktrees/:id/readiness`, `GET /api/journal?from=&to=`, `GET /api/tasks/:key/links`, `POST /api/tasks/:key/links`. Paths are conceptual; align with existing route conventions after code spike.

## Integration constraints
Provider calls: bounded concurrency, pagination, rate-limit backoff, timeouts, cache freshness, least-privilege credentials, explicit error states. CLI invocations: allowlisted executable/config, sanitized environment, bounded output/time, no shell interpolation, no arbitrary command from task text. External write operations disabled by default.

## Implementation sequence
1. Characterization tests for Azure/Claude paths.
2. Canonical keys + config compatibility layer + contract tests.
3. GitHub Issues/PR/check adapters and cross-provider linking.
4. Attention service and UI.
5. Second agent session adapter and optional AI inference adapter.
6. Readiness, journal and advanced capabilities.

## Technical discovery spikes
Verify Codex/OpenCode session metadata availability and consent constraints; GitHub permissions for PR review/checks; how `store.js` keys existing task references; exact API route compatibility; performance on large repo scans; Windows path semantics.

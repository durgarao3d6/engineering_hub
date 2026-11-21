# GitHub, Codex and Gemini CLI — first compatibility slice
Status: **experimental implementation**, not full provider parity.

## GitHub
Engineering Hub exposes a **read-only** local API `GET /api/integrations/github?repo=<configured absolute clone path>` using the optional GitHub CLI (`gh`). Install and authenticate `gh` with `gh auth login`. Only configured clones are accepted. The adapter returns repository identity, default branch and up to 50 open PRs. No GitHub token is stored by Hub; no remote mutations occur. This does **not** replace the Azure task board, Azure comments, planner, or GitHub Issues integration.

## Codex and Gemini CLI
`GET /api/integrations/agents` discovers local session **file metadata only**, without reading transcript contents. Codex uses `~/.codex/sessions/**/*.jsonl`; Gemini CLI uses `~/.gemini/tmp/**/*.json` as initial known locations. Missing folders are reported as unconfigured. This is not live session control, task linking, prompt replay, or complete version-independent session support. Directory layouts may change; verify against installed CLI versions. Scan depth and file counts are capped.

## Security and limits
- No background network calls to coding-agent vendors.
- No session prompt text is read, persisted or exposed by these adapters.
- GitHub requests are explicitly read-only and require a locally authenticated `gh` CLI.
- GitHub inspection is limited to the configured clone list; API calls return safe error messages.
- These endpoints are intended for the existing localhost-only Hub server. As with other local APIs, do not expose the port to a network.

## Next increments
1. GitHub issue/PR normalization into a provider-neutral board without breaking Azure workflows.
2. Codex/Gemini session-to-worktree association using reliable metadata, with privacy tests.
3. CLI JSON context export and user-approved agent handoff.
4. UI integrations/status panels and cross-platform test matrix.

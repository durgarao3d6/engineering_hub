# GitHub, Codex and Gemini CLI — first compatibility slice
Status: **experimental implementation**, not full provider parity. **Off by default.** Turn it on with `"integrations": { "enabled": true }` in `hub.config.json`; until then both routes answer 404.

## GitHub
Engineering Hub exposes a **read-only** local API `GET /api/integrations/github?repo=<configured absolute clone path>` using the optional GitHub CLI (`gh`). Install and authenticate `gh` with `gh auth login`. Only configured clones are accepted. The adapter returns repository identity, default branch and up to 50 open PRs. No GitHub token is stored by Hub; no remote mutations occur. This does **not** replace the Azure task board, Azure comments, planner, or GitHub Issues integration.

## Codex and Gemini CLI
`GET /api/integrations/agents` discovers local session **file metadata only**, without reading transcript contents. Codex uses `~/.codex/sessions/**/*.jsonl`; Gemini CLI uses `~/.gemini/tmp/**/session-*.json` (chat sessions only; `logs.json` and settings files are ignored) as initial known locations. Missing folders are reported as unconfigured; folders that exist but cannot be read, and scans that hit the file limit, are listed in `errors`. This is not live session control, task linking, prompt replay, or complete version-independent session support. Directory layouts may change; verify against installed CLI versions. Scan depth and file counts are capped.

## Security and limits
- No background network calls to coding-agent vendors.
- No session prompt text is read, persisted or exposed by these adapters.
- GitHub requests are explicitly read-only and require a locally authenticated `gh` CLI.
- GitHub inspection is limited to the configured clone list; Path comparison ignores letter case, like the rest of the hub. Only two `gh` commands can run (`repo view`, `pr list`); a guard test fails if another is added. Errors say what is wrong: `notinstalled`, `auth` (not signed in), `noremote` (the clone is not on GitHub, for example an Azure DevOps repository), `access`, `timeout` or `other`.
- These endpoints are intended for the existing localhost-only Hub server. As with other local APIs, do not expose the port to a network.

## Next increments
1. GitHub issue/PR normalization into a provider-neutral board without breaking Azure workflows.
2. Codex/Gemini session-to-worktree association using reliable metadata, with privacy tests.
3. CLI JSON context export and user-approved agent handoff.
4. UI integrations/status panels and cross-platform test matrix.

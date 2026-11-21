# 10 — Comprehensive UX Audit and Experience Redesign Requirements

**Repository:** `durgarao3d6/engineering_hub` | **Audit date:** 2026-11-21 | **Status:** Proposed / requires validation  
**Method:** Static expert review of all 10 `ui/` files (`DESIGN.md`, `index.html`, `app.js`, `styles.css`, `planner.js`, `comments.js`, `stash.js`, `testing.js`, `grid.js`, `charts.js`, `motion.js` — ten JavaScript/HTML/CSS files plus design notes; **11 files total**). Source-based heuristic assessment; **not** a live browser test, accessibility audit with assistive technology, or user research. Findings marked **Observed** are directly supported by source; **Risk / verify** means likely concern requiring interaction testing.

## 1. Executive assessment

Engineering Hub has a thoughtful foundation: a documented warm visual language, status semantics, reusable skeleton/error components, keyboard navigation in grids, native dialogs, reduced-motion handling, responsive/container-query intent, chart table alternatives, and explicit reassurance that Azure read failures do not affect local work. Preserve these.

The main experience risk is **fragmentation**: Work, Code and Insights are organized around internal modules rather than the user's outcome. A user tracking a single task may need to traverse Today's plan, Work planner, Task board, Comments, Worktrees, Testing and Token usage. Multi-agent and multi-provider features would amplify this problem unless task context and an attention-first entry point become the connective layer.

### Severity scale
- **Critical:** potential loss of work, security or inaccessible core flow.
- **High:** repeated failure of important user job or misleading state.
- **Medium:** substantial friction, navigation or comprehension cost.
- **Low:** polish or preference.  
Severity is an **expert estimate**, not a measured incident rate.

## 2. Evidence-based UX inventory

| Surface | Source | Existing strengths | Opportunity / risk |
|---|---|---|---|
| Shell/navigation | `index.html:11–40`, `DESIGN.md` | Grouped navigation, persistent safety status, refresh | 11 feature links; no attention/home destination; default state `worktrees` in `app.js` |
| Today | `index.html:52`, `app.js` | Dedicated daily workflow | Context, blockers and verification live elsewhere |
| Planner | `planner.js` | Board and daily revision; explicit state changes | Auto-revision on first open is non-obvious; needs explanation and undo semantics |
| Task board/reviews | `index.html:54–71`, `app.js` | Search, status/type filters, review tab, cards | Numerous simultaneous filters; Azure-specific identifiers and deep links |
| Comments | `comments.js` | Mentions, waiting-on-others, nudge due, optional notifications | Separate attention queue; local 'read' vs remote read distinction can be clearer |
| Worktrees | `index.html:73–83`, `app.js` | Repo filter, Git status, paginated grid | Readiness, task and session context should be co-located |
| Stashes | `stash.js` | Verdicts, analysis, filtering, selection | Risky operations need explicit consequence/restore preview and staged confirmation |
| Live moves / cleared | `index.html:85–98` | Operational history visible | Labels may be unfamiliar; clarify purpose and lifecycle |
| Testing | `testing.js` | QA status, evidence, filterable flows | 'In QA', 'Can port' and 'No evidence' require contextual definitions |
| Usage/ratings | `index.html:100–102`, `charts.js` | Data visualizations and table alternatives | Metrics should distinguish useful outcomes from token volume |
| Grid system | `grid.js`, `DESIGN.md` | Shared sizing/density, keyboard row navigation | Hidden columns/ellipsis can conceal important data; touch and assistive-tech validation |
| Design tokens/motion | `styles.css`, `motion.js` | Light/dark tokens, reduced-motion check | Confirm implemented contrast, forced-colors, dynamic count announcements and font consistency |

### Concrete source observations
1. `index.html:15–29` has **11 primary navigation destinations**: Today's plan, Work planner, Task board, Comments, Worktrees, Stashes, Live moves, Cleared, Testing, Token usage, Workflow ratings. **Observed**.
2. `app.js` initializes `S.view: 'worktrees'`. The first-run default is tool-centric; verify hash-based initial navigation before changing. **Observed**.
3. `index.html:113` labels the task drawer link **“Open in Azure DevOps”**, while `app.js` builds work-item links using a global `ADO` prefix. **Observed**, future multi-provider UX blocker.
4. `planner.js` automatically calls `/api/planner/revise` on first visit when no revision exists; comment says it only reads/flags. **Observed**; make the behavior transparent.
5. `comments.js` states read markers are local to Hub, not Azure; `cwNotify` supports optional browser notifications. **Observed**; explain the scope of acknowledgement.
6. `app.js` uses dynamic `innerHTML` rendering extensively and task cards with `role="button"` and `tabindex="0"`. **Observed**; verify Enter/Space parity, focus persistence, accessible names and announcements.
7. `grid.js` hides less important columns based on width and provides keyboard row navigation; `DESIGN.md` specifies ellipsis/full text on hover. **Observed**; verify touch and keyboard discovery of hidden information.
8. `charts.js` implements keyboard readouts and table view; `motion.js` respects `prefers-reduced-motion`. **Observed**; retain.
9. `styles.css` defines `--font-body` but `body` declares a separate hard-coded font stack. **Observed**; consolidate typography tokens and test actual rendering.
10. `index.html:108` provides `aria-live="polite"` for toasts; native `dialog` is used for task drawer and confirmation. **Observed**; verify focus return and critical-error announcement in browser.

## 3. UX findings and proposed changes

| UX ID | Severity | Finding / rationale | Recommendation | Evidence | Acceptance |
|---|---|---|---|---|---|
| UX-001 | High | Navigation maps modules, not end-to-end tasks | Add **Home / Attention** as default landing view with Today, blockers, actionable signals | `index.html` nav; `app.js` default | User sees top actions and last sync without switching views |
| UX-002 | High | Related task context is scattered | Create unified **Work Item Detail** with Overview, Activity, Code, Reviews & Checks, Notes, Agent Sessions | Task drawer and distinct modules | Task can be resumed from one contextual surface |
| UX-003 | High | Task links are Azure-specific | Use source-neutral “Open in [provider]” label and provider identity/icon; show repo/host | `index.html:113`, `app.js` `ADO` | GitHub issue never links to Azure; mixed provider clear |
| UX-004 | High | Comments are isolated from other urgent signals | Merge into unified Attention while retaining detailed Comments view | `comments.js` | One deduplicated actionable event with reason and deep link |
| UX-005 | High | Safety/verification state fragmented | Add Worktree **Readiness** summary with explicit pass/fail/unknown and commit freshness | Worktrees, Testing, reviews | Missing checks never appear as “Ready” |
| UX-006 | Medium | High nav count increases choice cost | Introduce progressive IA and collapsible groups, preserve deep links | 11 nav links | Frequent actions within 1–2 navigational decisions |
| UX-007 | Medium | Multiple task filters may overwhelm | Move advanced filters behind “Filters”; show active chips, clear-all, result count | `index.html:57–65` | All filters visible/removable; no hidden active filter |
| UX-008 | Medium | Status badges need consistent meanings | Publish status glossary and cross-provider language (“Open”, “In progress”, “Blocked”, “Done”) with source label | `ui/DESIGN.md`, provider coupling | Each state includes readable text and source state on demand |
| UX-009 | Medium | Freshness can be ambiguous | Add per-provider last successful sync and stale/partial/error states in header and details | `updated`, `errorBar` | User distinguishes empty from offline and permission denied |
| UX-010 | Medium | First-open planner revision may surprise | Explain “Reviewed changes since your last plan”; expose before/after and “Review now” | `planner.js` | No silent task move; changes discoverable and reversible where applicable |
| UX-011 | High | Destructive actions require exceptionally clear outcomes | Standardize preview: affected repo/branch/files, irreversible effects, backup/restore, cancel default | `stash.js`, `mover.js` flows | Cancel causes no mutation; high-risk action is explicit |
| UX-012 | Medium | Compact table hides context in ellipses | Add accessible “Details” reveal, keyboard/touch disclosure, copy full path | `grid.js`, `DESIGN.md` | Full cell content available without mouse hover |
| UX-013 | Medium | Charts may emphasize tokens over outcomes | Add interpretation, time window, missing-data disclosure, drill-through | `charts.js` | Every metric has definition, denominator and source |
| UX-014 | Medium | Re-rendering may disrupt focus | Preserve focused item by stable key across render/refresh; announce changed counts politely | `app.js` dynamic rendering | Keyboard focus remains on logical control after refresh |
| UX-015 | Medium | Global navigation lacks unified search | Add command palette with keyboard shortcut and scoped search | Separate search inputs | Search task/branch/session across sections |
| UX-016 | Medium | Setup is file/config oriented | Add guided integration health and provider onboarding, without exposing secrets | `setupBanner`, `config.js` | Clear setup steps and permission diagnostics |
| UX-017 | Medium | Agent sessions not a first-class UI surface | Add Sessions view and task-linked session panel with capability-aware states | `sessions.js` vs nav | Unsupported live/resume states shown as unavailable |
| UX-018 | Low | “Live moves” and “Cleared” labels need explanation | Use contextual subtitles and glossary; validate alternative labels with users | `index.html:23–24` | New user can explain consequence of action |
| UX-019 | Medium | Responsive grid may force horizontal scan | On narrow screens switch key views to cards, keep controls and actions reachable | `grid.js`, `DESIGN.md` | 320px–400px flows have no inaccessible action |
| UX-020 | Medium | Empty and error states need task-oriented recovery | Standardize CTA, what happened, what is safe, what to do next | `errorBar`, `skeleton` | Offline/empty/auth/permission states distinct |
| UX-021 | Medium | User preference consistency across pages | Centralize density, theme, filters, timezone, default landing page | `grid.js`, theme control | Settings survive refresh, reset available |
| UX-022 | Medium | Provider-neutral language needed across app | Audit “ADO”, “Azure”, “Claude”, “Token usage” in copy; distinguish native vs normalized | `planner.js`, `comments.js`, drawer | No misleading vendor label for other providers |
| UX-023 | Medium | Notification overload risk | Group duplicate alerts, quiet hours, notification preferences and explanation | `comments.js` browser notifications | No repeat notification for acknowledged event |
| UX-024 | Medium | Dialog and toast interactions need robust accessibility | Audit focus trap/return, Escape, validation, live announcements, error summary | `index.html:108–126` | Automated and manual WCAG 2.2 AA checks pass |
| UX-025 | Low | Typography and contrast tokens may diverge | Use `--font-body` consistently; verify light/dark/forced-colors tokens in actual browser | `styles.css` | Contrast verified for text, controls and charts |
| UX-026 | Medium | Dense status surfaces risk cognitive overload | Default to actionable summary, expandable details, preserve user choice | Cards/tables/filters | Priority and next action readable at glance |

## 4. Proposed information architecture

### Primary navigation (goal-first)
1. **Home** — Today + Attention + recent work + integration health.
2. **Work** — Tasks, Planner, Reviews, Comments (secondary tabs; keep existing deep links).
3. **Code** — Worktrees, Stashes, Moves, Cleared, Testing, Sessions.
4. **Insights** — Journal, Workflow ratings, Agent usage.
5. **Settings** — Integrations, Preferences, Backup & data safety.

**Alternative:** keep the existing left nav initially but introduce Home, group counts by actionable work, and progressively collapse rarely used destinations. Avoid a big-bang navigation rewrite. Keep old `#plan`, `#tasks`, `#worktrees` hashes functional or redirect them.

### Home page hierarchy
- Header: “Good morning / Here’s what needs attention”; last sync, health and refresh.
- Row 1: **Needs your attention** (max 5; show why, severity, source, action; View all).
- Row 2: **Today’s plan** (top 3, progress and “Open plan”).
- Row 3: **Active work** (repo/worktree, task, latest session, checks).
- Row 4: **Recent changes** (comments, CI, PRs), collapsed by default.
- Never use green “all clear” if a provider failed to sync.

### Unified work item detail
Header: source badge + key, title, normalized state and source state, assignee, last sync, source deep link.  
Tabs/sections: **Overview** (description, next action), **Activity** (comments/asks), **Code** (repos/branches/worktrees), **Review & checks** (PRs, CI), **Agents** (sessions), **Notes** (Hub-owned).  
Sticky footer: Add note (primary), Open source, More. Support URL-deep-linked task context and back-navigation preserving filters/scroll.

### Task-centric language
Use “Needs attention”, “Waiting on review”, “Check failed”, “Not verified”, “Synced 5m ago”, “Data unavailable”, “Acknowledged in Hub”. Avoid conflating Hub actions with remote tracker writes.

## 5. Screen-by-screen redesign specifications

### A. Today / Home
- Combine attention triage and plan, not every analytics card.
- Explain ranking rules, show source evidence and time.
- Empty state: “No items need your attention based on the sources checked”; list disconnected sources separately.
- Preserve current plan close-day decisions; summarize carried/dropped work before commit.

### B. Work planner
- Show Today, Next, Waiting, Done lanes with short purpose text.
- Use drag-and-drop as enhancement; offer Move-to menu for keyboard/touch.
- Explain automatic revision as a passive check; show delta summary.
- Distinguish provider task state from personal plan state.

### C. Task board and PR reviews
- Primary filters: All / Mine / Waiting / Done; advanced filters in a disclosure.
- Active filter chips with Clear all; result count and sorting visible.
- Task card: title, provider, repo, status, one most important signal, next action.
- Review row: author, change summary, requested action, last activity, CI, source link.
- Provide explicit unsupported states for providers without review/check capabilities.

### D. Comments / Attention
- Keep “New comments”, “Waiting on others”, “All asks” as secondary views.
- In Home, surface only actionable events, not every message.
- Show why an event matters (“Mentions you”, “Answered your question”, “Nudge due”).
- Label local acknowledgement: “Mark handled in Hub”; explain it does not mark remote item read.
- Group by task/PR; preserve individual event links.

### E. Worktrees
- First line: repo, branch, linked task, working tree state, last action.
- Readiness facets: Git clean/conflict, test evidence, CI, review, unknown.
- Quick actions: Open folder, Copy path, View task, View sessions; risky actions under More.
- Clearly separate local working tree state from remote PR/CI status.
- Show missing association as “Not linked”, not a broken task ID.

### F. Stashes / Moves / Cleared
- Prioritize “What will happen?” before “Analyze/Clear/Move”.
- Preview files affected, branch/repo, whether backup exists and recovery path.
- Keep selection counts and clear selection on changed filter if hidden selections could surprise.
- Separate reversible operations from irreversible ones visually and in wording.
- Provide post-action result with link to history/backup and a meaningful recovery instruction.
- For “Cleared”, explain whether it means archived/removed and what remains on disk.

### G. Testing
- Organize by “Needs evidence”, “Differs from QA”, “Ready to port”, “In sync”.
- Define “QA”, “flow”, “evidence” and “port” inline or via help.
- Show evidence date, commit/ref and provenance; distinguish inconclusive from failed.
- Make batch operations explicit with selected count and confirmation.

### H. Usage / Workflow ratings
- Put key takeaway and methodology above chart.
- Show timeframe, data source, coverage, unknown values, and comparison caveats.
- Provide table and export; chart hover must not be sole path to values.
- Avoid using token counts as productivity scores; prefer task/verification outcomes.

### I. New: Agent sessions
- Agent name, repo/worktree, linked task, started/last seen, evidenced state, supported resume action.
- Explicit “Live state unavailable” when collector cannot tell.
- Never imply Hub controls or terminates an agent unless it actually does.
- Respect transcript privacy; metadata-only default.

### J. New: Settings / Integrations
- Provider cards: configured/not configured, permission, last sync, capability coverage, reconnect instructions.
- Setup assistant for GitHub/Azure/GitLab and agent CLI discovery.
- Show which data stays local and which API permissions are requested.
- Preferences: theme, density, notifications, default view, timezone, retention.

## 6. Interaction and accessibility requirements

| UX-A ID | Requirement | Validation |
|---|---|---|
| UX-A01 | All interactive cards support Enter **and Space**, with semantic buttons/links where possible | Keyboard test |
| UX-A02 | Dialog opens with sensible focus, traps focus, closes on Escape and restores trigger focus | Keyboard + screen reader |
| UX-A03 | Refresh/render preserves focus and scroll context | Keyboard regression |
| UX-A04 | Status and error changes announced without excessive live-region noise | NVDA/VoiceOver checks |
| UX-A05 | Hidden/ellipsized table content available via keyboard, touch and assistive tech | Touch + screen reader |
| UX-A06 | Contrast targets WCAG 2.2 AA for light/dark/forced colors | Automated + manual contrast |
| UX-A07 | Drag operations have a keyboard-equivalent Move action | Keyboard test |
| UX-A08 | Responsive behavior verified at 320, 375, 768, 1024 and 1440 CSS px | Browser viewport matrix |
| UX-A09 | No critical meaning conveyed only by color, motion, hover or icon | Heuristic + assistive-tech test |
| UX-A10 | Reduced motion covers animations, transitions and auto-updating KPIs | OS preference test |
| UX-A11 | Forms show labels, required fields, validation summary and persistent errors | Form test |
| UX-A12 | Time and date formatting reflect configured locale/timezone and expose exact timestamps | Locale test |
| UX-A13 | Async requests expose loading, partial, stale, empty, permission denied and error separately | Fault injection |
| UX-A14 | High-risk operations show preview and safe default Cancel; recovery instructions after success | Destructive-flow UAT |
| UX-A15 | Focus indicator and touch targets meet accessible sizing goals; verify compact controls | Browser inspection |

### Important audit boundary
The source shows deliberate accessibility design; **it does not prove** WCAG compliance. Test DOM behavior, CSS computed contrast, screen-reader output, keyboard flows and responsive overflow in a running app. Do not classify source-only suspicions as confirmed defects.

## 7. UX user stories and acceptance criteria

**UX-US01 (P0, UX-001/004):** As an engineer opening Hub, I want to see actionable work first so I know what to do next.  
Given active alerts and plan items, when Home loads, then the top attention items have reason, source, timestamp and action; if provider data is stale, it is visibly marked stale.

**UX-US02 (P0, UX-002/003):** As a multi-provider engineer, I want one task detail surface with correctly labeled sources.  
Given an Azure work item linked to a GitHub PR, when task details open, then both appear with provider labels and distinct links, and no GitHub item displays “Open in Azure DevOps”.

**UX-US03 (P0, UX-011):** As a cautious engineer, I want to understand consequences before a destructive stash or move action.  
Given selected work, when I choose an action, then I see affected files/paths, recoverability and explicit confirmation; Cancel changes nothing.

**UX-US04 (P1, UX-007):** As an engineer filtering tasks, I want to know which filters are active.  
When I apply filters, then chips, count and Clear all appear; switching views preserves or explicitly resets the filter.

**UX-US05 (P1, UX-012/014):** As a keyboard-only user, I want full data and stable focus.  
When I expand truncated details and refresh a list, then the full value remains accessible and focus returns to the equivalent item.

**UX-US06 (P1, UX-005):** As an engineer preparing a handoff, I want to see fresh verification evidence.  
Given a passing CI check on an older commit, when I inspect the current worktree, then status is stale/unknown rather than Ready.

**UX-US07 (P1, UX-017):** As a coding-agent user, I want to locate and resume sessions when supported.  
Given a collector without resume capability, when I view the session, then Hub explains the limitation and offers no fake action.

**UX-US08 (P1, UX-016):** As a new user, I want to connect a provider without guessing configuration keys.  
Given no configured provider, when I open Integrations, then I see setup steps, required permissions and a local-data explanation.

## 8. Recommended wireframe descriptions

### Desktop Home
```text
┌─ Hub ───────────────────────────┬─ Home ────────── Sync 5m ago · Refresh ───┐
│ Home                            │ What needs your attention?               │
│ Work                            │ [Failed check] [Review request] [Nudge]  │
│   Tasks · Planner · Reviews     │                                          │
│ Code                            │ Today's plan          Active work         │
│   Worktrees · Sessions · ...    │ 3 priorities          Repo / Task / Agent  │
│ Insights                        │                                          │
│ Settings                        │ Recent changes (collapsed)               │
└─────────────────────────────────┴──────────────────────────────────────────┘
```
### Mobile Home
```text
Hub     Home                     [Refresh]
[Needs attention: 3] [Today's plan: 4]
Attention item: reason · source · action
Attention item: reason · source · action
Today (3 items)   [View plan]
Active work       [View worktrees]
[Home] [Work] [Code] [More]
```
These are **conceptual text wireframes**, not implemented designs. Validate density and labels with users.

## 9. Phased UX delivery plan

| Phase | Scope | Effort* | Exit criteria |
|---|---|---|---|
| UX-M0 — Baseline | Browser walkthrough, screen captures, 5 task observations, accessibility scan, interaction inventory | S–M | Verified issue list and task completion baselines |
| UX-M1 — Trust and navigation | Focus/keyboard fixes, safer confirmation copy, freshness, provider-neutral labels, Home MVP | M–L | Core workflows navigable without ambiguity |
| UX-M2 — Task continuity | Unified task detail, contextual links, filter chips, attention dedupe, mobile cards | L | Task resumption needs fewer cross-view jumps |
| UX-M3 — New capabilities | Agent sessions, readiness, integrations, journal UI | L | Mixed-provider/multi-agent UAT passes |
| UX-M4 — Optimize | Search palette, customization, analytics explanation, usability iteration | M | Measured usability goals reached |

*Relative estimates only; no test execution or design prototype validation performed.

### Recommended implementation mapping
- `ui/index.html`: Home destination, IA, provider-neutral drawer link, semantic landmarks.
- `ui/app.js`: task detail routing, focus persistence, filter chips, unified loading/empty/error, contextual source links.
- `ui/planner.js`: revision explanation, keyboard move alternative, plan/task-state separation.
- `ui/comments.js`: attention feed integration, local acknowledgement copy, notification preferences.
- `ui/stash.js`: consequence preview, selection transparency, restore guidance.
- `ui/testing.js`: evidence taxonomy, commit freshness, terminology help.
- `ui/grid.js`: non-hover disclosures, responsive cards and focus tests.
- `ui/charts.js`: methodology and coverage, persistent table access.
- `ui/styles.css`: consistent tokens, touch/focus/contrast/responsive refinements.
- `ui/motion.js`: animation/announcement validation and reduced-motion coverage.
- `ui/DESIGN.md`: add IA, copy glossary, component contracts and accessibility patterns.

## 10. UX measurement plan

**Do not claim improvement without baseline measurement.** Suggested metrics:
- **Time to first actionable decision:** from Home open to first chosen action.
- **Task resumption time:** from selecting task to opening correct worktree/context.
- **Cross-view navigation count:** page changes per task-resumption journey.
- **Alert precision:** % surfaced attention items user marks useful.
- **Recovery clarity:** % users correctly predict effects of stash/move action.
- **Accessibility task success:** keyboard/screen-reader completion of 5 critical tasks.
- **Setup success:** % users connecting first provider without external assistance.
- **Trust:** % users correctly identify local vs remote actions and stale evidence.

Suggested initial usability protocol: 5–8 engineers, tasks J-01 through J-06 from `04-user-journeys.md`, moderated think-aloud, record errors and time, then retest after UX-M2. No participant study has yet been performed.

## 11. Traceability to product requirements

| UX cluster | Product requirement references |
|---|---|
| Home / Attention | FR-007–010, FR-027 |
| Provider-neutral task detail | FR-001–006, FR-015, FR-028, FR-030 |
| Agent sessions | FR-011–013 |
| Worktree readiness | FR-014, FR-019, NFR-020 |
| Journal / analytics | FR-016, FR-021, FR-029 |
| Search / setup | FR-017–018 |
| Safety, accessibility, privacy | FR-026, NFR-001–007, NFR-011–013 |

## 12. Product owner decisions requested
1. Should Home/Attention replace Worktrees as the default landing page?
2. Should primary navigation favor Work / Code / Insights, or user journeys (Today / Tasks / Active Work / Review)?
3. Which five actions are used most frequently today?
4. Is the desktop app the primary target, or should mobile be fully featured?
5. Which operations must be read-only, and which can be locally mutating with confirmation?
6. Should agent sessions and CI readiness appear in task details before getting standalone pages?
7. Are keyboard-only and screen-reader flows release-blocking?
8. What level of personalization is desired without creating configuration complexity?

## 13. UX release acceptance checklist
- [ ] Owner approves proposed IA and critical user journeys.
- [ ] Browser audit verifies or dismisses source-only risks.
- [ ] 5–8 usability sessions and baseline metrics collected.
- [ ] All existing deep links and task/planner/stash flows preserved.
- [ ] Provider labels are correct in mixed-provider scenarios.
- [ ] Keyboard, touch, reduced motion, dark/light and screen reader paths tested.
- [ ] Dangerous operations show preview, cancel and recovery guidance.
- [ ] Stale/offline/partial/empty states are distinct.
- [ ] No unsupported agent or CI status is fabricated.
- [ ] UX tests trace to FR/NFR requirements and are attached to implementation PRs.

# Engineering Hub

A local app that shows every git worktree, stash and task across your clones: one page for what is half-done, where, and what to do about it. It listens on `127.0.0.1` only. It never pushes, never posts to Azure DevOps and never changes a work item. No dependencies: Node.js, Git, and a browser.

What it gives you:
- **Worktrees**: every worktree across all your clones with its real git state; clear one with a reason, or move its work to the live repo in one confirmed step.
- **Stashes**: every git stash in every clone, analysed (already in main? conflicts? old?), with recoverable clear and re-work in a fresh worktree.
- **Work planner**: put the work assigned to you (and the items of the modules you cover) on future days, revise them every day against the latest fetch, and delegate with Monitor or Fire and forget. Each day's lines are the lines of Today's plan.
- **Testing**: your flow specs with their evidence and where each stands in the QA automation repository; prepares flow cards, QA-style specs, inventory rows and Test Plans drafts for QA to review.
- **Task board**: your Azure DevOps work items and pull requests joined with the local code state, plus your own notes per task (optional: needs Azure DevOps).
- **Today's plan**: write your day in plain words, get a checklist tied to work items (uses a signed-in Claude CLI; falls back to matching without AI).
- **Workflow ratings**, **Token usage**, sessions per task, a command-line tool and Claude Code hooks that share task notes between sessions.

## Quick start (another person, another machine)
Tested on Windows. The git, SQLite and web parts are plain Node and should work elsewhere, but that is not tested.

1. Install **Node.js 24 or newer** (the hub uses its built-in SQLite) and **Git**. For the board also install the **Azure CLI** and run `az login`. For the morning plan with AI, install and sign in to **Claude Code** (without it the plan still works, matched by rules).
2. Get the hub folder (clone or copy it anywhere).
3. Create your settings file. Point it at the folder(s) that contain your git repositories:
   ```
   node bin/setup.js --scan "C:\work\repos" --org https://dev.azure.com/<your-org> --project "<your project>" --prefix dev --name "Your name"
   ```
   Leave out `--org` and `--project` to run without Azure DevOps (everything except the task board and work item matching still works). `--prefix` is the start of your task branch names: `<prefix>/<work item id>-<short name>`.
4. Check the machine (read-only): `node bin/setup.js --check`
5. Start it: `node server.js`, then open http://localhost:4700

Your settings live in `hub.config.json` next to `server.js`. It is git-ignored, so your own values never leave your machine. Your data (notes, plans, history) lives in `data/` (also git-ignored) and daily verified backups go outside the hub folder (see Data safety).

## Configuration
`hub.config.json` (created by `bin/setup.js`, or copy `hub.config.example.json`). Every setting is optional; relative paths are relative to the settings file. Environment variables `HUB_CONFIG` (another settings file), `HUB_DATA_DIR`, `HUB_BACKUP_DIR` and `HUB_PORT` override it.

| Setting | Meaning |
|---|---|
| `title`, `brand`, `userName` | Page title, sidebar name, your name in hook messages |
| `organization`, `project` | Azure DevOps (`https://dev.azure.com/<org>` and the project name). Leave out to run without the board |
| `branchPrefix` | Task branches are `<prefix>/<id>-...` (also `<prefix>/<type>_<id>_...`). Worktrees, sessions and stashes are linked to tasks through it |
| `scanFolders` | Folders whose git repositories are found automatically (3 levels deep; worktrees are never mistaken for clones) |
| `clones` | Explicit list: `{ "key", "path", "layer", "azdoRepo" }` |
| `repoMapFile` | An existing repo map (`repos` with `clones`), for teams that already keep one |
| `workspaceRoot`, `worktreeRoot` | Token usage only counts sessions under the workspace; new re-work worktrees go beside the repo's other worktrees, else under `worktreeRoot` |
| `dataDir`, `backupDir`, `port` | Where data and backups live; the port (default 4700) |
| `coWorkerNames` | Names offered for re-work worktree folders (`<name>-<id>`) |
| `azureDevOps.enabled` | `false` switches the board off even when an organization is set |
| `testing` | Testing phase: `specsDir`, `evidenceDir`, `qa.path` and QA's folder layout and port rules (see Testing and QA packs) |
| `planner` | Work planner (and `planner.ai` for AI planning, see below): `dayCapacity` (a day with more open lines is flagged, default 5), `workingDays` (0 = Sunday ... 6, default Monday to Friday), `horizonDays` (working days shown, 5), `monitorEveryDays` (2), `wakeAfterWorkingDays` (10), `searchTypes` (work item types a keyword search may return; empty = all) |
| `botPullRequests` | `repos` and `titlePatterns` (regular expressions) of automated pull requests: shown as "Automated", left out of "waiting for you" |
| `usage.file`, `usage.hubBuildPrompt` | A usage log for the Token usage page (default `~/.claude/usage-dashboard/usage.jsonl`); optional first-prompt phrase marking the session that built the hub |
| `sessions.projectsDir` | Where Claude Code keeps session files (default `~/.claude/projects`) |
| `learningsDir`, `scorecard.*` | Optional inputs for Workflow ratings: a folder of lesson files, extra guard and settings files, folders of your flow tests and their evidence. Anything not set scores "no data", never a false zero |

Workflow ratings use `scorecard.config.json` (generic) unless you copy it to `scorecard.config.local.json` (git-ignored, takes precedence) or name another file in `scorecard.configFile`.

`node bin/setup.js --check` lists what is missing; the page shows a "Setup needed" banner for the same problems.

## Safety
The worktree list is read-only (`git status`, `log`, `rev-list`, `merge-base`, `worktree list`). The actions that change a repo are **Move to live…** and the stash manager's **Clear / Restore / Re-work**, each only after you confirm in a dialog. Move to live shows exactly what will happen:

1. Fetch `origin/main`.
2. Save the worktree's uncommitted changes as a patch (kept in `data/moves/<id>/`).
3. Stash the live repo's own changes (`stash push -u`). Recorded under **Stashes** (badge "Made by Move to live") until you mark it handled. Move to live itself never applies or drops a stash; clearing one is a separate, deliberate action in the stash manager.
4. Remove the worktree (links such as `node_modules` junctions are unlinked first, never followed).
5. Check out the branch in the live repo.
6. Merge `origin/main`. On conflict the merge is aborted cleanly and flagged; your changes still land on the branch.
7. Apply the patch, unstaged.

It refuses a live checkout, a detached or locked worktree, a live repo mid-merge/rebase, and a second move at the same time. If a step fails, the page tells you what is safe (patch path, stash hash) and nothing is rolled back destructively. **Clear…** on a worktree only hides it in the hub, with a reason; nothing on disk changes.

## Task board
Cards for your Azure DevOps work items and PRs joined with local git state (`collectors/tasks.js`, read-only, token from the signed-in Azure CLI, kept in memory). Click a card to open the detail panel:
- description, acceptance criteria and repro steps from Azure DevOps (HTML rebuilt from an allow-list; images are replaced by a note);
- code state, worktrees and PRs;
- **Open in Azure Boards**: the discussion and comments are deliberately not copied here (Plan with AI reads them for its analysis only, see Work planner);
- **Your notes and analysis**: sections Analysis, Findings, Decisions, Open questions, Next step. Stored in `data/hub.db` (`notes` table), editable, deletes are soft. Notes are never sent to Azure DevOps. A task with notes stays on the board. Type a task ID in the search box and press Enter to open any task;
- **Claude sessions on this task** (see below).

The board shows **open** items only (New and Active). Completed items (Resolved, Closed, Done) are fetched on demand from the **Completed** switch, for the last 7, 30, 90, 180 or 365 days (up to 300 most recently changed). An item with notes or an open PR stays visible whatever its state.

If it says Azure DevOps is unavailable and asks for a sign-in: open a terminal, run `az login`, finish the browser sign-in, then press **Refresh**.

## Stash manager
Sidebar **Stashes**: every git stash in every clone, one row each with its message, the branch it was made on, age, files and line counts. Rows analyse themselves page by page (or press **Analyse the N shown**); results are cached by stash id. `collectors/stashinfo.js` is read-only git (`stash list`, `diff`, `ls-tree`, `merge-tree`, `merge-base`, `show`) and gives each stash a verdict with its reason in words, with no AI:
- **Safe to clear**: empty, or every file is identical to `origin/main` already.
- **Likely obsolete**: its branch is merged into main and the stash is over 7 days old or most files already match main, or its task is Closed, Done or Resolved. A recent stash on a merged branch is only "Worth reviewing" (it is probably live work).
- **Needs rework**: applying it to current main would conflict (files named).
- **Old, review**: over 60 days and not matched above. **Worth reviewing**: the rest.

Filters: repository, verdict, age, text; sort; select several. **Diff** shows complete totals counted by git (never cut), a list of files with their own +/− counts, one file's change on request, and **Download the full patch**.

Actions (`stashmgr.js`, the only code besides `mover.js` that changes a repo; it never pushes or commits and never touches a live working tree):
- **Clear…** (one or many, a reason is required): a patch is saved to `data/stash-archive/<repo>/<id>.patch`, a hidden git ref `refs/hub-trash/<id>` keeps the commits alive, then that exact stash is dropped (found again by its id right before, because indexes shift after every drop). It appears under the **Trash** tab. A stash made by Move to live is marked handled with your reason.
- **Restore** (Trash tab): puts it back on the stash list with the same id.
- **Delete for good** (Trash tab, type `delete`): removes the hidden ref and the patch; the history row stays.
- **Re-work…**: creates a worktree on the commit the stash was made from (`git worktree add --no-track -b <prefix>/<id>-rework-<short> <name>-<id>`, beside the repo's other worktrees) and applies the stash there, so it cannot conflict. The stash stays on the list; you merge or rebase onto main yourself.

Refused while a Move to live runs, while another stash action runs on the same repo, or while the repo is mid-merge, rebase, cherry-pick or revert. Every action is recorded under **History** (table `stash_actions`, included in backups).

## Sessions on a task
The task drawer lists the Claude sessions that worked on the task (`sessions.js`, read-only). A session is linked when its transcript records the git branch `<prefix>/<id>-…`. Each row shows when, prompts, estimated cost, the folder, the first prompt as a label and a copyable `claude --resume <id>` command (run it from the folder shown). Only branch name, folder and timestamps are read from a transcript; conversation text is never stored or shown. `hub context <id>` includes a one-line summary. Sessions that never ran on a task branch are not linked.

## Shared context for Claude sessions (command-line tool and hooks)
Sessions read and write the same per-task notes you see on the Task board.
- **Tool** (`bin/hub.js`, or `bin/hub.cmd`): `hub context <id>` (state, worktrees across repos, plan lines, notes), `hub note <id> "<text>" --section Findings [--author "session abc"]` (`-` reads stdin), `hub plan`, `hub status`. It talks to the running hub; if the hub is down a note is saved to `data/inbox/` and added when the hub starts. It never opens the database.
- **Hooks** (`hooks/session-start.js`, `hooks/stop-reminder.js`): when a session starts in a folder on a task branch (`<prefix>/<id>-…`) or a worktree folder named `<name>-<id>`, the start hook prints that task's context into the session. The stop hook asks, once per session and only after 10 minutes on a task with no note written, for a note before stopping. Both are silent when there is no task or the hub is down, never loop, and always let the session end.
- **Install** (never done for you): `node bin/setup.js --check` prints the JSON with your real hub path. Merge it into your Claude Code `settings.json` next to any hooks you already have.

The Workflow ratings page shows whether the hooks are installed.

## Workflow ratings
Rates areas of your workflow from measured data (`scorecard.js`, thresholds and weights in `scorecard.config.json`): a baseline window vs the last 14 days and six weekly points, with each gap linked to the hub features meant to close it and how much they are used. Sources: your pull requests, builds, review threads and bug history in Azure DevOps (read-only), local git commit messages (read-only), the usage log, a learnings folder if you set one, and this hub. No model is used. It recalculates on demand and once a week. Set `original` on an area to your own earlier rating to see measured vs judged side by side. Small samples: treat movement as a hint. **Planner accuracy** (matches accepted unchanged, by confidence, AI vs rules, drafts edited, worktree suggestions kept) is recorded for free every time you save a plan.

## Charts

Two charts, drawn in the browser from data the hub already has (no AI, no extra requests): **Weekly rating by area** at the top of Workflow ratings (one small line chart per area, baseline as a grey line, weeks without data left blank), and **Stashes by age and verdict** at the top of Stashes (stacked bars; click a part or a legend item to filter the list). Each has a Table view, hover and keyboard readouts (arrow keys), and light and dark colours. Code: `ui/charts.js`.

## Comments (unread comments and who you are waiting on)

Azure DevOps has no "unread" flag per person, so the hub keeps its own. Every few minutes in working hours (`commentWatch` in the settings) it reads the comment count of the work items you follow in one batch call, and only for items whose count rose it reads that one item's newest comments (a plain GET). New comments by other people become **unread**; one that mentions you, or answers something you wrote, is marked **for you**. The first check only records what is already there, so nothing floods.

- **Followed items**: assigned to you, on the board, planned, delegated, in Later, with notes, with an open ask, or any item you press "Watch this item" on.
- **Where it shows**: an "N new" badge on task cards, Today's plan and planner lines; the **Comments** page and its sidebar number; the browser tab title; optional browser notifications while the hub tab is open (a switch on the page, off by default).
- **Read**: opening an item in the drawer and closing it marks its comments read, or press Mark read / Mark all read. This is the hub's own marker: reading on Azure Boards cannot be seen.
- **Asks**: "I asked someone" records who and what, with a nudge date (working days, default 2). A later comment by that person marks the ask **replied**; no answer by the nudge date marks it **nudge due**. If your own last comment ends with a question or mentions someone and nobody answered, the hub offers to track it (one click).
- **Waiting lane**: a planned line with an open ask has a **Park** button. It leaves the day and the Inbox and sits in "Waiting on others" in the planner; a reply or a due nudge brings it back as an alert with Plan today.
- **Planner alerts** are grouped: one row per work item with each reason under it, and the sidebar number counts items, not reasons.
- **Safe**: Azure DevOps is only read (the comment GET and the existing batch search). No model is used, so no tokens. Nothing is posted anywhere; asks, read markers and badges live in the hub database (tables `comment_watch`, `comment_events`, `asks`).
- **Not included**: summaries of long threads by a model, email, Teams or desktop notifications, and noticing what you read on Azure Boards.

## Work planner
Sidebar **Work planner**: a board of day columns (**Inbox**, **Today**, the next five working days, **Later**) with a **Delegated** area below. Everything here is recorded in the hub only: nothing is ever written to Azure DevOps, so reassigning or closing the work item there is still done by you in Azure Boards (the hub links to it).
- **Inbox**: open work items assigned to you that are not planned, delegated or parked, P1 first. **Topics you cover**: saved keywords (a module or feature name); open items whose title or tags contain one, assigned to anyone or nobody, are listed with their owner. The **Search** box finds items by keyword without saving anything; **Add as topic** keeps it.
- **Plan and move**: drag a card to a day (or **Plan on... / Move to...**, which works by keyboard and offers any date up to 60 days ahead), reorder inside a day, **Sort** a day by priority, **Bring unfinished to today** for lines left on earlier days, park in **Later**. A work item has one open slot. A day above its capacity is flagged.
- **Today's plan**: a work item planned for a day is a normal plan line on that day. On the day it appears in Today's plan (tick it, edit it, close the day, score). Moving it to another day takes it out of that day.
- **Revise** (button; it also runs once when you first open the page each day) refetches your items and compares them with what you accepted. It never moves anything; it flags new Inbox items, **priority, state, title or assignee changes**, items **Done in Azure DevOps**, and items **assigned to someone else** (offer: record as a delegation). **Accept** clears a change.
- **Delegate...**: who has it, and the kind. **Monitor** (you keep watching): next check date (every N working days), optional expected-by date. It needs you when a check is due, the state or owner changed, nothing has happened for twice the check interval, the item finished (ready to close), it came back to you, or the expected date passed. **Checked...** sets the next check; **Add check-in to today** puts a line in Today's plan. **Fire and forget**: leaves your daily views and wakes only if it is still unfinished after N working days (default 10). You can switch kind, **Take back** (to the Inbox or a day) or **Close** (done, cancelled, other) at any time; every step is logged under **History**. Delegating drops the item's planned lines (reason "Delegated to X") so the day score is not penalised.
- The board itself uses no AI and no model tokens (**Plan with AI** below is separate and optional). Azure DevOps access is read-only: a batch read by id, and keyword searches that are SELECT queries only (quote-safe, 200 results at most, cached for 5 minutes, finished states left out).

### Plan with AI (optional)
**Plan with AI...** reads the **description and discussion** of your unplanned items (Inbox, plus topic items if you choose) and proposes where each belongs. It only proposes: you review, change anything, then press **Apply**; nothing is planned before that. Only unplanned items are considered; your existing schedule is never touched.
- **What it reads (no AI, read-only):** each item's fields, description, acceptance criteria, repro steps, and its newest comments (8 by default, each cut to 400 characters; about 3,500 characters per item at most). Markup is removed and **email addresses are masked**.
- **Step 1, a cheap model reads** the items in batches of six and returns, per item: a summary, kind, size (xs to xl), urgency, blockers, who it is waiting on, whether information is missing (and the question to ask), whether the discussion says it is already fixed, a delegation hint, a short quote as evidence, and a confidence. Results are cached per item until it changes (changed date, comment count or text), so tomorrow only changed items cost anything.
- **Step 2, a stronger model arranges** the days given the free room per day, priorities and urgency.
- **Checked in code before you see it:** only items and days that were offered are accepted; each item appears once; a day never gets more than its free room (overflow moves to the nearest day with room, else Later); items the discussion says are fixed, or that lack information, are never put on a day; a delegation is only kept when the analysis gave a reason. A bad answer is retried once; if it still fails the plan falls back to **priority only** (P1 first, no AI) and says so.
- **Groups in the proposal:** each day, **Needs information** (with the question), **Waiting on someone**, **Looks fixed already**, **Consider delegating** (you name the person and the kind), **Later**. Change any item's destination or untick it.
- **Cost and privacy:** the dialog shows what will be sent and an estimate before anything is sent; the first time you also confirm that item and discussion text goes to Claude using your own login. The model gets no tools, no MCP servers and no session, and its environment has no Azure credentials. Item text is passed as quoted data and escaped, so a comment that says "ignore your instructions" cannot change anything: only validated placements can be applied, and only by you. Every call is recorded on the Token usage page. **Plan by priority only** uses no model at all. Settings: `planner.ai` (`enabled`, `maxItems`, `includeDiscussion`, `commentsPerItem`, `analyseModel`, `arrangeModel`, `maxBudgetUsd`).
- **What the hub keeps:** short analyses (summary, size, blockers) for 60 days as a cache, and for each run what you did with each proposal (accepted, changed, rejected). The discussion text itself is not stored.

## Today's plan
The landing page. Type your plan in plain words; the assistant (headless Claude Code with your own login, `ai.js`) splits it into lines, matches each to a work item (`planner.js`), and drafts a title and description for task lines that have none. You review and edit everything before pressing Save. Then you tick lines off or press Mark done, edit or add lines (`#5945` links a work item), copy drafts as one message for your lead, record "requested" and "lead created #ID" (which attaches the reference), and close the day: unfinished lines are carried to tomorrow or dropped with a reason, and the day gets a score (`plan-score.js`: 60% adherence, 30% work item coverage, 10% no carry-over) plus a list of work you did that was not in the plan. **Worktree links:** every task line is linked to the worktrees where its work lives. A task can span several repos, so a line links to a list. Worktrees whose branch carries the task ID are linked automatically, in every repo, including live checkouts; the assistant may suggest more for lines with no work item; and **Choose worktree(s)…** opens a searchable multi-select grouped by repo. For lines with no work item, the drafting step receives each linked worktree's repo, branch, recent commit subjects and changed file names (never file contents; read-only git in `collectors/wtcontext.js`), and **Improve draft with this code** rewrites a draft after you link worktrees. Links are checked against the real worktree list every time the page loads. **Match without AI** matches by work item numbers and keywords with no model call. Cost: two small calls per plan (a cheap model to match, a stronger one only to draft), recorded on the Token usage page.

## Testing and QA packs (optional)
Sidebar **Testing** (set `testing` in hub.config.json; the specs and evidence folders can also come from `scorecard.flowTests`, or the older name `scorecard.localPlatform`). It reads your flow specs (Playwright, TypeScript) without running them and shows, per flow: its title, the requirement ids it covers (`covers(...)`), its steps (`test.step` titles), the **evidence** of a run if one exists, and where it stands in your QA repository (`testing.qa.path`). The folders are called whatever you like in the page and in the generated files: `testing.names.source` (default "Source specs") and `testing.names.qa` (default "QA repository").
- **In QA, up to date**: the QA copy equals the source spec after the rewrite rules below.
- **In QA, differs**: with a diff, and a hint on who changed last (the source after the port, or the QA copy by hand).
- **Not in QA, can be ported** / **Cannot port yet**, with the reason: it needs a helper the QA library copy lacks (named), reads internal graph helpers, or is a UI flow (QA keeps its own page objects; it gets a flow card instead).
- A **Helper library** table compares the source helper files with the QA copy. It only reports; it never changes the QA library.
**Evidence** comes from summary files your own evidence runs write (before FAIL, after PASS, verdict, run folder; `testing.evidenceDir`). The hub does not run anything: set `testing.evidenceCommand` (with `<spec>` where the file name goes) and the page shows that command to copy. Local paths from a summary are never copied anywhere.

**Build QA pack...** (select flows) prepares, per flow, in a **new worktree and branch** of the QA repository (the live clone is never touched), after a preview of every file and diff:
1. **Flow card** `<cardsDir>/<name>.md`: purpose, requirements covered, preconditions, numbered steps with the expected result of each, known gaps (skip reasons, product issues), evidence, and where the flow lives. Built from the spec without AI.
2. **Ported spec** `<specsDir>/<name>.spec.ts`: the rewrite (library imports pointing into the QA copy, a tag list and a serial setting after the imports, `covers(TAGS, ...)`; tags are taken from the existing QA file, else `testing.qa.defaultTags`). Offered only when everything the spec imports exists in the QA library. A QA copy that differs is left alone unless you choose to replace it (shown as a diff first).
3. **Inventory rows** in your test case inventory (`testing.qa.inventoryFile`): a group (`inventoryHeading`) and its summary line (`inventorySummary`), line endings kept.
4. **Test plan draft** `<cardsDir>/<name>.testcase.md`: title, steps and expected results as plain text to paste into an Azure Test Plans test case. The hub never writes to Azure DevOps.
Nothing is committed and nothing is pushed: the files wait uncommitted in the worktree for you to review. A scan keeps anything shaped like a secret out of a pack, and `.env`, saved logins, traces and reports are never read. Settings: `testing.qa` (`path`, `specsDir`, `libDir`, `cardsDir`, `inventoryFile`, `inventoryHeading`, `inventorySummary`, `defaultTags`, `importFrom`, `importTo`, `serialTimeoutMs`). All defaults are neutral (`tests/flows`, `tests/lib`, `docs/flow-cards`, `docs/test-inventory.md`); set them to match your repository's layout.

## Azure DevOps is read-only (enforced)
The hub, and the AI planner in particular, cannot create, update, comment on or delete anything in Azure DevOps.
- `collectors/ado.js` is the only code that talks to Azure DevOps. `checkRequest()` runs before every call and refuses everything except GET and two POST searches that only read work items (WIQL query, batch get). PATCH, PUT, DELETE, comments, PR threads, votes and work item creation are refused. The caller cannot choose the method.
- The model is started with no tools (`--tools ""`), no MCP servers (`--strict-mcp-config`), no slash commands, no session saved, a spend cap, and a process environment stripped of every `AZURE_*`, `ADO_*`, `AZDO*`, `SYSTEM_*` variable. It never sees a token.
- Work item text goes to the model as quoted data, every id it returns is checked against the list it was given, and nothing is saved until you press Save.
- Drafts are plain text for you to send to your leads. "Lead created #ID" only records the ID you paste, locally.
- A test (`node test/guards.test.js`) fails if any write call ever appears in the hub source.

## Data safety (SQLite, `data/hub.db`)
SQLite is the right store for a one-person local tool. It is configured for safety:
- **WAL mode, 5 s busy timeout, integrity check at every start.** Several processes can read while one writes; a second writer waits instead of failing. Every read-then-write transaction starts `BEGIN IMMEDIATE` (a plain `BEGIN` can be refused instantly under WAL: a test reproduces that bug).
- **Numbered migrations** (`PRAGMA user_version`, in `store.js`). Each runs once in a transaction. Before an existing database changes shape, a copy is kept in the backup folder (`...-pre-migration.db`). Never edit an old migration: add a new one.
- **A damaged database is never replaced by an empty one.** The hub stops with instructions and leaves the file untouched.
- **Backups** (`backup.js`): a verified snapshot every day (taken within 20 hours of the last), in `backupDir` (default `~/EngineeringHub-Backups`; keep it off any shared folder, notes can be sensitive). Kept: every snapshot of 14 days, the newest of each of 8 weeks, pre-migration and manual copies for 90 days; the newest is never deleted. A weekly plain-text `export-YYYY-Www.json` (notes, plans, moves, stashes, clearances) is kept too. The sidebar shows "Backed up 2 h ago"; click it for details and **Back up now**.
- **Restore** (stop the hub first): `node bin/restore.js --list`, `--latest`, or a file name. It refuses while the hub runs, refuses a corrupt backup, and keeps the database you had in `data/before-restore-<time>/`.
- **Only the hub writes to the database.** The command-line tool and session hooks use the local API; if the hub is down they drop a small JSON file in `data/inbox/` (write `name.tmp`, rename to `name.json`; fields `id`, `type: "note"`, `taskId`, `section`, `body`, `author`). The hub applies each message once (by `id`), then moves it to `inbox/done/` or `inbox/rejected/` with a reason.
- **Move to a hosted database only if** other people need the same data, you need it from another machine, or it grows past a few hundred MB; only `store.js` touches the database, so that change stays contained.

## Token usage
The **Token usage** page reads the usage log named in `usage.file` (written by a usage-tracker hook; no model tokens to collect; without it the page says so). It shows per model and per turn what a chosen session cost, plus all sessions under `workspaceRoot` by day and by session. The hub itself calls no model for this; the page checks its source for any model API reference. Costs are list-price estimates.

## Tests
`npm test` (or `node test/run-all.js`) runs every suite on throwaway folders, repositories and databases with a neutral settings file (`test/fixtures`); nothing touches your real data, settings or backups. Checks that need a real Azure DevOps board are marked "live" and skipped by default; `HUB_LIVE_TESTS=1 npm test` runs them against your own organization and project (they read work items of the author's board, so expect to adjust them).

## Files
| File | Purpose |
|---|---|
| `config.js` | The only reader of `hub.config.json` and the environment |
| `server.js` | HTTP server (127.0.0.1 only), API and the UI |
| `store.js` | SQLite: notes, plans, clearances, moves, stashes, stash history, ratings snapshots |
| `mover.js` | Move to live: plan (dry run), the seven steps, stash tracking |
| `stashmgr.js`, `collectors/stashinfo.js` | Stash manager: actions (clear, restore, delete, re-work) and read-only analysis |
| `sessions.js` | Claude sessions linked to a task by branch name (read-only) |
| `collectors/git.js` | git helpers (`git` read-only, `gitx` keeps exit code and stderr) |
| `collectors/worktrees.js` | Worktrees across all clones: branch, task ID, dirty files, ahead/behind, merged to main, idle days |
| `collectors/ado.js`, `collectors/tasks.js` | Read-only Azure DevOps client and the task board model |
| `planboard.js`, `lib/workdays.js`, `ui/planner.js` | Work planner: board, revision rules, delegations, working-day arithmetic, the page |
| `testing.js`, `lib/specparse.js`, `ui/testing.js` | Testing: spec catalogue, evidence, QA status, flow cards, QA-style port, inventory rows, Test Plans drafts, the QA pack builder |
| `commentwatch.js`, `ui/comments.js` | Comments: unread comments, mentions, asks and nudges (read-only, no model) |
| `planai.js`, `lib/text.js` | Plan with AI: gathering, analysis, arrangement, validation, apply; text cleaning and email masking |
| `planner.js`, `ai.js`, `plan-score.js` | Morning plan: matching, drafting, the headless model runner, day score |
| `scorecard.js`, `scorecard.config.json` | Workflow ratings |
| `backup.js`, `backup-files.js`, `bin/restore.js`, `inbox.js` | Backups, restore and the note inbox |
| `bin/setup.js`, `bin/hub.js`, `hooks/` | Setup and checks, the command-line tool, the Claude Code hooks |
| `ui/` | The web UI (plain HTML, CSS, JavaScript) |

"Merged" and "ahead/behind" use the last fetched `origin`, so run `git fetch` in a clone to refresh them.

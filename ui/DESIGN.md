# Hub design notes

A warm, calm, friendly tool for people who use it all day. Plain CSS, no build step. Colours and sizes are tokens at the top of `styles.css` (light and dark); new rules go at the end of the file in a labelled section.

## Principles
1. **Warm, not sterile.** Cream paper, warm ink, never pure white or black.
2. **One voice.** Plain, kind, specific. Say what happened, what is safe, what to do next. No blame; no alarm for what is not an error.
3. **Colour has a job.** Accent for the main action, status colours only for status, red only for real errors or risk of losing data. Late is amber ("slipped past its date").
4. **Calm hierarchy.** Group with space and soft surfaces, not a border on everything.
5. **Reassure.** Say what is saved, what is read-only, what the hub never does.
6. **Delight in small places.** Greeting, sprout in empty states, a soft spring on hover and a count-up on the summary cards. All off with reduced motion.
7. **Accessible by default.** Text 4.5:1, UI 3:1 (checked by a script on the tokens), visible focus, keyboard first, works with forced colours.

## Grids (every `table.grid`)
`ui/grid.js` reads the table the page drew and applies these rules; nothing in a page has to repeat them. A table can state its columns itself with `data-cols="select,main,state,..."` and its drop order with `data-drop="date,short,note"`.

| type | for | width | align | long text |
|---|---|---|---|---|
| `select` | checkbox | 44 px | centre | none |
| `id` | task, PR | 92 px | left | none |
| `main` | name, title, flow | 34 % (min 220) | left | one line, ellipsis, full text on hover |
| `state` | status, verdict | 232 px | left | badges stay on one line; the rest become "+N" |
| `num` | counts, tokens, cost | 92 px | right, tabular | none |
| `short` | "13 files", "clean" | 128 px | left | ellipsis |
| `sync` | ahead and behind | 164 px | left | ellipsis |
| `date` | when | 124 px | left, muted | none |
| `text` | repo, author | 12 % (min 120) | left | ellipsis |
| `note` | reason, last commit | 22 % (min 160) | left | two lines, then ellipsis |
| `actions` | buttons | as wide as its buttons (104 to 280 px) | right | buttons never wrap |

* **A cell has at most two lines**: a strong first line and an optional muted second line. Paths and hashes go into the hover text or the details drawer. Badges live only in `state` cells.
* **Rows have one height** (56 px comfortable, 40 px compact; the switch is at the top of every page and remembered). Compact hides the second line.
* **No inner scroll box.** The page scrolls; the header sticks to the top of the window and the pager to the bottom of the card.
* **Not enough room?** The least important columns step aside, in this order: `note`, `date`, `text`, `sync`, `short`, `num`. `id`, `main`, `state` and `actions` stay. Only on phone widths does the table scroll sideways, with the action column pinned.
* **Keyboard:** Up and Down move between rows, Enter does the row's main action.

## Cards
A card label wraps to two lines and then stops. Cards in a row share a height. Summary cards keep a clear corner for the decoration, so a label never runs under it.

## Controls
Two sizes only. **Standard 40 px**, 14.5 px text (buttons, inputs, dropdowns, filter groups). **Compact 32 px**, 13.5 px text (`.btn.sm`, pager controls, selects inside a table footer, the small round buttons). Link buttons are 14 px with a 28 px tap area. Every dropdown is the same control: pill or 12 px corners as its neighbours, a caret that follows the theme, no native arrow. Focus is a 3 px accent ring. Do not set a height or font size on a single control; use `.sm` or the container.

## Responsive rules
Components respond to the width of the **page area they sit in** (`@container view (max-width: ...)`, every `.view` is a container), not to the window, so they behave the same beside the sidebar and on a phone. Only the app shell (sidebar becomes a top row) uses the window width. Planner alerts become one column at 720 px, cards at 560 px, the toolbar's search and dropdowns take a full row at 640 px.

## Sidebar, states, drawer, plan rows (phase 12)
* **Sidebar** has three groups: Work (plan, planner, task board, comments), Code (worktrees, stashes, live moves, cleared, testing), Insights (token usage, ratings). On a narrow window the labels hide and the groups flow as one row.
* **Loading** is always `skeleton(kind, n)` (cards, rows, list, tiles, chart) with the real heights, so nothing jumps when data arrives. **Errors** are always `errorBar({kind, title, detail, auth, retry})`: one calm bar with a Retry that calls the page's loader. Azure DevOps errors always say the notes, plans and worktrees are safe.
* **Drawer:** header (type, number, title, state, priority, assignee), scrolling sections with a heading each, and a sticky action bar (Add a note, I asked someone, Watch). **Dialogs** have a fixed header and footer with the body scrolling in between; close the day uses a Carry on / Drop / Leave choice per line and a live summary.
* **Today's plan rows** show the text, then type, number and state. "Details" opens the rest (where, notes, code). Main action is Mark done; every other action is under "More". Up and Down move between rows, Enter opens the work item.

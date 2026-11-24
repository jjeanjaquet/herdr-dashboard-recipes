# Stand-up

A daily stand-up board for an Azure DevOps team, in one window: what was completed, what is in progress, what failed QA, which PRs are waiting for review, which builds broke and what went to production. It reads Azure DevOps through the `az` CLI and never writes anything.

## What you see

Top to bottom, in a 1180 x 780 window:

1. **Header (46 px):** title "Stand-up", the current person and window ("Whole team · since yesterday"), an "updated Nm ago" label, a ↻ button (forces a full refresh) and a × button.
2. **Filters (two rows):**
   - *Window* chips: Since last stand-up, 1 day, 3 days, 7 days. "Since last stand-up" looks back to Friday on Monday and Sunday, and to yesterday on other days. Right-aligned toggles: **Count partial builds** and **Main branches only**.
   - *Who* chips: Whole team, then one chip per person in `TEAM`. Clicking a person again clears the filter.
3. **Six tiles:** Completed, New work, PRs to review (red if any is older than 2 days), Impediments, Build errors (with pass rate), Prod deploys.
4. **Two columns of sections**, each showing 8 rows with a "Show all N" link:
   - Left: **Completed** (with a Created/Closed column chart), **New work**, **Impediments**, **Work in progress by person** (bar chart).
   - Right: **In progress**, **Failed QA**, **PRs waiting for review**, **Build errors** (bar chart by pipeline), **Promoted to production** (column chart).
5. Rows are one line each: a colored dot, `#id title`, a tag (type, state or repo), and "person · age". Clicking a row opens it in the browser.

Charts that show days use two calendar weeks, last week then this week, each Su Mo Tu We Th Fr Sa. Days after today are empty.

## How it behaves

- **Completed:** State is `Closed` and the *Closed Date* falls inside the window.
- **New work:** created inside the window, by or assigned to a team member.
- **Impediments:** State `Blocked` or `Failed QA`, or tagged `blocked` or `impediment`, not closed, changed in the last 90 days.
- **In progress:** State `Active` or `Code Review`, excluding Epics and Features.
- **Failed QA:** State `Failed QA`.
- **PRs waiting for review:** active, non-draft PRs written by a team member, or waiting on a team member's vote. Red dot when older than 2 days.
- **Build errors:** completed builds with result `failed` (plus `partiallySucceeded` if "Count partial builds" is on), requested by a team member.
- **Prod deploys:** deployments to any environment whose name contains "prod", last 14 days.
- Everything respects the **Who** filter, except the "In progress" and "Failed QA" lists show current state, not the window.
- **Refresh cadence:** pull requests, builds, deployments and impediments every 5 minutes; closed, created and active work items every 15 minutes. Builds are fetched incrementally (only what finished since the newest known build). A failing source backs off (x2 per failure, up to 30 minutes). A load stuck for more than 2 minutes frees the queue and retries.
- Only 3 `az` processes run at once. `az` starts slowly and more than that starve each other.

## Built from

- One mod folder with `main.js` (a `View` class using `gpui-kit` and `gpui-base`) and `mod.json`:
  `{ "place": "none", "title": "Stand-up", "overlay": { "width": 1180, "height": 780 } }`.
  `place: none` means nothing docks it. Open it as a window from a button in another mod with `openOverlay({ mod: "azdo-standup", kind: "window", key: "azdo-standup", width: 1180, height: 780 })`.
- Calls the `az` CLI (`az.cmd` on Windows) with `exec` from the app's module. It runs: `az boards query` (WIQL), `az repos pr list`, and `az devops invoke` for builds, environments and environment deployment records. It reaches only your Azure DevOps organization. It reads files outside its folder: no. It writes: no.
- Work-item queries are WIQL with `@Today - N` date filters, so the date window is applied on the server.
- Charts are plain `div`s (no chart library).

## Set it up

1. Install the Azure CLI and the DevOps extension: `az extension add --name azure-devops`, then `az login`.
2. Copy this folder to `mods/azdo-standup/` in the app's config folder.
3. Edit the top of `main.js`: set `ORG`, `PROJECT` and `TEAM`. `TEAM` must be display names exactly as Azure DevOps shows them.
4. Check your process states. The queries assume the states `Active`, `Code Review`, `Pending QA`, `Passed QA`, `Failed QA`, `Blocked` and `Closed`, and the `Microsoft.VSTS.Common.ClosedDate` field. Edit the `WIQL` block if your process differs.
5. Open the window from a button, a key binding or the command `mod.open`.

## Watch out

- The `az` login must be valid. If it has expired, every section shows the error text.
- Names are matched by display name, case-insensitively. A misspelled or differently formatted name is silently left out.
- `MAIN_BRANCH` (main, master, develop, release/*) decides what "Main branches only" means. Change it for your branching model.
- "Prod deploys" matches environment names containing "prod" (`/prod/i`). If yours are named differently, change that filter.
- The work-item lists only include items changed in the last 90 days (`STALE_DAYS`).
- Builds are capped at 1000 on first load.

## Done when

- Opening the window shows all sections, none stuck on "loading…" for more than a minute.
- Clicking a Who chip changes the tiles and lists, and clicking it again restores the team.
- A work item you closed today appears under Completed; an item set to `Failed QA` appears under Failed QA.
- A row opens the matching work item, PR or build in the browser.
- The ↻ button refreshes every section.

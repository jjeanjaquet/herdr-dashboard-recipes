# Prod readiness

A release-readiness board for one Azure DevOps pipeline. It lists every commit merged to `main` since the last production deployment, the work items behind each commit (colored by QA status), how far each commit has travelled through the pipeline's stages, and whether it is in QA and ready for production. It answers "what would go out if we released now, and what is holding it back?" It is read-only.

## What you see

A 1360 x 820 window, top to bottom:

1. **Header (46 px):** title "Prod readiness", `main · <pipeline name>`, a status or "updated Nm ago" label, a ↻ button and a × button.
2. **Summary panel:**
   - A line naming the baseline: "Since the last prod deployment: build 20260101.3 from releases/some-branch (Web + DB)". If no production deployment can be found it says so.
   - Filter chips: **All N**, **In QA N**, **Ready N**, **Not ready N**, then **Include Tasks & Bugs**, **All areas N**, **Focus N**, **Non-Focus N** (the focus area is configurable), and **Newest first / Oldest first**.
   - Three boxes side by side, 150 px tall and scrollable: **In QA now**, **Ready for prod**, **Not ready**. Each lists work items as `#id title state` (the "Not ready" box shows the reason instead of the state) and has a **Copy** button that puts the full list on the clipboard as plain text, one line per item with its link. A box shows at most 40 items; Copy always exports all of them.
3. **Commit table**, 30 commits at a time with a "Show 30 more" button. Each commit is a card with:
   - a green (ready) or orange (not ready) bar, the short sha, the PR title and an author and age label;
   - tags: **In QA** (blue), the focus-area label (purple, when a linked item is in the focus area), and **Ready for prod** (green) or the reason it is not ready (orange outline);
   - one line per linked work item;
   - on the right, a strip of pipeline-stage icons (grouped Build, QA, Prod) with the build number under it. The column headers above show stage abbreviations.

Stage icons: check (succeeded, yellow if with issues), cross (failed), clock (running or pending), dash (skipped or not run).

## How it behaves

- **Baseline (what is already in production):** the dashboard reads the deployment history of the production environment, takes the newest successful production deployment from any branch, then reads that build's commit history. A commit on `main` counts as already released if its sha, or its "Merged PR n" number, appears in that history. If the environment or its builds can't be read, it falls back to the newest `main` build whose production stage succeeded.
- **In QA:** a commit is in QA when its pipeline run, or any newer run, has a succeeded QA deploy stage. A deployment carries every commit up to its own.
- **Ready for prod:** in QA, and every linked work item is `Passed QA` or `Closed`. Otherwise the reason is one of: *Not built yet*, *Not in QA yet*, *QA deploy failed*, or *N items not Passed QA*.
- **Work items:** found from the pull request linked in the commit title ("Merged PR 123: …"). If that gives nothing, the numbers after a ticket prefix in the title (configurable, e.g. `PROJ-123, 124`) are used. Each item appears once in the three boxes, however many commits carry it.
- **Include Tasks & Bugs:** off by default, which hides Task and Bug work items from the boxes. Features and stories stay.
- **Area filter:** All, Focus (work items under the configured area path or its children) or Non-Focus. It applies to the three boxes. The Focus tag on commit cards doesn't depend on the filter.
- **Refresh:** every 3 minutes and on ↻. The pipeline timelines, work items and PRs are read with up to 8–10 parallel REST calls.
- Commit lists are capped (400 commits read from `main`, 500 from the production build) to stay fast.

## Built from

- One mod folder: `main.js` (a `View` class using `gpui-kit` and `gpui-base`), `mod.json` and four 24 x 24 SVG icons in `icons/` (`ok`, `fail`, `wait`, `skip`). `mod.json`:
  `{ "place": "none", "title": "Prod readiness", "overlay": { "width": 1360, "height": 820 } }`.
  `place: none` means nothing docks it. Open it as a window from a button in another mod with `openOverlay({ mod: "azdo-release", kind: "window", key: "azdo-release", width: 1360, height: 820 })`.
- The icons are loaded by the path `mods/azdo-release/icons/<name>.svg`, so **keep the folder name `azdo-release`**, or change that path in `stageIcon`.
- Data comes from the Azure DevOps REST API 7.1 over `fetch`: builds, build timelines, git commits, pull request work items, work items (title, state, type, area path), environments and environment deployment records.
- **Authentication:** it runs `az account get-access-token --resource <Azure DevOps application id>` through the app's `exec`, and keeps the token in memory only for 30 minutes (one retry on a 401). The token is never written to disk. The resource id in the file is Microsoft's public id for Azure DevOps. It reads, never writes.
- Network access: only to your Azure DevOps organization. It runs the `az` CLI, and opens links in the browser.

## Set it up

1. Install the Azure CLI and sign in (`az login`) with an account that can read the project's pipelines, repos and work items.
2. Copy this folder to `mods/azdo-release/` in the app's config folder.
3. Edit the top of `main.js`:
   - `ORG` and `PROJECT`;
   - `PIPELINE_ID` (the number after `definitionId=` in the pipeline's URL), `PIPELINE_NAME`, `REPO_NAME` (used for pull request links);
   - `PROD_ENV`: the name of the Azure DevOps environment whose deployment history says what is in production;
   - `FOCUS_AREA`, `AREA_LABEL`: the optional area path to tag and filter on. Use any area path; to disable it, point it at a path nothing uses;
   - `TITLE_ITEM_RE`: your ticket-prefix convention, or leave it (it only matters when a commit has no linked PR).
4. Check the conventions it assumes about your pipeline (see below).
5. Open the window from a button, a key binding or `mod.open`.

## Watch out

- **Stage naming is assumed.** `PROD = /^deploy_prod_/` and `QA = /^deploy_qa_/` match stage identifiers, and `SHORT` and `GROUP` turn stage ids into the short column labels (Web, Wkr, DB, Post, Chk). If your stages are named differently, edit those three lines or the columns will be grouped as "Build" and the QA and production logic won't see your deploys.
- **Work item states are assumed:** `Passed QA`, `Failed QA`, `Pending QA` and `Closed` (`OK_STATES` and `stateColor`). Adjust for your process.
- It reads one branch, `refs/heads/main` (`BRANCH`). Releases built from other branches count through the environment history.
- The "Merged PR n" match assumes your merges write that text into the commit message (Azure DevOps's default for squash and merge-commit completions). A change cherry-picked without it still shows as pending.
- If the production environment name is wrong or can't be read, the dashboard silently falls back to the older `main`-only logic, which can show many more commits than expected. Check `PROD_ENV` first if the commit count looks large.
- A deleted production build is skipped; the next most recent one is used.
- The `az` login must be valid. If the token can't be fetched, the window shows the error.

## Done when

- The window opens and the header names a build and branch for "the last prod deployment" (or says none was found).
- The commit count, and the In QA, Ready and Not ready counts, match what you expect from your pipeline.
- Opening a commit's PR title opens the pull request; clicking a work item opens it.
- Copy on each of the three boxes puts a readable list on the clipboard and the button shows "Copied ✓".
- The Focus chips and the Include Tasks & Bugs chip change the three boxes.
- A commit whose QA deploy succeeded shows "In QA", and one with all items Passed QA shows "Ready for prod".

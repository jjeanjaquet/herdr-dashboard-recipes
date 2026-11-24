# dashboard-recipes

Small dashboards for engineering teams, each in its own folder with a `RECIPE.md` that describes what it does, how it is built and how to set it up.

| Folder | What it is |
|---|---|
| [`azdo-standup`](azdo-standup/RECIPE.md) | Azure DevOps stand-up board: completed work, in progress, failed QA, PRs waiting for review, build errors and production deploys. Read-only, uses the `az` CLI. |

Each dashboard has placeholders at the top of its `main.js` (organization, project, people). Fill those in before use.

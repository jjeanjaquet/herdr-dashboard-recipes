// Prod readiness for the main branch: every commit merged since the last production deployment,
// its work items (coloured by QA status), its pipeline stages as Azure DevOps draws them, and
// whether it is in QA and ready for prod. Read-only. Uses a short-lived Azure DevOps token from
// `az account get-access-token`, kept in memory only.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, window, props as blockProps, closeOverlay } from "herdr";

const ORG = "https://dev.azure.com/YOUR-ORG"; // <- your Azure DevOps organization URL
const PROJECT = "YOUR-PROJECT"; // <- your Azure DevOps project
const API = `${ORG}/${PROJECT}/_apis`;
const WEB = `${ORG}/${PROJECT}`;
const PIPELINE_ID = 0; // <- numeric id of your CI/CD pipeline (the definitionId=N in its Azure DevOps URL)
const PIPELINE_NAME = "your-pipeline"; // shown in the header only
const REPO_NAME = "your-repo"; // the repository name, used for pull request links
const TITLE_ITEM_RE = /PROJ-([\d,\s]+)/; // fallback when a commit has no linked PR: work item numbers in the title, e.g. "PROJ-123, 124"
const BRANCH = "refs/heads/main";
const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"; // Microsoft's public application id for Azure DevOps (the same for every organization; not a secret)
const PROD = /^deploy_prod_/, QA = /^deploy_qa_/;
const PROD_ENV = "your-prod-environment"; // <- name of your production environment; the environment whose deployment history says what is in production
// An optional "focus" area: work items under this area path get a tag and their own filter chip.
const AREA_LABEL = "Focus";
const FOCUS_AREA = String.raw`YourProject\Your Team\Focus Area`;
const inFocus = (w) => { const a = String(w?.area ?? "").toLowerCase(), p = FOCUS_AREA.toLowerCase(); return a === p || a.startsWith(p + "\\"); };
const OK_STATES = new Set(["Passed QA", "Closed"]);

const RED = "#ef5350", GREEN = "#43b581", ORANGE = "#f59e42", YELLOW = "#e8c547", BLUE = "#4da3ff", PURPLE = "#b48ead";
const stateColor = (s) => s === "Failed QA" ? RED : s === "Passed QA" ? GREEN : s === "Pending QA" ? ORANGE : YELLOW;

// `az` is az.cmd on Windows. Look the name up when it is used, not when the mod loads, and try
// both, so a window that is not ready yet at load time cannot leave us with the wrong one.
async function execAz(args) {
  const p = window()?.platform;
  const names = p === "macos" || p === "linux" ? ["az"] : ["az.cmd", "az"];
  let last;
  for (const n of names) {
    try { return await exec(n, args); }
    catch (e) { last = e; if (!/not found|cannot (run|start)/i.test(String(e))) throw e; }
  }
  throw last;
}

function openUrl(url) {
  const p = window()?.platform;
  if (p === "windows") return exec("rundll32", ["url.dll,FileProtocolHandler", url]);
  return exec(p === "macos" ? "open" : "xdg-open", [url]);
}
function ago(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// ---- Azure DevOps REST ----
let token = null, tokenAt = 0;
async function getToken(force) {
  if (token && !force && Date.now() - tokenAt < 30 * 60000) return token;
  const r = await execAz(["account", "get-access-token", "--resource", ADO_RESOURCE, "--query", "accessToken", "-o", "tsv"]);
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(String(r.stderr).trim().split("\n").pop() || "Could not get an Azure DevOps token. Run `az login`.");
  token = r.stdout.trim(); tokenAt = Date.now();
  return token;
}
async function rest(url, retry = true) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await getToken(!retry)}`, Accept: "application/json" } });
  if (res.status === 401 && retry) return rest(url, false);
  if (!res.ok) throw new Error(`Azure DevOps ${res.status} for ${url.replace(ORG, "")}`);
  return res.json();
}

// ---- data ----
// The last successful production deployment, from the environment's own history, so a release
// built from any branch counts. Null when the environment or its builds cannot be found.
async function lastProdDeploy(repo) {
  try {
    const env = (await rest(`${API}/distributedtask/environments?api-version=7.1`)).value.find((e) => e.name === PROD_ENV);
    if (!env) return null;
    const recs = (await rest(`${API}/distributedtask/environments/${env.id}/environmentdeploymentrecords?top=50&api-version=7.1`)).value
      .filter((r) => r.result === "succeeded" && PROD.test(String(r.stageName ?? "")))
      .sort((a, b) => Date.parse(b.finishTime ?? b.startTime) - Date.parse(a.finishTime ?? a.startTime));
    const tried = new Set();
    for (const r of recs) {
      const id = r.owner?.id;
      if (!id || tried.has(id)) continue;
      tried.add(id);
      let b;
      try { b = await rest(`${API}/build/builds/${id}?api-version=7.1`); } catch { continue; } // build deleted: try the one before
      if (!b?.sourceVersion) continue;
      const stages = Object.fromEntries((await rest(`${API}/build/builds/${id}/timeline?api-version=7.1`).catch(() => ({ records: [] }))).records
        .filter((x) => x.type === "Stage").map((x) => [x.identifier, { name: x.name, state: x.state, result: x.result, order: x.order }]));
      const history = (await rest(`${API}/git/repositories/${repo}/commits?searchCriteria.itemVersion.version=${b.sourceVersion}&searchCriteria.itemVersion.versionType=commit&searchCriteria.$top=500&api-version=7.1`)).value;
      return { num: b.buildNumber, sha: b.sourceVersion, branch: String(b.sourceBranch ?? "").replace(/^refs\/heads\//, ""), stages, history };
    }
  } catch { /* fall back to the builds on main */ }
  return null;
}
async function loadAll(progress) {
  progress("Reading builds…");
  const builds = (await rest(`${API}/build/builds?definitions=${PIPELINE_ID}&branchName=${BRANCH}&$top=100&queryOrder=queueTimeDescending&api-version=7.1`)).value;
  if (!builds.length) throw new Error("No builds of the pipeline on main");
  const repo = builds[0].repository.id;

  progress("Reading commits on main…");
  const commits = (await rest(`${API}/git/repositories/${repo}/commits?searchCriteria.itemVersion.version=main&searchCriteria.$top=400&api-version=7.1`)).value
    .map((c, idx) => ({ sha: c.commitId, idx, message: String(c.comment ?? "").split("\n")[0], author: c.author?.name ?? "", when: Date.parse(c.committer?.date ?? c.author?.date) }));
  const idxOf = new Map(commits.map((c) => [c.sha, c.idx]));

  progress("Reading pipeline stages…");
  const timelines = await pool(builds, 10, async (b) => {
    try { return (await rest(`${API}/build/builds/${b.id}/timeline?api-version=7.1`)).records.filter((r) => r.type === "Stage"); }
    catch { return []; }
  });
  const runs = builds.map((b, i) => ({
    id: b.id, num: b.buildNumber, status: b.status, sha: b.sourceVersion, idx: idxOf.get(b.sourceVersion), queued: Date.parse(b.queueTime),
    stages: Object.fromEntries(timelines[i].map((s) => [s.identifier, { name: s.name, state: s.state, result: s.result, order: s.order }])),
  })).filter((r) => r.idx !== undefined);

  // What is in production: the last real prod deploy (any branch), or, failing that, the newest
  // build on main that reached prod. A commit is out if its sha, or its "Merged PR n", is in that history.
  progress("Reading the last production deployment…");
  const prOfMsg = (m) => /Merged PR (\d+)/.exec(m)?.[1];
  const deploy = await lastProdDeploy(repo);
  let baseline, limit, pending;
  if (deploy) {
    const inProd = new Set(deploy.history.map((h) => h.commitId));
    const prsInProd = new Set(deploy.history.map((h) => prOfMsg(String(h.comment ?? ""))).filter(Boolean));
    const cut = commits.find((c) => inProd.has(c.sha)); // newest commit on main that production already has
    limit = cut ? cut.idx : commits.length;
    pending = commits.filter((c) => c.idx < limit && !(prOfMsg(c.message) && prsInProd.has(prOfMsg(c.message))));
    baseline = { num: deploy.num, stages: deploy.stages, branch: deploy.branch };
  } else {
    const prodRuns = runs.filter((r) => Object.entries(r.stages).some(([k, s]) => PROD.test(k) && s.result === "succeeded"));
    baseline = prodRuns.sort((a, b) => a.idx - b.idx)[0] ?? null;
    limit = baseline ? baseline.idx : commits.length;
    pending = commits.filter((c) => c.idx < limit);
  }

  // Stage columns, from the run that has the most stages.
  const widest = runs.reduce((a, r) => (Object.keys(r.stages).length > Object.keys(a?.stages ?? {}).length ? r : a), null);
  const columns = Object.entries(widest?.stages ?? {}).sort((a, b) => a[1].order - b[1].order).map(([id, s]) => ({ id, name: s.name }));

  progress("Reading pull requests and work items…");
  const prOf = (c) => /Merged PR (\d+)/.exec(c.message)?.[1];
  const links = await pool(pending, 8, async (c) => {
    const pr = prOf(c);
    let ids = [];
    if (pr) { try { ids = (await rest(`${API}/git/repositories/${repo}/pullrequests/${pr}/workitems?api-version=7.1`)).value.map((w) => Number(w.id)); } catch { /* fall back to the title */ } }
    if (!ids.length) { const m = TITLE_ITEM_RE.exec(c.message); if (m) ids = m[1].split(/[,\s]+/).filter(Boolean).map(Number); }
    return ids;
  });
  const all = [...new Set(links.flat())];
  const items = {};
  for (let i = 0; i < all.length; i += 150) {
    const r = await rest(`${API}/wit/workitems?ids=${all.slice(i, i + 150).join(",")}&fields=System.Title,System.State,System.WorkItemType,System.AreaPath&api-version=7.1`);
    for (const w of r.value) items[w.id] = { id: w.id, title: w.fields["System.Title"], state: w.fields["System.State"], type: w.fields["System.WorkItemType"], area: w.fields["System.AreaPath"] ?? "" };
  }

  // A deployment carries every commit up to its own, so a commit is in QA when it or any newer
  // commit's run deployed to QA; its own run (the oldest one at or after it) is what it shows.
  const rows = pending.map((c, i) => {
    const after = runs.filter((r) => r.idx <= c.idx);
    const own = after.sort((a, b) => b.idx - a.idx)[0] ?? null;
    const qaOk = after.some((r) => Object.entries(r.stages).some(([k, s]) => QA.test(k) && s.result === "succeeded"));
    const qaFailed = after.some((r) => Object.entries(r.stages).some(([k, s]) => QA.test(k) && s.result === "failed"));
    const wis = links[i].map((id) => items[id]).filter(Boolean);
    const notOk = wis.filter((w) => !OK_STATES.has(w.state));
    let reason = "";
    if (!own) reason = "Not built yet";
    else if (!qaOk) reason = qaFailed ? "QA deploy failed" : "Not in QA yet";
    else if (notOk.length) reason = `${notOk.length} item${notOk.length > 1 ? "s" : ""} not Passed QA`;
    return { ...c, pr: prOf(c), run: own, inQA: qaOk, wis, ready: !reason, reason, noItems: wis.length === 0 };
  });

  return { builds: runs.length, baseline, columns, rows, repo, loadedAt: Date.now() };
}

const SHORT = (id, name) => /web/i.test(id) ? "Web" : /worker/i.test(id) ? "Wkr" : /_db|database/i.test(id) ? "DB" : /post/i.test(id) ? "Post" : /check/i.test(id) ? "Chk" : String(name).slice(0, 4);
const GROUP = (id) => PROD.test(id) || /post_deploy_prod/.test(id) ? "Prod" : QA.test(id) || /post_deploy_qa/.test(id) ? "QA" : "Build";

export default class Release extends View {
  init(_props, cx) {
    this.filter = "all"; this.oldestFirst = false; this.copied = null; this.limit = 30; this.area = "all"; this.tasks = false;
    this.data = null; this.err = null; this.loading = false; this.status = "";
    this.load(cx);
    cx.timer.every(180000, (cx) => this.load(cx));
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        this.data = await loadAll((s) => { this.status = s; cx.notify(); });
        this.err = null;
      } catch (e) { this.err = String(e.message ?? e); }
      finally { this.loading = false; this.status = ""; cx.notify(); }
    });
  }

  // ---- pieces ----
  chip(t, id, label, on, onClick, color) {
    return div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(12).text_size(11.5)
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : color ?? t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  tag(t, text, color, solid) {
    return div().flex_none().px(7).h(18).flex().items_center().rounded(9).text_size(10.5).font_semibold()
      .bg(solid ? color : t.raised).text_color(solid ? "#0b1220" : color).child(text);
  }

  stageIcon(t, s) {
    let icon = "skip", color = t.dim;
    if (s?.state === "completed") {
      if (s.result === "succeeded") { icon = "ok"; color = GREEN; }
      else if (s.result === "succeededWithIssues") { icon = "ok"; color = YELLOW; }
      else if (s.result === "failed") { icon = "fail"; color = RED; }
    } else if (s) { icon = "wait"; color = BLUE; } // inProgress or pending
    return svg(`mods/azdo-release/icons/${icon}.svg`).size(17).text_color(color);
  }

  strip(t, columns, run) {
    const cells = [];
    let last = null;
    for (const c of columns) {
      const g = GROUP(c.id);
      if (last && g !== last) cells.push(div().w(8).flex_none());
      last = g;
      cells.push(div().w(30).flex_none().flex().justify_center().child(run ? this.stageIcon(t, run.stages[c.id]) : div().size(17)));
    }
    return h_flex().gap(0).items_center().children(cells);
  }

  header(t, columns) {
    const out = [];
    let last = null;
    for (const c of columns) {
      const g = GROUP(c.id);
      if (last && g !== last) out.push(div().w(8).flex_none());
      last = g;
      out.push(v_flex().w(30).flex_none().items_center().child(div().text_size(9).text_color(t.dim).child(SHORT(c.id, c.name))));
    }
    const groups = [];
    let cur = null;
    for (const c of columns) {
      const g = GROUP(c.id);
      if (cur?.g === g) cur.n++; else { cur = { g, n: 1 }; groups.push(cur); }
    }
    return v_flex().gap(1)
      .child(h_flex().children(groups.flatMap((g, i) => [i ? div().w(8).flex_none() : null,
        div().w(g.n * 30).flex_none().flex().justify_center().text_size(10).font_semibold().text_color(g.g === "Prod" ? ORANGE : g.g === "QA" ? BLUE : t.muted).child(g.g)].filter(Boolean))))
      .child(h_flex().items_center().children(out));
  }

  wiLine(t, key, w) {
    return h_flex().id(`wi-${key}-${w.id}`).gap(7).items_center().h(20).rounded(4).hover((s) => s.bg(t.hover))
      .on_click(() => openUrl(`${WEB}/_workitems/edit/${w.id}`))
      .child(div().size(7).rounded(4).flex_none().bg(stateColor(w.state)))
      .child(div().flex_none().text_size(11.5).text_color(BLUE).child(`#${w.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(w.title))
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(stateColor(w.state)).child(w.state));
  }

  // Plain text for the clipboard: a heading, then one line per work item.
  exportText(title, entries, withReason) {
    const lines = entries.map((e) => `#${e.w.id} ${e.w.title} (${withReason ? e.reason : e.w.state}) ${WEB}/_workitems/edit/${e.w.id}`);
    return [`${title} (${entries.length})`, ...(lines.length ? lines : ["None"])].join("\n");
  }

  glance(t, title, color, list, empty, entries, withReason) {
    const copied = this.copied === title;
    return v_flex().flex_1().min_w(0).p(10).gap(4).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(7).items_center().child(div().size(8).rounded(4).bg(color)).child(div().text_size(12.5).font_semibold().child(title))
        .child(div().text_size(12).text_color(t.muted).child(String(list.length)))
        .child(div().flex_1())
        .child(div().id(`gl-copy-${title}`).flex_none().px(7).h(20).flex().items_center().rounded(10).text_size(10.5)
          .bg(t.raised).text_color(copied ? GREEN : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { cx.write_to_clipboard(this.exportText(title, entries, withReason)); this.copied = title; cx.notify(); })
          .child(copied ? "Copied ✓" : "Copy")))
      .child(v_flex().id(`gl-${title}`).h(150).overflow_y_scrollbar().gap(1)
        .children(list.length ? list.slice(0, 40) : [div().text_size(11.5).text_color(t.dim).child(empty)])
        .when(list.length > 40, (e) => e.child(div().text_size(11).text_color(t.dim).px(4).child(`+${list.length - 40} more. Copy exports all ${list.length}.`))));
  }

  render() {
    const t = theme();
    const d = this.data;
    const top = h_flex().h(46).px(16).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().text_size(14).font_semibold().child("Prod readiness"))
      .child(div().text_size(12).text_color(t.muted).child(`main · ${PIPELINE_NAME}`))
      .child(div().flex_1())
      .child(div().text_size(11).text_color(t.dim).child(this.loading ? this.status || "refreshing…" : d ? `updated ${ago(d.loadedAt)} ago` : ""))
      .child(div().id("rl-refresh").px(6).text_size(15).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.load(cx)).child("↻"))
      .child(div().id("rl-close").px(6).text_size(16).text_color(t.muted).hover((s) => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => closeOverlay(blockProps().overlay)).child("×"));
    const shell = (body) => v_flex().size_full().bg(t.chrome).text_color(t.foreground).child(top).child(body);
    if (this.err && !d) return shell(div().p(16).text_size(12.5).text_color(RED).child(this.err));
    if (!d) return shell(div().p(16).text_size(12.5).text_color(t.muted).child(this.status || "Loading…"));

    const rows = d.rows, inQA = rows.filter((r) => r.inQA), ready = rows.filter((r) => r.ready), notReady = rows.filter((r) => !r.ready);
    const shown = rows.filter((r) => this.filter === "all" || (this.filter === "qa" ? r.inQA : this.filter === "ready" ? r.ready : !r.ready));
    const ordered = this.oldestFirst ? [...shown].reverse() : shown;

    // Work items, once each, from every commit that carries them.
    const seen = new Map();
    for (const r of rows) for (const w of r.wis) {
      const e = seen.get(w.id) ?? { w, inQA: false, ready: true, reason: "" };
      e.inQA = e.inQA || r.inQA;
      if (!r.ready) { e.ready = false; e.reason = e.reason || r.reason; }
      seen.set(w.id, e);
    }
    const allWi = [...seen.values()].filter((e) => this.tasks || !["Task", "Bug"].includes(e.w.type));
    const wiList = allWi.filter((e) => this.area === "all" || (this.area === "focus") === inFocus(e.w));
    const qaItems = wiList.filter((e) => e.inQA);
    const readyItems = wiList.filter((e) => e.ready);
    const notItems = wiList.filter((e) => !e.ready);
    const line = (e, extra) => h_flex().id(`g-${extra}-${e.w.id}`).gap(7).items_center().h(20).rounded(4).hover((s) => s.bg(t.hover))
      .on_click(() => openUrl(`${WEB}/_workitems/edit/${e.w.id}`))
      .child(div().size(7).rounded(4).flex_none().bg(stateColor(e.w.state)))
      .child(div().flex_none().text_size(11.5).text_color(BLUE).child(`#${e.w.id}`))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(e.w.title))
      .child(div().flex_none().text_size(10.5).text_color(extra === "n" ? t.dim : stateColor(e.w.state)).child(extra === "n" ? e.reason : e.w.state));

    const base = d.baseline;
    const prodStages = base ? Object.entries(base.stages).filter(([k, s]) => PROD.test(k) && s.result === "succeeded").map(([k, s]) => SHORT(k, s.name)).join(" + ") : "";

    return shell(v_flex().flex_1().min_h(0)
      .child(v_flex().flex_none().px(16).py(10).gap(8).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().text_size(12).text_color(t.muted).child(base ? `Since the last prod deployment: build ${base.num}${base.branch ? ` from ${base.branch}` : ""} (${prodStages})` : "No production deployment found in the last builds"))
          .child(div().flex_1())
          .child(this.chip(t, "f-all", `All ${rows.length}`, this.filter === "all", (_e, cx) => { this.filter = "all"; cx.notify(); }))
          .child(this.chip(t, "f-qa", `In QA ${inQA.length}`, this.filter === "qa", (_e, cx) => { this.filter = "qa"; cx.notify(); }, BLUE))
          .child(this.chip(t, "f-ready", `Ready ${ready.length}`, this.filter === "ready", (_e, cx) => { this.filter = "ready"; cx.notify(); }, GREEN))
          .child(this.chip(t, "f-not", `Not ready ${notReady.length}`, this.filter === "not", (_e, cx) => { this.filter = "not"; cx.notify(); }, ORANGE))
          .child(div().w(1).h(16).bg(t.border).flex_none())
          .child(this.chip(t, "f-tasks", this.tasks ? "Include Tasks & Bugs ✓" : "Include Tasks & Bugs", this.tasks, (_e, cx) => { this.tasks = !this.tasks; cx.notify(); }))
          .child(this.chip(t, "a-all", `All areas ${allWi.length}`, this.area === "all", (_e, cx) => { this.area = "all"; cx.notify(); }))
          .child(this.chip(t, "a-focus", `${AREA_LABEL} ${allWi.filter((e) => inFocus(e.w)).length}`, this.area === "focus", (_e, cx) => { this.area = "focus"; cx.notify(); }, PURPLE))
          .child(this.chip(t, "a-other", `Non-${AREA_LABEL} ${allWi.filter((e) => !inFocus(e.w)).length}`, this.area === "other", (_e, cx) => { this.area = "other"; cx.notify(); }))
          .child(this.chip(t, "f-sort", this.oldestFirst ? "Oldest first" : "Newest first", false, (_e, cx) => { this.oldestFirst = !this.oldestFirst; cx.notify(); })))
        .child(h_flex().gap(10)
          .child(this.glance(t, "In QA now", BLUE, qaItems.map((e) => line(e, "s")), "Nothing deployed to QA", qaItems, false))
          .child(this.glance(t, "Ready for prod", GREEN, readyItems.map((e) => line(e, "s")), "Nothing ready yet", readyItems, false))
          .child(this.glance(t, "Not ready", ORANGE, notItems.map((e) => line(e, "n")), "Everything is ready", notItems, true))))
      .child(v_flex().id("rl-table").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(8).gap(4)
        .child(h_flex().gap(10).items_end().pb(2)
          .child(div().flex_1().text_size(10.5).text_color(t.dim).child("Commit, in the order merged to main" + (this.oldestFirst ? " (oldest first)" : " (newest first)")))
          .child(this.header(t, d.columns)))
        .children(ordered.slice(0, this.limit).map((r) => this.commitRow(t, r, d.columns)))
        .when(ordered.length > this.limit, (e) => e.child(div().id("rl-more").flex_none().p(10).flex().justify_center().rounded(8).bg(t.surface).text_size(12).text_color(t.accent)
          .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.limit += 30; cx.notify(); })
          .child(`Show 30 more (${Math.min(this.limit, ordered.length)} of ${ordered.length} shown)`)))
        .when(!ordered.length, (e) => e.child(div().p(12).text_size(12).text_color(t.dim).child("No commits match this filter")))));
  }

  commitRow(t, r, columns) {
    const color = r.ready ? GREEN : ORANGE;
    return h_flex().id(`cm-${r.sha}`).flex_none().gap(10).px(10).py(8).items_start().rounded(8).bg(t.surface)
      .child(div().w(3).h(38).rounded(2).flex_none().bg(color))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().text_size(11).text_color(t.dim).child(r.sha.slice(0, 7)))
          .child(div().id(`pr-${r.sha}`).flex_1().min_w(0).truncate().text_size(12.5).font_semibold().hover((s) => s.text_color(BLUE))
            .on_click(() => r.pr && openUrl(`${WEB}/_git/${encodeURIComponent(REPO_NAME)}/pullrequest/${r.pr}`)).child(r.message.replace(/^Merged PR \d+: /, "")))
          .when(r.inQA, (e) => e.child(this.tag(t, "In QA", BLUE, true)))
          .when(r.wis.some(inFocus), (e) => e.child(this.tag(t, AREA_LABEL, PURPLE, true)))
          .child(r.ready ? this.tag(t, "Ready for prod", GREEN, true) : this.tag(t, r.reason, ORANGE, false))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`${r.author.split(" ")[0]} · ${ago(r.when)}`)))
        .child(v_flex().gap(0).children(r.wis.map((w) => this.wiLine(t, r.sha.slice(0, 7), w)))
          .when(r.noItems, (e) => e.child(div().text_size(11).text_color(t.dim).child("No linked work item")))))
      .child(v_flex().flex_none().gap(2).items_center().pt(2)
        .child(this.strip(t, columns, r.run))
        .child(div().text_size(10).text_color(t.dim).child(r.run ? `build ${r.run.num}` : "no build")));
  }
}

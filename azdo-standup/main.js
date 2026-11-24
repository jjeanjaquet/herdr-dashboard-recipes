// Stand-up dashboard for Azure DevOps: what was completed, PRs waiting for review, new work,
// impediments, build errors and production deployments, for the whole team or one person.
// Reads through the `az` CLI (azure-devops extension); writes nothing.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, window, props as blockProps, closeOverlay } from "herdr";

const ORG = "https://dev.azure.com/YOUR-ORG"; // <- your Azure DevOps organization URL
const PROJECT = "YOUR-PROJECT"; // <- your Azure DevOps project
const WEB = `${ORG}/${PROJECT}`;
const LOOKBACK = 14; // days of history the charts show
const DAY = 864e5;
const SHOW = 8; // rows per section before "Show all"
// The people this dashboard is about. Everything else on the team is left out.
const TEAM = ["Person One", "Person Two", "Person Three"]; // <- display names exactly as Azure DevOps shows them
const TEAM_KEYS = new Set(TEAM.map((n) => n.toLowerCase()));
const inTeam = (p) => Boolean(p) && TEAM_KEYS.has(p.key);
const STALE_DAYS = 90; // open work untouched for longer than this is not stand-up material
const MAIN_BRANCH = /^refs\/heads\/(main|master|develop|release\/.*)$/;

const lastLine = (s) => String(s ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
// `az` is a slow-starting Python program: more than a few at once starve each other and
// run into the host's 30 s limit per command, so calls queue for one of a few slots.
const SLOTS = 3;
let running = 0;
const waiting = [];
const slot = () => new Promise((go) => { if (running < SLOTS) { running++; go(); } else waiting.push(go); });
const release = () => { const next = waiting.shift(); if (next) next(); else running--; };

async function az(args) {
  await slot();
  let r;
  try { r = await execAz([...args, "--org", ORG, "-o", "json"]); } finally { release(); }
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || `az exited ${r.code}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}
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
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const dow = (ms) => ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][new Date(ms).getDay()];
function ago(ms) {
  if (!ms) return "";
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}
// Monday looks back to Friday, Sunday to Friday, other days to yesterday.
const autoDays = () => { const w = new Date().getDay(); return w === 1 ? 3 : w === 0 ? 2 : 1; };

const person = (id) => id && typeof id === "object"
  ? { key: String(id.displayName ?? id.uniqueName ?? "").toLowerCase(), name: id.displayName ?? id.uniqueName ?? "Unassigned", group: Boolean(id.isContainer) }
  : { key: "", name: "Unassigned" };
const first = (n) => String(n).split(" ")[0];

const F = "[System.Id],[System.Title],[System.State],[System.WorkItemType],[System.AssignedTo],[System.CreatedBy],[System.CreatedDate],[System.ChangedDate],[Microsoft.VSTS.Common.ClosedDate],[System.Tags]";
const WIQL = {
  closed: `SELECT ${F} FROM workitems WHERE [System.State] = 'Closed' AND [Microsoft.VSTS.Common.ClosedDate] >= @Today - ${LOOKBACK} ORDER BY [Microsoft.VSTS.Common.ClosedDate] DESC`,
  created: `SELECT ${F} FROM workitems WHERE [System.CreatedDate] >= @Today - ${LOOKBACK} AND [System.State] <> 'Removed' ORDER BY [System.CreatedDate] DESC`,
  blocked: `SELECT ${F} FROM workitems WHERE [System.State] NOT IN ('Closed','Removed') AND [System.ChangedDate] >= @Today - ${STALE_DAYS} AND ([System.State] IN ('Blocked','Failed QA') OR [System.Tags] CONTAINS 'blocked' OR [System.Tags] CONTAINS 'impediment') ORDER BY [System.ChangedDate] DESC`,
  active: `SELECT ${F} FROM workitems WHERE [System.State] IN ('Active','Code Review','Pending QA','Passed QA','Failed QA','Blocked') AND [System.ChangedDate] >= @Today - ${STALE_DAYS}`,
};

const toItem = (w) => {
  const f = w.fields;
  return {
    id: w.id, title: f["System.Title"], state: f["System.State"], type: f["System.WorkItemType"] ?? "",
    who: person(f["System.AssignedTo"]), by: person(f["System.CreatedBy"]),
    created: Date.parse(f["System.CreatedDate"]), changed: Date.parse(f["System.ChangedDate"]),
    closedAt: Date.parse(f["Microsoft.VSTS.Common.ClosedDate"] ?? f["System.ChangedDate"]), // when it was closed; changed date only if the field is empty
    tags: String(f["System.Tags"] ?? ""),
  };
};
const wiql = async (q) => ((await az(["boards", "query", "--wiql", q, "--project", PROJECT])) ?? []).map(toItem);

const LOADERS = {
  closed: async () => (await wiql(WIQL.closed)).filter((w) => inTeam(w.who)),
  created: async () => (await wiql(WIQL.created)).filter((w) => inTeam(w.by) || inTeam(w.who)),
  blocked: async () => (await wiql(WIQL.blocked)).filter((w) => inTeam(w.who)),
  active: async () => (await wiql(WIQL.active)).filter((w) => inTeam(w.who)),
  async prs() {
    const rows = (await az(["repos", "pr", "list", "--status", "active", "--top", "100", "--project", PROJECT])) ?? [];
    return rows.map((p) => ({
      id: p.pullRequestId, title: p.title, repo: p.repository?.name, draft: Boolean(p.isDraft),
      by: person(p.createdBy), created: Date.parse(p.creationDate),
      reviewers: (p.reviewers ?? []).map((r) => ({ ...person(r), vote: r.vote ?? 0 })),
    })).filter((p) => inTeam(p.by) || p.reviewers.some((r) => inTeam(r) && r.vote === 0));
  },
  // Incremental: the first load takes the whole 7-day window (the widest the Window chips offer),
  // after that only builds finished since the newest one we hold (30 min overlap), merged by id.
  async builds(prev = []) {
    const week = startOfDay(Date.now()) - 7 * DAY;
    const held = prev.filter((b) => b.when >= week);
    const newest = held.reduce((m, b) => Math.max(m, b.when), 0);
    const from = newest ? Math.max(week, newest - 30 * 60000) : week;
    const rows = (await az(["devops", "invoke", "--area", "build", "--resource", "builds", "--route-parameters", `project=${PROJECT}`,
      "--query-parameters", "statusFilter=completed", "queryOrder=finishTimeDescending", `minTime=${new Date(from).toISOString()}`, `$top=${newest ? 200 : 1000}`, "--api-version", "7.1"]))?.value ?? [];
    const byId = new Map(held.map((b) => [b.id, b]));
    for (const b of rows.map((r) => ({
      id: r.id, name: r.definition?.name, status: r.status, result: r.result, branch: r.sourceBranch ?? "",
      by: person(r.requestedFor), num: r.buildNumber, when: Date.parse(r.finishTime ?? r.queueTime ?? r.startTime),
    })).filter((r) => inTeam(r.by))) byId.set(b.id, b);
    return [...byId.values()];
  },
  async deploys() {
    const envs = ((await az(["devops", "invoke", "--area", "distributedtask", "--resource", "environments", "--route-parameters", `project=${PROJECT}`, "--api-version", "7.1"]))?.value ?? [])
      .filter((e) => /prod/i.test(e.name));
    const cut = startOfDay(Date.now()) - LOOKBACK * DAY;
    const per = await pool(envs, 5, async (e) => {
      const r = await az(["devops", "invoke", "--area", "distributedtask", "--resource", "environmentdeploymentrecords", "--route-parameters", `project=${PROJECT}`, `environmentId=${e.id}`,
        "--query-parameters", "top=25", "--api-version", "7.1"]).catch(() => null);
      return (r?.value ?? []).map((d) => ({
        id: d.id, env: e.name, pipeline: d.definition?.name, buildId: d.owner?.id, num: d.owner?.name, stage: d.stageName,
        result: d.result, when: Date.parse(d.finishTime ?? d.startTime ?? d.queueTime),
      })).filter((d) => d.when >= cut);
    });
    return per.flat().sort((a, b) => b.when - a.when);
  },
};
const KINDS = Object.keys(LOADERS);
// How often each source is re-read. Work-item lists are the big payloads and move slowly
// (they feed 14-day charts), so they refresh less often. A failed source backs off
// (x2 per failure, up to 30 min) instead of hammering Azure DevOps while it is throttling.
const MIN5 = 300000, MIN15 = 900000;
const EVERY = { prs: MIN5, builds: MIN5, deploys: MIN5, blocked: MIN5, closed: MIN15, created: MIN15, active: MIN15 };
const BACKOFF_MAX = 1800000;

export default class Standup extends View {
  init(_props, cx) {
    this.days = 0; // 0: since the last stand-up
    this.who = ""; // person key; "" is the whole team
    this.mainOnly = false;
    this.partial = false; // count partially succeeded builds as errors
    this.all = {};
    this.data = {}; this.err = {}; this.loading = {}; this.updated = null;
    this.due = {}; this.fails = {};
    this.refresh(cx);
    cx.timer.every(60000, (cx) => this.refresh(cx)); // only checks what is due; no network by itself
  }

  // force (the ↻ button) re-reads everything now and clears any back-off.
  refresh(cx, force = false) {
    this.began = this.began ?? {};
    for (const kind of KINDS) {
      if (this.loading[kind] && Date.now() - (this.began[kind] ?? 0) > 120000) {
        this.loading[kind] = false; running = 0; waiting.length = 0; // stuck: free the queue
      }
      if (this.loading[kind]) continue;
      if (!force && Date.now() < (this.due[kind] ?? 0)) continue;
      this.loading[kind] = true; this.began[kind] = Date.now();
      cx.spawn(async (cx) => {
        try {
          this.data[kind] = await LOADERS[kind](this.data[kind]); this.err[kind] = null; this.updated = Date.now();
          this.fails[kind] = 0; this.due[kind] = Date.now() + EVERY[kind];
        } catch (e) {
          this.err[kind] = String(e.message ?? e);
          this.fails[kind] = (this.fails[kind] ?? 0) + 1;
          this.due[kind] = Date.now() + Math.min(BACKOFF_MAX, EVERY[kind] * 2 ** this.fails[kind]);
        } finally { this.loading[kind] = false; cx.notify(); }
      });
    }
  }

  get span() { return this.days || autoDays(); }
  get since() { return startOfDay(Date.now()) - this.span * DAY; }
  mine(...people) { return !this.who || people.some((p) => p?.key === this.who); }

  // ---- derived data ----
  completed() { return (this.data.closed ?? []).filter((w) => w.state === "Closed" && w.closedAt >= this.since && this.mine(w.who)); }
  fresh() { return (this.data.created ?? []).filter((w) => w.created >= this.since && this.mine(w.by, w.who)); }
  impediments() { return (this.data.blocked ?? []).filter((w) => this.mine(w.who)); }
  reviewQueue() {
    return (this.data.prs ?? []).map((p) => ({ ...p, waiting: p.reviewers.filter((r) => r.vote === 0 && r.key !== p.by.key && (r.group || inTeam(r))) }))
      .filter((p) => !p.draft && p.waiting.length && (!this.who || p.by.key === this.who || p.waiting.some((r) => r.key === this.who)))
      .sort((a, b) => a.created - b.created);
  }
  failures() {
    return (this.data.builds ?? []).filter((b) => b.status === "completed" && (b.result === "failed" || (this.partial && b.result === "partiallySucceeded"))
      && b.when >= this.since && this.mine(b.by) && (!this.mainOnly || MAIN_BRANCH.test(b.branch))).sort((a, b) => b.when - a.when);
  }
  people() { return TEAM.map((name) => ({ key: name.toLowerCase(), name })); }

  // ---- little charts, drawn with divs ----
  bars(t, rows, max, id) {
    const top = max || Math.max(1, ...rows.map((r) => r.value));
    return v_flex().gap(5).children(rows.map((r, i) => h_flex().id(`${id}-${i}`).gap(8).items_center().h(18)
      .child(div().w(86).flex_none().truncate().text_size(11).text_color(r.hot ? t.foreground : t.muted).child(r.label))
      .child(div().flex_1().h(8).rounded(4).bg(t.raised).child(div().h(8).rounded(4).bg(r.color).w(`${Math.max(r.value ? 4 : 0, Math.round((r.value / top) * 100))}%`)))
      .child(div().w(22).flex_none().text_size(11).text_color(t.muted).child(String(r.value)))));
  }

  columns(t, days, series) {
    const max = Math.max(1, ...days.flatMap((d) => series.map((s) => s.of(d))));
    return v_flex().gap(4)
      .child(h_flex().gap(4).h(58).items_end().children(days.map((d, i) => h_flex().id(`col-${i}`).flex_1().gap(2).items_end().justify_center().h_full()
        .children(series.map((s) => div().flex_1().max_w(14).rounded_t(2).bg(s.color).h(Math.max(s.of(d) ? 3 : 1, Math.round((s.of(d) / max) * 56)))
          .when(!s.of(d), (e) => e.bg(t.border)))))))
      .child(h_flex().gap(4).children(days.map((d) => div().flex_1().text_size(9.5).text_color(d.today ? t.foreground : t.dim).flex().justify_center().child(d.label))))
      .child(h_flex().gap(12).children(series.map((s) => h_flex().gap(5).items_center().child(div().size(7).rounded(2).bg(s.color)).child(div().text_size(10.5).text_color(t.muted).child(s.name)))));
  }

  daysAxis() {
    // Two calendar weeks, last week then this one, each Su..Sa. Days after today stay empty.
    const out = [], today = startOfDay(Date.now());
    const start = new Date(today); start.setDate(start.getDate() - start.getDay() - 7); // Sunday of last week
    for (let i = 0; i < 14; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      out.push({ key: dayKey(d.getTime()), label: dow(d.getTime()), today: d.getTime() === today });
    }
    return out;
  }

  // ---- layout pieces ----
  tile(t, label, value, color, sub) {
    return v_flex().flex_1().min_w(0).p(12).gap(2).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(div().text_size(11).text_color(t.muted).child(label))
      .child(div().text_size(26).font_semibold().text_color(value ? color : t.dim).child(String(value)))
      .child(div().text_size(10.5).text_color(t.dim).truncate().child(sub ?? ""));
  }

  section(t, id, title, count, color, kind, chart, rows) {
    const err = kind && this.err[kind], loading = kind && this.loading[kind] && !this.data[kind];
    const open = this.all[id], shown = open ? rows : rows.slice(0, SHOW);
    return v_flex().flex_none().p(12).gap(10).rounded(10).bg(t.surface).border(1).border_color(t.border)
      .child(h_flex().gap(8).items_center()
        .child(div().size(8).rounded(4).bg(color))
        .child(div().text_size(13).font_semibold().child(title))
        .child(div().text_size(12).text_color(t.muted).child(loading ? "loading…" : String(count))))
      .when(Boolean(chart), (e) => e.child(chart))
      .when(Boolean(err), (e) => e.child(div().text_size(11.5).text_color(t.blocked).child(err)))
      .child(v_flex().gap(2).children(shown))
      .when(!loading && !err && rows.length === 0, (e) => e.child(div().text_size(12).text_color(t.dim).child("Nothing to report")))
      .when(rows.length > SHOW, (e) => e.child(div().id(`more-${id}`).text_size(11.5).text_color(t.accent).hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.all[id] = !open; cx.notify(); }).child(open ? "Show fewer" : `Show all ${rows.length}`)));
  }

  line(t, key, o) {
    return h_flex().id(`ln-${key}`).min_h(28).px(6).py(3).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
      .on_click(() => openUrl(o.url))
      .child(div().size(7).rounded(4).flex_none().bg(o.dot))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(o.title))
      .when(Boolean(o.tag), (e) => e.child(div().flex_none().px(6).rounded(4).bg(t.raised).text_size(10.5).text_color(o.tagColor ?? t.muted).child(o.tag)))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(o.meta));
  }

  chip(t, id, label, on, onClick) {
    return div().id(id).h(24).px(10).flex_none().flex().items_center().rounded(12).text_size(11.5)
      .bg(on ? t.selected : t.raised).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover)).on_click(onClick).child(label);
  }

  render() {
    const t = theme();
    const done = this.completed(), fresh = this.fresh(), imp = this.impediments(), queue = this.reviewQueue(), fails = this.failures();
    const days = this.daysAxis();
    const people = this.people();
    const inWindow = (d) => d.when >= this.since;
    const deploys = (this.data.deploys ?? []);
    const recentDeploys = deploys.filter(inWindow);
    const allBuilds = (this.data.builds ?? []).filter((b) => b.status === "completed" && b.result !== "canceled" && inWindow(b) && this.mine(b.by) && (!this.mainOnly || MAIN_BRANCH.test(b.branch)));
    const okBuilds = allBuilds.filter((b) => b.result === "succeeded" || (!this.partial && b.result === "partiallySucceeded")).length;
    const rate = allBuilds.length ? Math.round((okBuilds / allBuilds.length) * 100) : null;
    const loadingAny = KINDS.some((k) => this.loading[k]);

    // charts
    const closedAll = (this.data.closed ?? []).filter((w) => w.state === "Closed" && this.mine(w.who)), createdAll = (this.data.created ?? []).filter((w) => this.mine(w.by, w.who));
    const countBy = (list, f) => { const m = {}; for (const x of list) { const k = dayKey(f(x)); m[k] = (m[k] ?? 0) + 1; } return m; };
    const cm = countBy(closedAll, (w) => w.closedAt), nm = countBy(createdAll, (w) => w.created), dm = countBy(deploys.filter((d) => d.result === "succeeded"), (d) => d.when);
    const flow = this.columns(t, days, [{ name: "Created", color: t.accent, of: (d) => nm[d.key] ?? 0 }, { name: "Closed", color: t.ansi2, of: (d) => cm[d.key] ?? 0 }]);
    const deployChart = this.columns(t, days, [{ name: "Successful prod deploys", color: t.ansi2, of: (d) => dm[d.key] ?? 0 }]);

    const load = {};
    for (const w of this.data.active ?? []) { const k = w.who.name; load[k] = load[k] ?? { name: k, key: w.who.key, n: 0 }; load[k].n++; }
    const workload = this.bars(t, Object.values(load).sort((a, b) => b.n - a.n).slice(0, 8)
      .map((p) => ({ label: p.name, value: p.n, color: p.key === this.who ? t.accent : t.working, hot: p.key === this.who })), 0, "load");

    const byPipe = {};
    for (const b of allBuilds) { const p = (byPipe[b.name] = byPipe[b.name] ?? { name: b.name, ok: 0, bad: 0 }); if (b.result === "succeeded") p.ok++; else if (b.result === "failed" || (this.partial && b.result === "partiallySucceeded")) p.bad++; }
    const pipes = Object.values(byPipe).filter((p) => p.bad).sort((a, b) => b.bad - a.bad).slice(0, 6);
    const buildChart = pipes.length ? v_flex().gap(5).children(pipes.map((p, i) => h_flex().id(`bp-${i}`).gap(8).items_center().h(18)
      .child(div().w(150).flex_none().truncate().text_size(11).text_color(t.muted).child(p.name))
      .child(h_flex().flex_1().h(8).rounded(4).bg(t.ansi2)
        .child(div().h(8).rounded(4).bg(t.blocked).w(`${Math.max(4, Math.round((p.bad / (p.bad + p.ok)) * 100))}%`)))
      .child(div().w(46).flex_none().text_size(11).text_color(t.muted).child(`${p.bad}/${p.bad + p.ok}`)))) : null;

    // rows
    const stateColor = (s) => s === "Blocked" || s === "Failed QA" ? t.blocked : t.accent;
    const itemUrl = (w) => `${WEB}/_workitems/edit/${w.id}`;
    const itemRows = (list, whoOf, when) => list.map((w) => this.line(t, `w${w.id}`, {
      url: itemUrl(w), dot: this.stateOf(t, w), title: `#${w.id} ${w.title}`, tag: w.type, meta: `${first(whoOf(w).name)} · ${ago(when(w))}`,
    }));
    const doneRows = itemRows(done.sort((a, b) => b.closedAt - a.closedAt), (w) => w.who, (w) => w.closedAt);
    const newRows = itemRows(fresh, (w) => w.by, (w) => w.created);
    const impRows = imp.map((w) => this.line(t, `i${w.id}`, {
      url: itemUrl(w), dot: stateColor(w.state), title: `#${w.id} ${w.title}`, tag: w.state, tagColor: stateColor(w.state),
      meta: `${first(w.who.name)} · ${ago(w.changed)}`,
    }));
    const mineActive = (this.data.active ?? []).filter((w) => this.mine(w.who)).sort((a, b) => b.changed - a.changed);
    const inProg = mineActive.filter((w) => (w.state === "Active" || w.state === "Code Review") && w.type !== "Epic" && w.type !== "Feature");
    const failedQa = mineActive.filter((w) => w.state === "Failed QA");
    const stateRows = (list, prefix, dot) => list.map((w) => this.line(t, `${prefix}${w.id}`, {
      url: itemUrl(w), dot, title: `#${w.id} ${w.title}`, tag: w.state, tagColor: dot, meta: `${first(w.who.name)} · ${ago(w.changed)}`,
    }));
    const progRows = stateRows(inProg, "ip", t.working);
    const fqaRows = stateRows(failedQa, "fq", t.blocked);
    const prRows = queue.map((p) => this.line(t, `p${p.id}`, {
      url: `${WEB}/_git/${encodeURIComponent(p.repo)}/pullrequest/${p.id}`, dot: Date.now() - p.created > 2 * DAY ? t.blocked : t.accent,
      title: `!${p.id} ${p.title}`, tag: p.repo, meta: `${first(p.by.name)} → ${p.waiting.slice(0, 2).map((r) => first(r.name)).join(", ")}${p.waiting.length > 2 ? ` +${p.waiting.length - 2}` : ""} · ${ago(p.created)}`,
    }));
    const failRows = fails.map((b) => this.line(t, `b${b.id}`, {
      url: `${WEB}/_build/results?buildId=${b.id}`, dot: b.result === "failed" ? t.blocked : t.ansi3, title: `${b.name} ${b.num}`,
      tag: b.branch.replace(/^refs\/(heads\/)?/, ""), tagColor: MAIN_BRANCH.test(b.branch) ? t.blocked : t.muted, meta: `${first(b.by.name)} · ${ago(b.when)}`,
    }));
    const depRows = recentDeploys.map((d) => this.line(t, `d${d.id}`, {
      url: `${WEB}/_build/results?buildId=${d.buildId}`, dot: d.result === "succeeded" ? t.ansi2 : d.result === "failed" ? t.blocked : t.dim,
      title: `${d.env}`, tag: d.result === "succeeded" ? d.pipeline : `${d.result} · ${d.pipeline}`, tagColor: d.result === "succeeded" ? t.muted : t.blocked, meta: `${d.num ?? ""} · ${ago(d.when)}`,
    }));
    const failedDeploys = recentDeploys.filter((d) => d.result === "failed").length;

    const sinceLabel = this.days ? `last ${this.days} day${this.days > 1 ? "s" : ""}` : `since ${autoDays() === 1 ? "yesterday" : "Friday"}`;
    const who = this.who ? people.find((p) => p.key === this.who)?.name ?? "" : "Whole team";

    return v_flex().size_full().bg(t.chrome).text_color(t.foreground)
      .child(h_flex().h(46).px(16).gap(10).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().text_size(14).font_semibold().child("Stand-up"))
        .child(div().text_size(12).text_color(t.muted).child(`${who} · ${sinceLabel}`))
        .child(div().flex_1())
        .child(div().text_size(11).text_color(t.dim).child(loadingAny ? "refreshing…" : this.updated ? `updated ${ago(this.updated)} ago` : ""))
        .child(div().id("su-refresh").px(6).text_size(15).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => this.refresh(cx, true)).child("↻"))
        .child(div().id("su-close").px(6).text_size(16).text_color(t.muted).hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => closeOverlay(blockProps().overlay)).child("×")))
      // filters
      .child(v_flex().flex_none().px(16).py(8).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(div().w(52).text_size(11).text_color(t.dim).child("Window"))
          .children([[0, "Since last stand-up"], [1, "1 day"], [3, "3 days"], [7, "7 days"]].map(([d, label]) =>
            this.chip(t, `win-${d}`, label, this.days === d, (_e, cx) => { this.days = d; cx.notify(); })))
          .child(div().flex_1())
          .child(this.chip(t, "su-partial", "Count partial builds", this.partial, (_e, cx) => { this.partial = !this.partial; cx.notify(); }))
          .child(this.chip(t, "su-main", "Main branches only", this.mainOnly, (_e, cx) => { this.mainOnly = !this.mainOnly; cx.notify(); })))
        .child(h_flex().gap(6).items_center()
          .child(div().w(52).text_size(11).text_color(t.dim).child("Who"))
          .child(h_flex().id("su-people").flex_1().min_w(0).gap(6).overflow_x_scrollbar()
            .child(this.chip(t, "who-all", "Whole team", !this.who, (_e, cx) => { this.who = ""; cx.notify(); }))
            .children(people.map((p) => this.chip(t, `who-${p.key}`, p.name, this.who === p.key, (_e, cx) => { this.who = this.who === p.key ? "" : p.key; cx.notify(); }))))))
      // body
      .child(v_flex().id("su-body").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(12)
        .child(h_flex().gap(10)
          .child(this.tile(t, "Completed", done.length, t.ansi2, sinceLabel))
          .child(this.tile(t, "New work", fresh.length, t.accent, sinceLabel))
          .child(this.tile(t, "PRs to review", queue.length, queue.some((p) => Date.now() - p.created > 2 * DAY) ? t.blocked : t.accent, `${queue.filter((p) => Date.now() - p.created > 2 * DAY).length} older than 2 days`))
          .child(this.tile(t, "Impediments", imp.length, t.blocked, "blocked or failed QA"))
          .child(this.tile(t, "Build errors", fails.length, t.blocked, rate === null ? "no builds" : `${rate}% of ${allBuilds.length} passed`))
          .child(this.tile(t, "Prod deploys", recentDeploys.length - failedDeploys, t.ansi2, failedDeploys ? `${failedDeploys} failed` : sinceLabel)))
        .child(h_flex().gap(12).items_start()
          .child(v_flex().flex_1().min_w(0).gap(12)
            .child(this.section(t, "done", "Completed", done.length, t.ansi2, "closed", flow, doneRows))
            .child(this.section(t, "new", "New work", fresh.length, t.accent, "created", null, newRows))
            .child(this.section(t, "imp", "Impediments", imp.length, t.blocked, "blocked", null, impRows))
            .child(this.section(t, "load", "Work in progress by person", (this.data.active ?? []).length, t.working, "active", workload, [])))
          .child(v_flex().flex_1().min_w(0).gap(12)
            .child(this.section(t, "prog", "In progress", inProg.length, t.working, "active", null, progRows))
            .child(this.section(t, "fqa", "Failed QA", failedQa.length, t.blocked, "active", null, fqaRows))
            .child(this.section(t, "prs", "PRs waiting for review", queue.length, t.accent, "prs", null, prRows))
            .child(this.section(t, "fails", "Build errors", fails.length, t.blocked, "builds", buildChart, failRows))
            .child(this.section(t, "deploys", "Promoted to production", recentDeploys.length, t.ansi2, "deploys", deployChart, depRows)))));
  }

  stateOf(t, w) {
    return w.state === "Closed" ? t.ansi2 : w.state === "Blocked" || w.state === "Failed QA" ? t.blocked : t.accent;
  }
}

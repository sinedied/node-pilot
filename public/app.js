// Cockpit.js UI controller. Talks to the per-instance loopback server over a
// small JSON API and an SSE event stream, and keeps the DOM in sync with the
// shared controller state.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape sequences to strip them
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => (s || "").replace(ANSI, "");

const state = {
  detection: null,
  lanes: {},
  test: { report: null },
  dev: { status: "stopped", url: null, output: "" },
  deps: { outdated: null, audit: null, update: null },
  settings: { theme: "auto", pinnedTasks: [] },
  stats: null,
};

// Human-readable byte size (base-1000, matching npm/registry conventions).
function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1000) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = n / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

let activeConsoleLane = null;
const CONSOLE_LANES = new Set(["build", "lint", "format", "typecheck"]);
const isConsoleLane = (id) => CONSOLE_LANES.has(id) || id.startsWith("script:");

// ---- API ------------------------------------------------------------------

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

// ---- Theme ----------------------------------------------------------------
// The host doesn't expose its in-app theme, so we follow the OS appearance
// (prefers-color-scheme) by default and let the user force light/dark. The
// choice is persisted server-side and applied via a data-theme override.

const THEME_NEXT = { auto: "light", light: "dark", dark: "auto" };
const THEME_ICON = { auto: "device-desktop", light: "sun", dark: "moon" };

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  const btn = $("#theme-toggle");
  btn.querySelector("use").setAttribute("href", `#oct-${THEME_ICON[theme] || "device-desktop"}`);
  btn.title = `Theme: ${theme}`;
}

// ---- Tabs -----------------------------------------------------------------

function showTab(name) {
  for (const b of $$(".tabs button")) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of $$(".tab-panel")) p.classList.toggle("active", p.id === `tab-${name}`);
}

$$(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    if (b.classList.contains("hidden")) return;
    showTab(b.dataset.tab);
  });
});

// ---- Header / detection ---------------------------------------------------

function badge(text, muted) {
  const s = document.createElement("span");
  s.className = muted ? "badge muted" : "badge";
  s.textContent = text;
  return s;
}

function setControlsEnabled(enabled) {
  $$(".lane-btn").forEach((b) => {
    b.disabled = !enabled;
  });
  $("#scripts-toggle").disabled = !enabled;
  $$(".segmented button").forEach((b) => {
    b.disabled = !enabled;
  });
}

// ---- Loading indicators ---------------------------------------------------
// Show a spinner and block further clicks while a task runs. Spinner is
// rotate-only — never set `cursor` (native-host gotcha). Works for buttons that
// have a leading icon (swap it) and icon-less buttons (inject a spinner).

function setBtnLoading(btn, on) {
  if (!btn) return;
  const use = btn.querySelector(".oi use");
  if (on) {
    btn.classList.add("loading");
    if (use) {
      // Button already has a leading icon: swap it for the spinner glyph.
      if (!btn.dataset.icon0) btn.dataset.icon0 = use.getAttribute("href") || "";
      use.setAttribute("href", "#oct-sync");
      use.parentElement.classList.add("spin");
    } else if (!btn.querySelector(".oi.spin-injected")) {
      // Icon-less button: inject a temporary leading spinner.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "oi spin spin-injected");
      const u = document.createElementNS("http://www.w3.org/2000/svg", "use");
      u.setAttribute("href", "#oct-sync");
      svg.append(u);
      btn.prepend(svg);
    }
  } else {
    btn.classList.remove("loading");
    const injected = btn.querySelector(".oi.spin-injected");
    if (injected) injected.remove();
    if (use && btn.dataset.icon0) {
      use.setAttribute("href", btn.dataset.icon0);
      use.parentElement.classList.remove("spin");
      delete btn.dataset.icon0;
    }
  }
}

function isRunning(id) {
  return laneStatus(id) === "running";
}

// The lane-status key a pinned task button maps to (lanes are keyed by id,
// scripts by `script:<name>`).
function taskStatusId(btn) {
  return btn.dataset.taskType === "script" ? `script:${btn.dataset.taskName}` : btn.dataset.taskId;
}

// Reflect running tasks as spinning, click-blocked buttons. Idempotent.
function renderRunning() {
  $$("#pinned .lane-btn[data-task-type]").forEach((b) => {
    setBtnLoading(b, isRunning(taskStatusId(b)));
  });
}

// Dependency action buttons: spinner on the active one, disable its siblings.
function setDepsBusy(active, on) {
  setBtnLoading(active, on);
  for (const b of [$("#deps-check"), $("#deps-audit"), $("#deps-update")]) {
    if (b && b !== active) b.disabled = on;
  }
}

// Build one "label -> value" row for the Platform / Dependencies sections.
// When `skeleton` is true the value renders as a shimmering placeholder until
// the lazy stats arrive.
function infoRow(label, value, { skeleton = false, dim = false } = {}) {
  const row = document.createElement("div");
  row.className = "info-row";
  const l = document.createElement("span");
  l.className = "info-row-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = `info-row-value${dim ? " dim" : ""}`;
  if (skeleton) {
    v.classList.add("skeleton");
    v.textContent = "";
  } else {
    v.textContent = value;
  }
  row.append(l, v);
  return row;
}

function infoSection(title, iconId, rows) {
  const sec = document.createElement("div");
  sec.className = "info-section";
  const head = document.createElement("div");
  head.className = "info-section-head";
  head.innerHTML = `<svg class="oi"><use href="#oct-${iconId}" /></svg>`;
  const t = document.createElement("span");
  t.textContent = title;
  head.append(t);
  sec.append(head);
  for (const r of rows) sec.append(r);
  return sec;
}

function renderProject() {
  const d = state.detection;
  const wrap = $("#project");
  const meta = $("#info-meta");
  const sections = $("#project-info");
  const inactive = $("#info-inactive");
  const body = $("#info-body");
  const notice = $("#notice");
  const label = $("#info-label");
  wrap.innerHTML = "";
  meta.innerHTML = "";
  sections.innerHTML = "";

  if (!d?.hasProject) {
    // The extension is only meaningful with a package.json: show an inactive
    // empty-state and disable every control.
    label.textContent = "No project";
    body.classList.add("hidden");
    inactive.classList.remove("hidden");
    const where = d?.cwd ? ` in ${d.cwd}` : "";
    inactive.innerHTML =
      `<svg class="oi"><use href="#oct-package" /></svg>` +
      `<div class="info-inactive-title">Cockpit.js is inactive</div>` +
      `<div class="info-inactive-sub">No <code>package.json</code> found${where}.</div>`;
    notice.classList.add("hidden");
    setControlsEnabled(false);
    return;
  }

  inactive.classList.add("hidden");
  body.classList.remove("hidden");
  notice.classList.add("hidden");
  setControlsEnabled(true);

  // Heading: the project name (replaces the old static "Project" label).
  label.textContent = d.name;

  // Meta line: version, license, private badge, description.
  if (d.version) meta.append(metaItem(`v${d.version}`));
  if (d.license) meta.append(metaItem(d.license));
  if (d.private) meta.append(metaItem("private", true));
  if (d.description) {
    const desc = document.createElement("span");
    desc.className = "info-desc";
    desc.textContent = d.description;
    meta.append(desc);
  }

  // Stack pills (name/version removed — they live in the heading/meta now).
  wrap.append(badge(d.framework.label));
  if (d.typescript) wrap.append(badge("TypeScript"));
  if (d.testRunner) wrap.append(badge(d.testRunner));
  if (d.playwright) wrap.append(badge("Playwright"));
  if (d.linter) wrap.append(badge(d.linter));
  if (d.formatter) wrap.append(badge(d.formatter));
  if (d.workspaces) wrap.append(badge("workspaces", true));

  // Platform section.
  const nodeReq = d.engines?.node || d.nvmrc || "any";
  const platformRows = [
    infoRow("Node", nodeReq),
    infoRow("Package manager", d.packageManagerField || d.pm),
    infoRow("Module type", d.moduleType),
    infoRow("License", d.license || "—"),
    infoRow("Runtime", d.runtimeNode, { dim: true }),
  ];
  sections.append(infoSection("Platform", "gear", platformRows));

  // Dependencies section (cheap rows now, size/transitive rows lazy-loaded).
  const depsRows = [
    infoRow("Direct", `${d.dependencyCount} prod · ${d.devDependencyCount} dev`),
    infoRow("Installed (total)", "", { skeleton: true }),
    infoRow("Install footprint", "", { skeleton: true }),
    infoRow("Package size", "", { skeleton: true }),
    infoRow("Build output", "", { skeleton: true }),
    infoRow("Scripts", String((d.scriptNames || []).length)),
  ];
  const depsSection = infoSection("Dependencies", "package", depsRows);
  sections.append(depsSection);
  // The four lazy rows that loadStats fills in once stats arrive.
  const lazyRows = {
    installed: depsRows[1].querySelector(".info-row-value"),
    footprint: depsRows[2].querySelector(".info-row-value"),
    pack: depsRows[3].querySelector(".info-row-value"),
    build: depsRows[4].querySelector(".info-row-value"),
  };

  renderTabs();
  renderPinned();
  loadStats(lazyRows, d);
}

function metaItem(text, badgeStyle) {
  const s = document.createElement("span");
  s.className = badgeStyle ? "info-meta-badge" : "info-meta-item";
  s.textContent = text;
  return s;
}

function fillStatRow(el, value) {
  if (!el) return;
  el.classList.remove("skeleton");
  el.textContent = value;
}

// Lazily fetch the expensive metrics (transitive count + sizes) and fill the
// skeleton rows. Cached on state.stats; Refresh clears the cache to recompute.
async function loadStats(rows, detection) {
  let stats = state.stats;
  if (!stats) {
    stats = await api("/api/info/stats", {});
    // Detection may have changed (or gone) while the request was in flight.
    if (state.detection !== detection) return;
    if (stats && stats.hasProject === false) return;
    state.stats = stats;
  }
  fillStatRow(rows.installed, stats.installedCount != null ? String(stats.installedCount) : "—");
  fillStatRow(
    rows.footprint,
    stats.installBytes != null ? formatBytes(stats.installBytes) : "not installed",
  );
  if (stats.pack) {
    fillStatRow(
      rows.pack,
      `${formatBytes(stats.pack.packedBytes)} packed · ${formatBytes(stats.pack.unpackedBytes)} unpacked`,
    );
  } else {
    fillStatRow(rows.pack, detection.private ? "— (private)" : "—");
  }
  fillStatRow(
    rows.build,
    stats.build ? `${formatBytes(stats.build.bytes)} (${stats.build.dir})` : "not built",
  );
}

// Hide the Tests / Dev tabs when the project has nothing to run there.
function renderTabs() {
  const a = state.detection?.availability || {};
  const hasProject = !!state.detection?.hasProject;
  $("#tabbtn-tests").classList.toggle("hidden", hasProject && a.test === false);
  $("#tabbtn-dev").classList.toggle("hidden", hasProject && a.dev === false);
  const active = $(".tabs button.active");
  if (active?.classList.contains("hidden")) showTab("console");
}

// ---- Tasks (unified pinned lanes + scripts) -------------------------------

// Built-in lane tasks, in toolbar order, with display labels. `dev` lives in
// its own tab and is intentionally not a pinnable task.
const LANE_TASKS = [
  { id: "build", label: "Build" },
  { id: "typecheck", label: "Type-check" },
  { id: "lint", label: "Lint" },
  { id: "format", label: "Format" },
  { id: "test", label: "Test" },
];
const LANE_LABEL = Object.fromEntries(LANE_TASKS.map((t) => [t.id, t.label]));

function taskKey(t) {
  return t.type === "lane" ? `lane:${t.id}` : `script:${t.name}`;
}

function taskLabel(t) {
  return t.type === "lane" ? LANE_LABEL[t.id] || t.id : t.name;
}

// Whether a pinned task can currently run (its lane is available / its script
// still exists). Unavailable tasks stay pinned but are hidden from the toolbar.
function taskAvailable(t) {
  if (t.type === "lane") return state.detection?.availability?.[t.id] !== false;
  return (state.detection?.scriptNames || []).includes(t.name);
}

// Dispatch a task: the `test` lane has its own endpoint/report; other lanes go
// through /api/lane; scripts through /api/script.
function runTask(t) {
  if (t.type === "lane") {
    if (t.id === "test") return api("/api/test", {});
    return api("/api/lane", { id: t.id });
  }
  return api("/api/script", { name: t.name });
}

function renderPinned() {
  const wrap = $("#pinned");
  wrap.innerHTML = "";
  const hasProject = !!state.detection?.hasProject;
  const tasks = (state.settings.pinnedTasks || []).filter(taskAvailable);
  for (const t of tasks) {
    const b = document.createElement("button");
    b.className = "lane-btn task";
    b.dataset.taskType = t.type;
    if (t.type === "lane") b.dataset.taskId = t.id;
    else b.dataset.taskName = t.name;
    b.disabled = !hasProject;
    b.textContent = taskLabel(t);
    b.addEventListener("click", () => runTask(t));
    wrap.append(b);
  }
  $("#pinned-empty").classList.toggle("hidden", !hasProject || tasks.length > 0);
  renderRunning();
}

function isPinned(t) {
  const key = taskKey(t);
  return (state.settings.pinnedTasks || []).some((p) => taskKey(p) === key);
}

function menuGroup(menu, title, tasks) {
  if (!tasks.length) return;
  const head = document.createElement("div");
  head.className = "menu-head";
  head.textContent = title;
  menu.append(head);
  for (const t of tasks) {
    const item = document.createElement("div");
    item.className = "menu-item";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = isPinned(t);
    cb.title = "Pin to toolbar";
    cb.addEventListener("change", () => togglePin(t, cb.checked));
    const label = document.createElement("span");
    label.className = "menu-name";
    label.textContent = taskLabel(t);
    label.title = "Run now";
    label.addEventListener("click", () => {
      runTask(t);
      closeScriptsMenu();
    });
    item.append(cb, label);
    menu.append(item);
  }
}

function renderScriptsMenu() {
  const menu = $("#scripts-menu");
  menu.innerHTML = "";
  const a = state.detection?.availability || {};
  const laneTasks = LANE_TASKS.filter((t) => a[t.id] !== false).map((t) => ({
    type: "lane",
    id: t.id,
  }));
  const scriptTasks = (state.detection?.scriptNames || []).map((name) => ({
    type: "script",
    name,
  }));
  if (!laneTasks.length && !scriptTasks.length) {
    menu.innerHTML = '<div class="menu-empty">No tasks available.</div>';
    return;
  }
  menuGroup(menu, "Tasks", laneTasks);
  menuGroup(menu, "Scripts", scriptTasks);
}

async function togglePin(task, pin) {
  const key = taskKey(task);
  const next = (state.settings.pinnedTasks || []).filter((p) => taskKey(p) !== key);
  if (pin) next.push(task);
  state.settings.pinnedTasks = next;
  renderPinned();
  const res = await api("/api/settings", { pinnedTasks: next });
  if (res && Array.isArray(res.pinnedTasks)) {
    state.settings.pinnedTasks = res.pinnedTasks;
    renderPinned();
  }
}

function openScriptsMenu() {
  renderScriptsMenu();
  $("#scripts-menu").classList.remove("hidden");
  $("#scripts-toggle").setAttribute("aria-expanded", "true");
}

function closeScriptsMenu() {
  $("#scripts-menu").classList.add("hidden");
  $("#scripts-toggle").setAttribute("aria-expanded", "false");
}

// ---- Console --------------------------------------------------------------

function laneStatus(id) {
  return state.lanes[id]?.status || "idle";
}

function setConsoleLane(id) {
  activeConsoleLane = id;
  const lane = state.lanes[id] || {};
  $("#console-label").textContent = lane.label || id;
  $("#console").textContent = strip(lane.output || "");
  $("#console").scrollTop = $("#console").scrollHeight;
  renderConsoleStatus();
}

const STATUS_ICON = { running: "dot-fill", passed: "check-circle-fill", failed: "x-circle-fill" };

function statusChip(chip, status) {
  const icon = STATUS_ICON[status];
  chip.className = `status-chip ${status}`;
  chip.innerHTML = icon ? `<svg class="oi"><use href="#oct-${icon}" /></svg>` : "";
  chip.append(document.createTextNode(status));
}

function renderConsoleStatus() {
  const id = activeConsoleLane;
  const chip = $("#console-status");
  const fix = $("#console-fix");
  if (!id) {
    chip.textContent = "";
    chip.className = "status-chip";
    fix.classList.add("hidden");
    return;
  }
  const st = laneStatus(id);
  statusChip(chip, st);
  fix.classList.toggle("hidden", st !== "failed");
  fix.dataset.lane = id;
}

// ---- Tests ----------------------------------------------------------------

const TEST_ICON = {
  passed: "check-circle-fill",
  failed: "x-circle-fill",
  skipped: "dot-fill",
  pending: "dot-fill",
  todo: "dot-fill",
};

function relPath(p) {
  if (!p) return p;
  const cwd = state.detection?.cwd;
  if (cwd && (p === cwd || p.startsWith(`${cwd}/`))) {
    return p.slice(cwd.length + 1) || p;
  }
  return p.split("/").pop() || p;
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function renderTests() {
  const report = state.test.report;
  const empty = $("#tests-empty");
  const body = $("#tests-body");
  if (!report) {
    if (isRunning("test")) {
      empty.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg> Running tests…`;
    } else {
      empty.innerHTML = "No test run yet. Press <b>Test</b>.";
    }
    empty.classList.remove("hidden");
    body.classList.add("hidden");
    return;
  }
  empty.classList.add("hidden");
  body.classList.remove("hidden");

  const chips = $("#test-chips");
  chips.innerHTML = "";
  const mk = (cls, label) => {
    const c = document.createElement("span");
    c.className = `chip ${cls}`;
    c.textContent = label;
    return c;
  };
  chips.append(mk("total", `${report.total} total`));
  chips.append(mk("pass", `${report.passed} passed`));
  if (report.failed) chips.append(mk("fail", `${report.failed} failed`));
  if (report.skipped) chips.append(mk("skip", `${report.skipped} skipped`));

  $("#test-fix").classList.toggle("hidden", report.failed === 0);

  const suites = $("#test-suites");
  suites.innerHTML = "";
  for (const s of report.suites || []) {
    const tests = s.tests || [];
    const failed = tests.filter((t) => t.status === "failed").length;
    const passed = tests.filter((t) => t.status === "passed").length;
    const skipped = tests.length - failed - passed;
    const kind = failed ? "failed" : skipped ? "skipped" : "passed";
    const statusIcon =
      kind === "failed" ? "x-circle-fill" : kind === "passed" ? "check-circle-fill" : "dot-fill";

    // Native <details> avoids a JS toggle (and the native-host cursor fight).
    // Folded by default; auto-open only when the file has failures.
    const det = document.createElement("details");
    det.className = `suite ${kind}`;
    if (failed) det.open = true;

    const head = document.createElement("summary");
    head.className = "suite-head";
    head.innerHTML = `<svg class="oi suite-status"><use href="#oct-${statusIcon}" /></svg>`;

    const name = document.createElement("span");
    name.className = "suite-name";
    name.textContent = relPath(s.name);
    name.title = s.name;
    head.append(name);

    const counts = [];
    if (passed) counts.push(`${passed} passed`);
    if (failed) counts.push(`${failed} failed`);
    if (skipped) counts.push(`${skipped} skipped`);
    const dur = fmtDuration(s.durationMs);
    const meta = document.createElement("span");
    meta.className = "suite-meta";
    meta.textContent = `${counts.join(" · ") || "no tests"}${dur ? ` · ${dur}` : ""}`;
    head.append(meta);

    det.append(head);
    const rows = document.createElement("div");
    rows.className = "suite-rows";
    for (const t of tests) {
      const row = document.createElement("div");
      row.className = `test-row ${t.status}`;
      const icon = TEST_ICON[t.status] || "dot-fill";
      row.innerHTML = `<svg class="oi"><use href="#oct-${icon}" /></svg><span class="name"></span>`;
      row.querySelector(".name").textContent = t.name || "(unnamed)";
      rows.append(row);
      if (t.status === "failed" && t.message) {
        const msg = document.createElement("pre");
        msg.className = "test-msg";
        msg.textContent = strip(t.message);
        rows.append(msg);
      }
    }
    det.append(rows);
    suites.append(det);
  }
  $("#test-raw").textContent = strip(state.lanes.test?.output || "");
}

// ---- Dev ------------------------------------------------------------------

function renderDev() {
  const dev = state.dev;
  const running = dev.status === "running";
  $("#dev-start").classList.toggle("hidden", running);
  $("#dev-stop").classList.toggle("hidden", !running);
  const status = $("#dev-status");
  if (running && !dev.url) {
    status.className = "status-chip running";
    status.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg>`;
    status.append(document.createTextNode("starting"));
  } else {
    statusChip(status, running ? "running" : "stopped");
  }

  const urlWrap = $("#dev-url-wrap");
  const preview = $("#dev-preview");
  if (dev.url) {
    urlWrap.classList.remove("hidden");
    const a = $("#dev-url");
    a.textContent = dev.url;
    a.href = dev.url;
    if (preview.src !== dev.url) preview.src = dev.url;
    preview.classList.remove("hidden");
  } else {
    urlWrap.classList.add("hidden");
    preview.classList.add("hidden");
  }
  const c = $("#dev-console");
  c.textContent = strip(dev.output || "");
  c.scrollTop = c.scrollHeight;
}

// ---- Dependencies ---------------------------------------------------------

function renderOutdated() {
  const wrap = $("#outdated");
  const od = state.deps.outdated;
  if (!od) {
    wrap.innerHTML = '<div class="empty">Press <b>Check outdated</b>.</div>';
    return;
  }
  if (!od.list.length) {
    wrap.innerHTML = '<div class="empty">All dependencies are up to date.</div>';
    return;
  }
  const rows = od.list
    .map(
      (o) => `<tr>
        <td>${o.name}</td>
        <td class="ver">${o.current ?? "—"}</td>
        <td class="ver">${o.wanted ?? o.latest ?? "—"}</td>
        <td class="ver">${o.latest ?? "—"}</td>
        <td><span class="bump ${o.bump}">${o.bump}</span></td>
      </tr>`,
    )
    .join("");
  wrap.innerHTML = `<table class="dep-table">
    <thead><tr><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th><th>Bump</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${od.supported ? "" : '<div class="empty">JSON output unavailable for this package manager — values are best-effort.</div>'}`;
}

function renderAudit() {
  const a = state.deps.audit;
  const el = $("#audit-summary");
  if (!a) {
    el.classList.add("hidden");
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = "";
  const m = a.metadata;
  if (m && (m.total ?? 0) === 0) {
    const s = document.createElement("span");
    s.className = "sev clean";
    s.textContent = "No known vulnerabilities";
    el.append(s);
    return;
  }
  for (const sev of ["critical", "high", "moderate", "low", "info"]) {
    const n = m?.[sev] || 0;
    if (!n) continue;
    const s = document.createElement("span");
    s.className = `sev ${sev}`;
    s.textContent = `${n} ${sev}`;
    el.append(s);
  }
}

function renderUpdate() {
  const u = state.deps.update;
  const log = $("#deps-log");
  if (!u) {
    log.classList.add("hidden");
    return;
  }
  log.classList.remove("hidden");
  log.textContent = strip((u.log || []).join(""));
  log.scrollTop = log.scrollHeight;
  $("#deps-fix").classList.toggle("hidden", !(u.status === "done" && u.fixAvailable));
}

// ---- SSE ------------------------------------------------------------------

async function refreshSettings() {
  const s = await api("/api/settings");
  state.settings = { theme: s.theme || "auto", pinnedTasks: s.pinnedTasks || [] };
  applyTheme(state.settings.theme);
  renderPinned();
}

function applyEvent(e) {
  switch (e.type) {
    case "snapshot":
      Object.assign(state, e.state);
      state.lanes = e.state.lanes || {};
      renderProject();
      renderTests();
      renderDev();
      renderOutdated();
      renderAudit();
      renderUpdate();
      renderRunning();
      if (activeConsoleLane) setConsoleLane(activeConsoleLane);
      break;
    case "detection":
      state.detection = e.detection;
      state.stats = null;
      renderProject();
      refreshSettings();
      break;
    case "lane:start": {
      state.lanes[e.lane] = { id: e.lane, label: e.label, status: "running", output: "" };
      if (isConsoleLane(e.lane)) {
        setConsoleLane(e.lane);
        showTab("console");
      } else if (e.lane === "test") {
        showTab("tests");
        renderTests();
      }
      renderConsoleStatus();
      renderRunning();
      break;
    }
    case "lane:data": {
      state.lanes[e.lane] = state.lanes[e.lane] || { id: e.lane, output: "" };
      const lane = state.lanes[e.lane];
      lane.output = (lane.output || "") + e.chunk;
      if (e.lane === activeConsoleLane) {
        const c = $("#console");
        c.textContent += strip(e.chunk);
        c.scrollTop = c.scrollHeight;
      }
      break;
    }
    case "lane:end": {
      state.lanes[e.lane] = state.lanes[e.lane] || { id: e.lane };
      const lane = state.lanes[e.lane];
      lane.status = e.status;
      lane.exitCode = e.exitCode;
      if (e.lane === activeConsoleLane) renderConsoleStatus();
      if (e.lane === "test") renderTests();
      renderRunning();
      break;
    }
    case "test:report":
      state.test.report = e.report;
      renderTests();
      break;
    case "dev:start":
      state.dev = { status: "running", url: null, output: "", label: e.label };
      renderDev();
      break;
    case "dev:data":
      state.dev.output = (state.dev.output || "") + e.chunk;
      $("#dev-console").textContent += strip(e.chunk);
      $("#dev-console").scrollTop = $("#dev-console").scrollHeight;
      break;
    case "dev:url":
      state.dev.url = e.url;
      renderDev();
      break;
    case "dev:exit":
      state.dev.status = "stopped";
      renderDev();
      break;
    case "deps:outdated":
      state.deps.outdated = e.outdated;
      renderOutdated();
      break;
    case "deps:audit":
      state.deps.audit = e.audit;
      renderAudit();
      break;
    case "deps:update-start":
      state.deps.update = { status: "running", log: [], scope: e.scope };
      setDepsBusy($("#deps-update"), true);
      renderUpdate();
      break;
    case "deps:update-log":
      state.deps.update = state.deps.update || { log: [] };
      state.deps.update.log.push(e.chunk);
      renderUpdate();
      break;
    case "deps:update-done":
      state.deps.update = state.deps.update || { log: [] };
      Object.assign(state.deps.update, {
        status: "done",
        kept: e.kept,
        failed: e.failed,
        fixAvailable: e.fixAvailable,
      });
      setDepsBusy($("#deps-update"), false);
      renderUpdate();
      break;
    case "deps:rollback-done":
      break;
  }
}

function connect() {
  const es = new EventSource("/events");
  es.onmessage = (m) => {
    try {
      applyEvent(JSON.parse(m.data));
    } catch {}
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
}

// ---- Wiring ---------------------------------------------------------------

$("#refresh").addEventListener("click", () => api("/api/refresh", {}));

$("#theme-toggle").addEventListener("click", () => {
  const next = THEME_NEXT[state.settings.theme] || "auto";
  state.settings.theme = next;
  applyTheme(next);
  api("/api/settings", { theme: next });
});

$("#scripts-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#scripts-menu").classList.contains("hidden")) openScriptsMenu();
  else closeScriptsMenu();
});
document.addEventListener("click", (e) => {
  const target = /** @type {Element | null} */ (e.target);
  if (!target?.closest(".menu-wrap")) closeScriptsMenu();
});

$("#console-fix").addEventListener("click", (e) =>
  api("/api/fix", { lane: e.currentTarget.dataset.lane }),
);
$("#test-fix").addEventListener("click", () => api("/api/fix", { lane: "test" }));
$("#test-raw-toggle").addEventListener("click", () => $("#test-raw").classList.toggle("hidden"));

$("#dev-start").addEventListener("click", () => api("/api/dev/start", {}));
$("#dev-stop").addEventListener("click", () => api("/api/dev/stop", {}));
$("#dev-reload").addEventListener("click", () => {
  const p = $("#dev-preview");
  // biome-ignore lint/correctness/noSelfAssign: reassigning iframe.src to the same URL forces a reload
  if (p.src) p.src = p.src;
});

$("#deps-check").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setDepsBusy(btn, true);
  try {
    await api("/api/deps/outdated", {});
  } finally {
    setDepsBusy(btn, false);
  }
});
$("#deps-audit").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setDepsBusy(btn, true);
  try {
    await api("/api/deps/audit", {});
  } finally {
    setDepsBusy(btn, false);
  }
});
$$("#deps-scope button").forEach((b) => {
  b.addEventListener("click", () => {
    $$("#deps-scope button").forEach((x) => {
      x.classList.toggle("on", x === b);
    });
  });
});
$("#deps-update").addEventListener("click", () =>
  api("/api/deps/update", { scope: $("#deps-scope button.on")?.dataset.scope || "minor" }),
);
$("#deps-fix").addEventListener("click", () => api("/api/deps/fix", {}));

refreshSettings();
connect();

// Cockpit.js UI controller. Talks to the per-instance loopback server over a
// small JSON API and an SSE event stream, and keeps the DOM in sync with the
// shared controller state.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matches ANSI escape sequences to strip them
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => (s || "").replace(ANSI, "");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

// Deps "Updates" scope: "default" (in-range) or "custom" (hand-picked rows).
let depsScope = "default";
const depsChecked = new Set();

const state = {
  detection: null,
  lanes: {},
  test: { report: null, watch: false },
  dev: { status: "stopped", url: null, output: "" },
  deps: { outdated: null, audit: null, update: null },
  debug: {
    status: "stopped",
    target: null,
    paused: null,
    breakpoints: [],
    reason: null,
    output: "",
    console: "",
  },
  settings: {
    theme: "auto",
    pinnedTasks: [],
    tabOrder: null,
    hiddenTabs: [],
    autoProblems: false,
    autoTest: false,
    autoDeps: false,
    checkUpdatesOnLaunch: true,
  },
  version: null,
  update: null,
  stats: null,
  tsLs: {
    status: "stopped",
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    lastUpdated: null,
    reason: null,
  },
  lint: {
    status: "idle",
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    infoCount: 0,
    lastUpdated: null,
    reason: null,
  },
  rayfin: null,
  projects: null,
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
const CONSOLE_LANES = new Set(["build", "lint", "format", "typecheck", "update"]);
const isConsoleLane = (id) =>
  CONSOLE_LANES.has(id) || id.startsWith("script:") || id.startsWith("rayfin:");

// ---- Dev browser state ----------------------------------------------------
// The URL currently loaded in the preview iframe. Distinct from the dev
// server's detected URL: once the server URL is known we seed the preview once,
// then let the user navigate freely without state updates clobbering it.
let devPreviewUrl = null;
let consoleHeight = 160;

// ---- API ------------------------------------------------------------------

// The canvas UI is served under this base path (the server reverse-proxies every
// other path to the dev server so the preview is same-origin). Keep in sync with
// BASE in src/server.ts.
const BASE = "/__cockpit";

async function api(path, body) {
  const res = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json().catch(() => ({}));
}

let toastTimer = null;
function toast(message) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---- Theme ----------------------------------------------------------------
// The host doesn't expose its in-app theme, so we follow the OS appearance
// (prefers-color-scheme) by default and let the user force light/dark from the
// Settings tab. The choice is persisted server-side and applied via a
// data-theme override.

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");
  const seg = $("#theme-seg");
  if (seg) {
    const current = theme || "auto";
    for (const b of seg.querySelectorAll("button")) {
      const on = b.dataset.themeChoice === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
  }
}

// ---- Tabs -----------------------------------------------------------------

const tabBtns = () => $$("#tabs button[data-tab]");

// Default tab order + per-tab metadata (icon + label), shared by the Settings
// panel and applyTabLayout(). The Dev tab is now "preview".
const DEFAULT_TAB_ORDER = [
  "info",
  "preview",
  "rayfin",
  "tests",
  "problems",
  "deps",
  "debugger",
  "console",
];
const TAB_META = {
  info: { label: "Info", icon: "oct-info" },
  preview: { label: "Preview", icon: "oct-eye" },
  rayfin: { label: "Rayfin", icon: "oct-rayfin" },
  tests: { label: "Tests", icon: "oct-beaker" },
  problems: { label: "Problems", icon: "oct-alert" },
  deps: { label: "Dependencies", icon: "oct-package" },
  debugger: { label: "Debugger", icon: "oct-bug" },
  console: { label: "Console", icon: "oct-terminal" },
};

// settings.tabOrder may be partial/stale; keep only known ids and append any
// missing ones in their default position so new tabs still appear.
function effectiveTabOrder() {
  const saved = Array.isArray(state.settings.tabOrder) ? state.settings.tabOrder : [];
  const order = saved.filter((t) => DEFAULT_TAB_ORDER.includes(t));
  for (const t of DEFAULT_TAB_ORDER) if (!order.includes(t)) order.push(t);
  return order;
}

// Reorder the tab buttons per settings and hide user-hidden tabs (.tab-hidden),
// keeping the More wrapper last. If the active tab ends up hidden, fall back to
// the first visible tab (unless the Settings panel is open).
function applyTabLayout() {
  const bar = $("#tabs");
  const moreWrap = $("#tab-more-wrap");
  if (!bar || !moreWrap) return;
  const hidden = new Set(state.settings.hiddenTabs || []);
  for (const id of effectiveTabOrder()) {
    const btn = bar.querySelector(`button[data-tab="${id}"]`);
    if (!btn) continue;
    btn.classList.toggle("tab-hidden", hidden.has(id));
    bar.insertBefore(btn, moreWrap);
  }
  bar.append(moreWrap);
  const gearOpen = $("#settings-toggle")?.classList.contains("active");
  const active = bar.querySelector("button.active");
  if (
    !gearOpen &&
    active &&
    (active.classList.contains("tab-hidden") || active.classList.contains("hidden"))
  ) {
    const first = tabBtns().find(
      (b) => !b.classList.contains("tab-hidden") && !b.classList.contains("hidden"),
    );
    if (first) showTab(first.dataset.tab);
  }
  recomputeTabOverflow();
}

function showTab(name) {
  $("#settings-toggle")?.classList.remove("active");
  for (const b of tabBtns()) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of $$(".tab-panel")) p.classList.toggle("active", p.id === `tab-${name}`);
  if (name === "problems") requestDiagnostics();
  if (name === "rayfin") {
    loadRayfin();
    // If a graph was built earlier it may have been sized against a hidden
    // container; correct it now that the panel is visible.
    if (rfCytoscape) {
      rfCytoscape.resize();
      rfCytoscape.fit(undefined, 20);
    }
  }
  if (name === "debugger" && state.debug.status === "paused" && !dbgVars) refreshDebugVariables();
  recomputeTabOverflow();
}

tabBtns().forEach((b) => {
  b.addEventListener("click", () => {
    if (b.classList.contains("hidden")) return;
    showTab(b.dataset.tab);
  });
});

// Responsive tab bar: tabs that don't fit collapse into a trailing "⋯" (More)
// overflow menu. The tab buttons stay in the DOM (so their panels, badges and
// handlers remain wired); overflowed ones are hidden via `.overflow` and proxied
// by menu items that call showTab(). See the responsive-UI rule in AGENTS.md.
let overflowTabs = [];

function recomputeTabOverflow() {
  const bar = $("#tabs");
  const moreWrap = $("#tab-more-wrap");
  if (!bar || !moreWrap) return;
  const all = tabBtns();
  const avail = all.filter(
    (b) => !b.classList.contains("hidden") && !b.classList.contains("tab-hidden"),
  );
  // Reset to the widest layout, then measure.
  for (const b of all) b.classList.remove("overflow");
  moreWrap.classList.add("hidden");
  overflowTabs = [];
  if (bar.scrollWidth <= bar.clientWidth) {
    finishTabOverflow();
    return;
  }
  // Reveal More (this reserves its width), then collapse from the right —
  // lowest-priority tabs first — keeping the active tab visible when possible.
  moreWrap.classList.remove("hidden");
  const active = avail.find((b) => b.classList.contains("active")) || null;
  for (let i = avail.length - 1; i >= 0 && bar.scrollWidth > bar.clientWidth; i--) {
    const b = avail[i];
    if (b === active) continue;
    b.classList.add("overflow");
    overflowTabs.unshift(b);
  }
  // Extreme narrow: even the active tab + More won't fit. Collapse the active
  // tab too so nothing clips; the menu (and a highlighted More) keep it reachable.
  if (active && bar.scrollWidth > bar.clientWidth) {
    active.classList.add("overflow");
    overflowTabs.unshift(active);
  }
  finishTabOverflow();
}

function finishTabOverflow() {
  if (!overflowTabs.length) {
    $("#tab-more-wrap").classList.add("hidden");
    closeTabMore();
  }
  const active = tabBtns().find((b) => b.classList.contains("active"));
  $("#tab-more").classList.toggle("active", !!active && overflowTabs.includes(active));
  syncTabMoreBadge();
  if (!$("#tab-more-menu").classList.contains("hidden")) buildTabMoreMenu();
}

function tabLabelOf(b) {
  return [...b.childNodes]
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent)
    .join("")
    .trim();
}

// Map an overflowable tab button to its (visible) badge element, if any.
// Keyed by data-tab (not id — deps/debugger buttons have no id). The Debugger
// tab has no badge by design.
const TAB_BADGE_SEL = {
  problems: "#problems-badge",
  tests: "#tests-badge",
  deps: "#deps-badge",
};
function tabBadgeOf(btn) {
  const sel = TAB_BADGE_SEL[btn?.dataset?.tab];
  if (!sel) return null;
  const el = $(sel);
  return el && !el.classList.contains("hidden") ? el : null;
}

// Severity rank of a badge element: error (red) > warning (yellow) > default (blue).
function badgeSeverity(el) {
  if (el.classList.contains("error")) return 3;
  if (el.classList.contains("warning")) return 2;
  return 1;
}

// Mirror hidden tabs' badges onto the More button as a single severity dot (no
// number): summing counts across tabs would be misleading (different units), so
// we just signal "something's in here" colored by the most severe hidden badge.
// Per-tab counts stay visible in the dropdown (buildTabMoreMenu).
function syncTabMoreBadge() {
  const badge = $("#tab-more-badge");
  let severity = 0;
  for (const b of overflowTabs) {
    const el = tabBadgeOf(b);
    if (el) severity = Math.max(severity, badgeSeverity(el));
  }
  if (!severity) {
    badge.textContent = "";
    badge.className = "tab-badge hidden";
    return;
  }
  badge.textContent = "";
  badge.className = `tab-badge dot${severity === 3 ? " error" : severity === 2 ? " warning" : ""}`;
}

function buildTabMoreMenu() {
  const menu = $("#tab-more-menu");
  menu.innerHTML = "";
  const active = tabBtns().find((b) => b.classList.contains("active"));
  for (const b of overflowTabs) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "more-menu-item";
    item.setAttribute("role", "menuitem");
    if (b === active) item.classList.add("active");
    const href = b.querySelector("use")?.getAttribute("href") || "#oct-dot-fill";
    item.innerHTML = `<svg class="oi" aria-hidden="true"><use href="${href}" /></svg><span class="more-menu-name"></span>`;
    item.querySelector(".more-menu-name").textContent = tabLabelOf(b);
    const src = tabBadgeOf(b);
    if (src) {
      const bd = document.createElement("span");
      bd.className = src.className;
      bd.textContent = src.textContent;
      item.append(bd);
    }
    item.addEventListener("click", () => {
      showTab(b.dataset.tab);
      closeTabMore();
    });
    menu.append(item);
  }
}

function openTabMore() {
  closeScriptsMenu();
  closePinnedMore();
  closeProjectMenu();
  buildTabMoreMenu();
  const menu = $("#tab-more-menu");
  menu.classList.remove("hidden");
  $("#tab-more").setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closeTabMore() {
  $("#tab-more-menu").classList.add("hidden");
  $("#tab-more").setAttribute("aria-expanded", "false");
}

// Keep an open dropdown within the viewport horizontally. The body clips
// overflow, and these menus anchor to buttons that can sit anywhere along the
// bar, so a menu near an edge must be nudged back in.
function clampPopover(menu) {
  menu.style.transform = "";
  const rect = menu.getBoundingClientRect();
  const margin = 8;
  let dx = 0;
  if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
  if (rect.left + dx < margin) dx = margin - rect.left;
  if (dx) menu.style.transform = `translateX(${dx}px)`;
}

// ---- Header / detection ---------------------------------------------------

function badge(text, muted) {
  const s = document.createElement("span");
  s.className = muted ? "badge muted" : "badge";
  s.textContent = text;
  return s;
}

function setControlsEnabled(enabled) {
  // .copilot-btn shares this project-scoped disable path with .lane-btn (the
  // Fix/Send/Update handoffs were .lane-btn before the design pass). The
  // self-update controls are about the extension, not the project, so they're
  // marked [data-global] and stay usable even with no project open.
  $$(".lane-btn:not([data-global]), .copilot-btn:not([data-global])").forEach((b) => {
    b.disabled = !enabled;
  });
  $("#scripts-toggle").disabled = !enabled;
  // Project-scoped icon buttons (the deps refresh buttons) follow the project.
  for (const id of ["#deps-updates-refresh", "#deps-audit-refresh"]) {
    const b = $(id);
    if (b) b.disabled = !enabled;
  }
  // The theme picker is a global UI preference — keep it usable even when there's
  // no project (so only disable project-scoped segmented controls).
  $$(".segmented:not(.theme-seg) button").forEach((b) => {
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
// When clearing the busy state, re-derive actionability (don't blindly enable).
function setDepsBusy(active, on) {
  setBtnLoading(active, on);
  const all = [
    $("#deps-updates-refresh"),
    $("#deps-audit-refresh"),
    $("#deps-update"),
    $("#deps-audit-fix"),
  ];
  for (const b of all) {
    if (b && b !== active) b.disabled = on;
  }
  if (!on) updateDepsButtons();
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

// Hide the Tests / Preview / Problems tabs when the project has nothing to run there.
function renderTabs() {
  const a = state.detection?.availability || {};
  const hasProject = !!state.detection?.hasProject;
  $("#tabbtn-tests").classList.toggle("hidden", hasProject && a.test === false);
  $("#tabbtn-preview").classList.toggle("hidden", hasProject && a.dev === false);
  $("#tabbtn-problems").classList.toggle(
    "hidden",
    hasProject && a.diagnostics === false && a.lint === false,
  );
  $("#tabbtn-rayfin").classList.toggle("hidden", hasProject && !state.detection?.rayfin);
  renderRayfin();
  const active = $(".tabs button.active");
  if (active?.classList.contains("hidden")) {
    const first =
      tabBtns().find(
        (b) => !b.classList.contains("tab-hidden") && !b.classList.contains("hidden"),
      ) || $('[data-tab="console"]');
    if (first) showTab(first.dataset.tab);
  }
  recomputeTabOverflow();
}

// ---- Rayfin (Microsoft Rayfin BaaS dashboard) -----------------------------
// The Rayfin tab is a human-facing dashboard built from files under `rayfin/`
// (rayfin.yml, .deployments.json, .env, dab-config.json). CLI buttons run the
// real `rayfin` CLI as Console lanes; we intentionally expose no agent actions
// (Rayfin ships its own MCP/CLI/skills the agent already drives).

let rayfinLoading = false;

async function loadRayfin(force = false) {
  // No project: drive the intro state directly (no CLI/state fetch needed).
  if (!state.detection?.hasProject) {
    renderRayfin();
    return;
  }
  if (!state.detection?.rayfin) return;
  if (rayfinLoading) return;
  rayfinLoading = true;
  const det = state.detection;
  let result = null;
  try {
    result = await api("/api/rayfin/state", { force });
  } finally {
    rayfinLoading = false;
  }
  // Bail if the project changed while the request was in flight — a fresh
  // detection event will drive the UI for the new project.
  if (state.detection !== det) return;
  state.rayfin = result;
  renderRayfin();
}

// Only render links for http(s) URLs. Deployment URLs come from project files
// (rayfin/.deployments.json); escaping the value is not enough — a `javascript:`
// or `data:` href would still execute on click.
function safeHttpUrl(href) {
  try {
    const u = new URL(href);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

// Canonical Rayfin / Microsoft Fabric Apps reference links. Mirrors RAYFIN_LINKS
// in src/rayfin.ts; used here for the no-project intro state (where no dashboard
// state exists yet) and as a fallback for the detected-project Docs section.
const RAYFIN_LINKS = [
  {
    label: "Fabric Apps docs",
    url: "https://learn.microsoft.com/en-us/fabric/apps/overview",
    icon: "oct-book",
  },
  {
    label: "Rayfin on GitHub",
    url: "https://github.com/microsoft/rayfin",
    icon: "oct-mark-github",
  },
  {
    label: "Awesome Rayfin",
    url: "https://github.com/microsoft/awesome-rayfin",
    icon: "oct-star",
  },
];

function rfLink(label, href, icon = "oct-link-external") {
  const safe = safeHttpUrl(href);
  if (!safe) return "";
  return `<a class="rf-link" href="${esc(safe)}" target="_blank" rel="noreferrer noopener"
    ><svg class="oi" aria-hidden="true"><use href="#${icon}" /></svg>${esc(label)}</a>`;
}

function rfEntityDetail(e) {
  if (!e) return '<div class="rf-empty">Select an entity to see its details.</div>';
  const kind = e.isEntity
    ? '<span class="rf-tag entity">entity</span>'
    : '<span class="rf-tag role">role</span>';
  const roles = (e.roles || []).map((r) => `<span class="rf-tag">${esc(r)}</span>`).join("");
  const fields = (e.fields || [])
    .map((f) => {
      const type = f.relation
        ? `<span class="rf-rel-type">${esc(f.relation.kind)} → ${esc(f.relation.target)}</span>`
        : esc(f.type);
      const opt = f.optional ? '<span class="rf-opt">?</span>' : "";
      return `<tr><td class="rf-field-name">${esc(f.name)}${opt}</td><td class="rf-field-type">${type}</td></tr>`;
    })
    .join("");
  const perms = (e.permissions || [])
    .map(
      (p) =>
        `<div class="rf-perm"><span class="rf-tag">${esc(p.role)}</span><span class="rf-perm-actions">${esc(
          (p.actions || []).join(", "),
        )}</span></div>`,
    )
    .join("");
  return `<div class="rf-entity-detail-head">
      <strong>${esc(e.name)}</strong>${kind}${roles}
    </div>
    ${fields ? `<table class="rf-fields">${fields}</table>` : '<div class="rf-muted">No fields.</div>'}
    ${perms ? `<div class="rf-perms-block"><div class="rf-detail-sub">Permissions</div><div class="rf-perms">${perms}</div></div>` : ""}`;
}

// ---- Fabric workspace switcher (custom dropdown, mirrors the project selector) ----
let rayfinDeployments = [];

function renderRayfinSwitch() {
  const toggle = $("#rf-switch-toggle");
  const name = $("#rf-switch-name");
  if (!toggle || !name) return;
  const list = rayfinDeployments;
  const active = list.find((d) => d.active) || null;
  name.textContent = active ? active.name : "— none —";
  toggle.disabled = list.length === 0;
  toggle.title = active
    ? `Active Fabric workspace: ${active.name}`
    : "No Fabric workspace deployed";
}

function renderRayfinSwitchMenu() {
  const menu = $("#rf-switch-menu");
  menu.innerHTML = "";
  const list = rayfinDeployments;
  if (!list.length) {
    menu.innerHTML = '<div class="menu-empty">No deployments yet.</div>';
    return;
  }
  for (const d of list) {
    const isActive = !!d.active;
    const item = document.createElement("button");
    item.type = "button";
    item.className = `more-menu-item project-item${isActive ? " active" : ""}`;
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", isActive ? "true" : "false");
    const check = document.createElement("svg");
    check.setAttribute("class", "oi check");
    check.innerHTML = '<use href="#oct-check" />';
    const label = document.createElement("span");
    label.className = "project-item-label";
    const nm = document.createElement("span");
    nm.className = "project-item-name";
    nm.textContent = d.name;
    label.append(nm);
    item.append(check, label);
    item.addEventListener("click", () => selectRayfinWorkspace(d.name));
    menu.append(item);
  }
}

async function selectRayfinWorkspace(name) {
  closeRayfinSwitchMenu();
  if (!name) return;
  const active = rayfinDeployments.find((d) => d.active) || null;
  if (active && active.name === name) return;
  await api("/api/rayfin/switch", { name });
}

function openRayfinSwitchMenu() {
  closeScriptsMenu();
  closeTabMore();
  closePinnedMore();
  closeProjectMenu();
  closeRayfinExportMenu();
  renderRayfinSwitchMenu();
  const menu = $("#rf-switch-menu");
  menu.classList.remove("hidden");
  $("#rf-switch-toggle").setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closeRayfinSwitchMenu() {
  const menu = $("#rf-switch-menu");
  if (menu) menu.classList.add("hidden");
  $("#rf-switch-toggle")?.setAttribute("aria-expanded", "false");
}

// ---- Data model views (two-pane List/Detail + Graph) ---------------------
let rfEntities = [];
let rfSelectedEntity = null;
let rfModelView = "list";
try {
  if (localStorage.getItem("cockpit.rfModelView") === "graph") rfModelView = "graph";
} catch {}
let rfCytoscape = null; // active cytoscape instance (lazy)
let cytoscapeLoad = null; // cached load promise
let fcoseRegistered = false; // fcose layout extension registered on the core
let rfGraphSig = null; // signature of the data the current graph was built from

function getCytoscape() {
  return /** @type {any} */ (window).cytoscape;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`script-load-failed:${src}`));
    document.head.appendChild(s);
  });
}

// Lazy-load the graph engine (cytoscape core) and, best-effort, the fcose layout
// extension. fcose is optional: if it fails to load/register we fall back to the
// built-in `cose` layout, so the graph always renders.
function loadCytoscape() {
  if (cytoscapeLoad) return cytoscapeLoad;
  cytoscapeLoad = (async () => {
    if (!getCytoscape()) await loadScriptOnce(`${BASE}/vendor/cytoscape.min.js`);
    const cy = getCytoscape();
    try {
      const reg = /** @type {any} */ (window).cytoscapeFcose;
      if (!reg) await loadScriptOnce(`${BASE}/vendor/cytoscape-fcose.min.js`);
      const fcose = /** @type {any} */ (window).cytoscapeFcose;
      if (cy && fcose && !fcoseRegistered) {
        cy.use(fcose);
        fcoseRegistered = true;
      }
    } catch {}
    return cy;
  })().catch((err) => {
    // Don't cache a rejected load: a transient asset failure must not permanently
    // wedge the graph. Reset so the next renderRayfinGraph() retries the fetch.
    cytoscapeLoad = null;
    throw err;
  });
  return cytoscapeLoad;
}

// Force-directed auto-layout: fcose when available, else built-in cose.
function rfGraphLayout() {
  if (fcoseRegistered) {
    return {
      name: "fcose",
      animate: false,
      randomize: true,
      quality: "default",
      idealEdgeLength: 95,
      nodeSeparation: 90,
      nodeRepulsion: 6500,
      padding: 18,
    };
  }
  return { name: "cose", animate: false, padding: 18, nodeRepulsion: 6500, idealEdgeLength: 95 };
}

// Run the graph layout and frame the whole graph. Done explicitly (not via the
// cytoscape constructor's inline `layout`) so a layout failure can't leave nodes
// stacked at the origin: on any error we fall back to the always-present built-in
// `cose`, and we always fit the view so every entity stays in view.
function rfRunGraphLayout(cy) {
  const fitView = () => {
    try {
      cy.fit(undefined, 30);
    } catch {}
  };
  const run = (cfg) => {
    const lay = cy.layout(cfg);
    lay.one("layoutstop", fitView);
    lay.run();
  };
  try {
    run(rfGraphLayout());
  } catch {
    try {
      run({ name: "cose", animate: false, padding: 18 });
    } catch {
      fitView();
    }
  }
}

// Show edge labels only for the selected node's relations, plus the hovered node's
// (if any) — keeps the resting graph to clean nodes + arrowed edges.
function rfUpdateEdgeLabels(hoverNode) {
  if (!rfCytoscape) return;
  rfCytoscape.edges().removeClass("shown");
  rfCytoscape.$("node:selected").connectedEdges().addClass("shown");
  if (hoverNode) hoverNode.connectedEdges().addClass("shown");
}

// Clear transient Rayfin dashboard state on a project switch / initial load so
// the previous project's graph, entity selection, or workspace list never leak
// into the new one's loading view.
function resetRayfinTransient() {
  rayfinDeployments = [];
  rfEntities = [];
  rfSelectedEntity = null;
  if (rfCytoscape) {
    rfCytoscape.destroy();
    rfCytoscape = null;
  }
  rfGraphSig = null;
  closeRayfinSwitchMenu();
  renderRayfinSwitch();
  $("#rf-model-list")?.classList.remove("hidden");
  $("#rf-model-graph")?.classList.add("hidden");
}

function renderRayfinModel() {
  const listEl = $("#rf-model-list");
  const graphEl = $("#rf-model-graph");
  const seg = $("#rf-model-view");
  if (!listEl || !graphEl || !seg) return;
  for (const b of seg.querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.view === rfModelView);
  }
  const entities = rfEntities;
  if (!entities.length) {
    rfSelectedEntity = null;
    listEl.classList.remove("hidden");
    graphEl.classList.add("hidden");
    listEl.innerHTML =
      '<div class="rf-empty">No data model found. Define entities in <b>rayfin/data/schema.ts</b>.</div>';
    return;
  }
  if (!rfSelectedEntity || !entities.some((e) => e.name === rfSelectedEntity)) {
    rfSelectedEntity = entities[0].name;
  }
  const graph = rfModelView === "graph";
  listEl.classList.toggle("hidden", graph);
  graphEl.classList.toggle("hidden", !graph);
  renderRayfinModelList();
  if (graph) renderRayfinGraph();
}

function renderRayfinModelList() {
  const listEl = $("#rf-model-list");
  if (!listEl) return;
  const entities = rfEntities;
  const rows = entities
    .map((e) => {
      const active = e.name === rfSelectedEntity;
      const fieldCount = (e.fields || []).length;
      const rels = (e.fields || []).filter((f) => f.relation).length;
      const dotKind = e.isEntity ? "entity" : "role";
      const meta = `${fieldCount} ${fieldCount === 1 ? "field" : "fields"}${rels ? ` · ${rels} rel` : ""}`;
      return `<button type="button" class="rf-entity-row${active ? " active" : ""}" role="option" aria-selected="${active}" data-entity="${esc(e.name)}" title="${esc(e.name)}">
        <span class="rf-dot ${dotKind}" aria-hidden="true"></span>
        <span class="rf-row-name">${esc(e.name)}</span>
        <span class="rf-row-meta">${meta}</span>
      </button>`;
    })
    .join("");
  const detail = rfEntityDetail(entities.find((e) => e.name === rfSelectedEntity) || null);
  listEl.innerHTML = `<div class="rf-model-2pane">
      <div class="rf-entity-list" role="listbox" aria-label="Entities">${rows}</div>
      <div class="rf-entity-detail">${detail}</div>
    </div>`;
}

function selectRayfinEntity(name, opts = {}) {
  if (!name) return;
  rfSelectedEntity = name;
  renderRayfinModelList();
  if (opts.fromGraph || !rfCytoscape) return;
  rfCytoscape.$("node:selected").unselect();
  const node = rfCytoscape.getElementById(name);
  if (node && node.length) node.select();
}

function setRayfinModelView(view) {
  rfModelView = view === "graph" ? "graph" : "list";
  try {
    localStorage.setItem("cockpit.rfModelView", rfModelView);
  } catch {}
  renderRayfinModel();
}

function rfGraphElements() {
  const entities = rfEntities;
  const names = new Set(entities.map((e) => e.name));
  const nodes = entities.map((e) => ({
    data: { id: e.name, label: e.name, kind: e.isEntity ? "entity" : "role" },
  }));
  const edges = [];
  for (const e of entities) {
    for (const f of e.fields || []) {
      if (!f.relation || !names.has(f.relation.target)) continue;
      edges.push({
        data: {
          id: `${e.name}.${f.name}`,
          source: e.name,
          target: f.relation.target,
          label: `${f.name} (${f.relation.kind})`,
          kind: f.relation.kind,
        },
      });
    }
  }
  return [...nodes, ...edges];
}

// Structural signature of the current model — when unchanged we reuse the existing
// graph instance (and its layout) instead of rebuilding, so toggling List/Graph
// keeps an identical, stable layout.
function rfGraphSignature() {
  return rfGraphElements()
    .map((el) =>
      el.data.source
        ? `${el.data.id}>${el.data.target}:${el.data.kind}`
        : `${el.data.id}:${el.data.kind || ""}`,
    )
    .join("|");
}

// Sync the graph's selected node to rfSelectedEntity (used on rebuild and on reuse).
function rfApplyGraphSelection() {
  if (!rfCytoscape) return;
  rfCytoscape.$("node:selected").unselect();
  if (rfSelectedEntity) {
    const node = rfCytoscape.getElementById(rfSelectedEntity);
    if (node && node.length) node.select();
  }
  rfUpdateEdgeLabels(null);
}

// Resolve the graph palette from the live theme tokens (shared by the canvas
// renderer and the SVG export so they look identical).
function rfGraphColors() {
  const css = getComputedStyle(document.body);
  const tok = (n, fb) => (css.getPropertyValue(n) || "").trim() || fb;
  return {
    accent: tok("--accent", "#4493f8"),
    text: tok("--text", "#e6edf3"),
    dim: tok("--dim", "#7d8590"),
    bgElev: tok("--bg-elev", "#161b22"),
    purple: tok("--purple", "#bc8cff"),
    border: tok("--border", "#30363d"),
    bg: tok("--bg", "#0d1117"),
  };
}

async function renderRayfinGraph() {
  const host = $("#rf-graph-canvas");
  if (!host) return;
  // Cytoscape needs a laid-out, visible container to size/fit correctly.
  // renderTabs() can call renderRayfin() while the Rayfin tab (or graph pane) is
  // hidden; skip building then — opening the tab re-renders against a sized host.
  // This also keeps the 435 KB engine truly lazy until the graph is on screen.
  if (host.offsetParent === null || host.clientWidth === 0) return;
  // Unchanged data + live instance: just reframe + re-sync selection, keep the layout.
  const sig = rfGraphSignature();
  if (rfCytoscape && rfGraphSig === sig && rfCytoscape.container() === host) {
    rfCytoscape.resize();
    rfApplyGraphSelection();
    rfCytoscape.fit(undefined, 30);
    return;
  }
  let cy;
  try {
    cy = await loadCytoscape();
  } catch {
    host.innerHTML =
      '<div class="rf-empty">Graph view needs the bundled graph engine, which failed to load.</div>';
    return;
  }
  if (rfModelView !== "graph" || !cy) return; // user switched away while loading
  const { accent, text, dim, bgElev, purple, border } = rfGraphColors();
  if (rfCytoscape) {
    rfCytoscape.destroy();
    rfCytoscape = null;
  }
  rfCytoscape = cy({
    container: host,
    elements: rfGraphElements(),
    style: [
      {
        selector: "node",
        style: {
          "background-color": bgElev,
          "border-width": 1,
          "border-color": border,
          label: "data(label)",
          color: text,
          "font-size": 11,
          "text-valign": "center",
          "text-halign": "center",
          shape: "round-rectangle",
          width: "label",
          height: 28,
          padding: "8px",
        },
      },
      { selector: 'node[kind = "role"]', style: { "border-color": purple, "border-width": 2 } },
      {
        selector: "node:selected",
        style: { "border-color": accent, "border-width": 2, color: accent },
      },
      {
        selector: "edge",
        style: {
          width: 1.4,
          "line-color": dim,
          "target-arrow-color": dim,
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          label: "data(label)",
          "font-size": 9,
          color: dim,
          "text-opacity": 0,
          "text-rotation": "autorotate",
          "text-background-color": bgElev,
          "text-background-opacity": 1,
          "text-background-padding": 2,
        },
      },
      { selector: 'edge[kind = "many"]', style: { "line-style": "dashed" } },
      { selector: "edge.shown", style: { "text-opacity": 1, "z-index": 10 } },
    ],
    wheelSensitivity: 0.2,
  });
  rfGraphSig = sig;
  rfCytoscape.on("tap", "node", (evt) => selectRayfinEntity(evt.target.id(), { fromGraph: true }));
  rfCytoscape.on("mouseover", "node", (evt) => rfUpdateEdgeLabels(evt.target));
  rfCytoscape.on("mouseout", "node", () => rfUpdateEdgeLabels(null));
  rfCytoscape.on("select unselect", "node", () => rfUpdateEdgeLabels(null));
  rfApplyGraphSelection();
  rfRunGraphLayout(rfCytoscape);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// Hand-rolled SVG export of the graph model (the cytoscape-svg plugin is GPLv3, so
// it can't ship in this MIT project). Mirrors the on-screen styling and shows every
// edge label, since an exported diagram is static. Pure string builder.
function rfBuildGraphSvg(cy, colors) {
  const xml = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  const bb = cy.elements().boundingBox({ includeLabels: false });
  const pad = 24;
  const w = Math.round(Math.max(1, bb.w) + pad * 2);
  const h = Math.round(Math.max(1, bb.h) + pad * 2);
  const dx = pad - bb.x1;
  const dy = pad - bb.y1;
  const p = [];
  p.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">`,
  );
  p.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${colors.bg}"/>`);
  p.push(
    `<defs><marker id="rf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="${colors.dim}"/></marker></defs>`,
  );
  cy.edges().forEach((edge) => {
    const s = edge.sourceEndpoint();
    const t = edge.targetEndpoint();
    const dash = edge.data("kind") === "many" ? ' stroke-dasharray="5 4"' : "";
    p.push(
      `<line x1="${(s.x + dx).toFixed(1)}" y1="${(s.y + dy).toFixed(1)}" x2="${(t.x + dx).toFixed(1)}" y2="${(t.y + dy).toFixed(1)}" stroke="${colors.dim}" stroke-width="1.4"${dash} marker-end="url(#rf-arrow)"/>`,
    );
    const label = edge.data("label") || "";
    if (label) {
      const m = edge.midpoint();
      const lx = m.x + dx;
      const ly = m.y + dy;
      const tw = label.length * 5.3 + 8;
      p.push(
        `<rect x="${(lx - tw / 2).toFixed(1)}" y="${(ly - 8).toFixed(1)}" width="${tw.toFixed(1)}" height="14" rx="2" fill="${colors.bgElev}"/>`,
      );
      p.push(
        `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" fill="${colors.dim}" font-size="9" text-anchor="middle">${xml(label)}</text>`,
      );
    }
  });
  cy.nodes().forEach((node) => {
    const c = node.position();
    const nw = node.outerWidth();
    const nh = node.outerHeight();
    const selected = node.selected();
    const role = node.data("kind") === "role";
    const stroke = selected ? colors.accent : role ? colors.purple : colors.border;
    const sw = selected || role ? 2 : 1;
    const fg = selected ? colors.accent : colors.text;
    p.push(
      `<rect x="${(c.x + dx - nw / 2).toFixed(1)}" y="${(c.y + dy - nh / 2).toFixed(1)}" width="${nw.toFixed(1)}" height="${nh.toFixed(1)}" rx="6" fill="${colors.bgElev}" stroke="${stroke}" stroke-width="${sw}"/>`,
    );
    p.push(
      `<text x="${(c.x + dx).toFixed(1)}" y="${(c.y + dy + 4).toFixed(1)}" fill="${fg}" font-size="11" text-anchor="middle">${xml(node.data("label"))}</text>`,
    );
  });
  p.push("</svg>");
  return p.join("");
}

async function rfExportGraph(format) {
  closeRayfinExportMenu();
  const cy = rfCytoscape;
  if (!cy) return;
  const colors = rfGraphColors();
  cy.edges().addClass("shown"); // show every label in the export
  try {
    if (format === "svg") {
      const svg = rfBuildGraphSvg(cy, colors);
      downloadBlob("rayfin-data-model.svg", new Blob([svg], { type: "image/svg+xml" }));
    } else {
      const blob = cy.png({ output: "blob", full: true, scale: 2, bg: colors.bg });
      downloadBlob("rayfin-data-model.png", blob);
    }
  } catch (err) {
    console.warn("Rayfin graph export failed", err);
  } finally {
    cy.edges().removeClass("shown");
    rfUpdateEdgeLabels(null); // restore the interactive (selection-based) labels
  }
}

function openRayfinExportMenu() {
  closeScriptsMenu();
  closeTabMore();
  closePinnedMore();
  closeProjectMenu();
  closeRayfinSwitchMenu();
  const menu = $("#rf-export-menu");
  if (!menu) return;
  menu.classList.remove("hidden");
  $("#rf-graph-export")?.setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closeRayfinExportMenu() {
  const menu = $("#rf-export-menu");
  if (menu) menu.classList.add("hidden");
  $("#rf-graph-export")?.setAttribute("aria-expanded", "false");
}

function renderRayfin() {
  const panel = $("#tab-rayfin");
  if (!panel) return;
  const intro = $("#rf-intro");
  const detected = $("#rf-detected");
  const hasProject = !!state.detection?.hasProject;
  // No Node project at all: show the create-new-project intro instead of the
  // CLI-driven dashboard (there is nothing to inspect yet).
  if (!hasProject) {
    if (intro) {
      intro.classList.remove("hidden");
      const linksEl = $("#rf-intro-links");
      if (linksEl) {
        linksEl.innerHTML = RAYFIN_LINKS.map((l) => rfLink(l.label, l.url, l.icon)).join("");
      }
    }
    if (detected) detected.classList.add("hidden");
    // Drop any prior project's graph/selection so nothing leaks if a Rayfin
    // project is opened next.
    resetRayfinTransient();
    return;
  }
  if (intro) intro.classList.add("hidden");
  if (detected) detected.classList.remove("hidden");

  const r = state.rayfin;
  if (!r || r.detected === false) {
    $("#rf-app-name").textContent = "Rayfin";
    $("#rf-dialect").classList.add("hidden");
    for (const id of ["#rf-env", "#rf-workspace", "#rf-functions", "#rf-docs"]) {
      const el = $(id);
      if (el) el.innerHTML = '<div class="rf-empty">Loading…</div>';
    }
    // #rf-model is a structural container (segmented toggle + list/graph panes),
    // so only replace the list pane's content — wiping #rf-model would destroy
    // the children renderRayfinModel() needs and leave the section stuck loading.
    resetRayfinTransient();
    const ml = $("#rf-model-list");
    if (ml) ml.innerHTML = '<div class="rf-empty">Loading…</div>';
    $("#rf-model-count")?.classList.add("hidden");
    return;
  }

  // Header
  $("#rf-app-name").textContent = r.config?.name || "Rayfin";
  const dialect = $("#rf-dialect");
  if (r.config?.dialect) {
    dialect.textContent = r.config.dialect;
    dialect.classList.remove("hidden");
  } else dialect.classList.add("hidden");

  // Environment
  const auth = $("#rf-auth-chip");
  auth.textContent = r.auth?.signedIn ? "Signed in" : "Signed out";
  auth.className = `rf-chip ${r.auth?.signedIn ? "ok" : "muted"}`;
  $("#rf-backend-chip").classList.add("hidden");
  const methods = (r.config?.authMethods || []).join(", ") || "—";
  const hosting = r.config?.staticHosting?.folder;
  $("#rf-env").innerHTML = `<div class="rf-kv"><span>Auth methods</span><b>${esc(methods)}</b></div>
    ${hosting ? `<div class="rf-kv"><span>Static hosting</span><b>${esc(hosting)}</b></div>` : ""}`;

  // Fabric workspace & deployment
  const list = r.deployments?.list || [];
  const active = list.find((d) => d.active) || null;
  rayfinDeployments = list;
  renderRayfinSwitch();
  const ws = $("#rf-workspace");
  if (!active) {
    ws.innerHTML = `<div class="rf-deploy-form">
      <input type="text" id="rf-deploy-workspace" class="rf-input"
        placeholder="Workspace name, ID, or portal URL"
        aria-label="Target Fabric workspace (name, ID, or portal URL)" />
    </div>
    <div class="rf-empty">No deployment yet. Enter a target Fabric workspace (display name, GUID, or portal URL) and hit <b>Deploy</b> — or leave it blank to use your default workspace.</div>`;
  } else {
    const when = active.deployedAt ? new Date(active.deployedAt).toLocaleString() : "—";
    ws.innerHTML = `<div class="rf-card">
      <div class="rf-card-head"><strong>${esc(active.name)}</strong>
        <span class="rf-id" title="${esc(active.itemId || "")}">${esc(active.itemId || "")}</span></div>
      <div class="rf-links">
        ${rfLink("Open app", active.hostingUrl, "oct-link-external")}
        ${rfLink("Open Fabric workspace", active.portalUrl, "oct-rocket")}
        ${rfLink("API endpoint", active.apiUrl, "oct-server")}
      </div>
      <div class="rf-kv"><span>Deployed</span><b>${esc(when)}</b></div>
    </div>`;
  }

  // Data model
  const entities = r.entities || [];
  rfEntities = entities;
  const count = $("#rf-model-count");
  if (entities.length) {
    count.textContent = `${entities.length} ${entities.length === 1 ? "type" : "types"}`;
    count.classList.remove("hidden");
  } else count.classList.add("hidden");
  renderRayfinModel();

  // Functions & connectors
  const fns = r.functions || [];
  const conns = r.connectors || [];
  const fnHtml = fns.length
    ? fns.map((f) => `<span class="rf-tag">${esc(f)}</span>`).join("")
    : '<span class="rf-muted">No functions</span>';
  const connHtml = conns.length
    ? conns.map((c) => `<span class="rf-tag">${esc(c)}</span>`).join("")
    : '<span class="rf-muted">No connectors</span>';
  $("#rf-functions").innerHTML =
    `<div class="rf-kv"><span>Functions</span><div class="rf-tags">${fnHtml}</div></div>
    <div class="rf-kv"><span>Connectors</span><div class="rf-tags">${connHtml}</div></div>`;

  // Docs & agent setup
  const agentMsg = r.hasAgentFiles
    ? '<span class="rf-chip ok">Agent files present</span>'
    : '<span class="rf-chip muted">Agent files not set up</span>';
  const links = (r.links && r.links.length ? r.links : RAYFIN_LINKS)
    .map((l) => rfLink(l.label, l.url, l.icon))
    .join("");
  $("#rf-docs").innerHTML = `<div class="rf-kv"><span>Agent setup</span><div>${agentMsg}</div></div>
    <div class="rf-links rf-docs-links">${links}</div>`;
}

// ---- Tasks (unified pinned lanes + scripts) -------------------------------

// Built-in lane tasks ("special" tasks), in canonical order, with display
// labels. `dev` lives in its own tab and is intentionally not a pinnable task.
// `typecheck` was removed as a promoted task — the Problems tab supersedes it.
const LANE_TASKS = [
  { id: "build", label: "Build" },
  { id: "lint", label: "Lint" },
  { id: "format", label: "Format" },
  { id: "test", label: "Test" },
];
const LANE_LABEL = Object.fromEntries(LANE_TASKS.map((t) => [t.id, t.label]));

// The package.json script names that "back" each special task (mirrors the
// backend's pickScript precedence for what the lane actually runs). A lane binds
// to the first present candidate; any other same-family script (e.g. `lint:fix`,
// `format:check`, `test:watch`) stays an ordinary script.
const LANE_CANDIDATES = {
  build: ["build"],
  lint: ["lint"],
  format: ["format"],
  test: ["test"],
};

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

// Dispatch a task: the `test` lane has its own endpoint/report; the `lint` lane
// lives in the Problems tab (focus + refresh diagnostics there, not the console);
// other lanes go through /api/lane; scripts through /api/script.
function runTask(t) {
  if (t.type === "lane") {
    if (t.id === "test") return api("/api/test", {});
    if (t.id === "lint") return showTab("problems");
    return api("/api/lane", { id: t.id });
  }
  return api("/api/script", { name: t.name });
}

function renderPinned() {
  const wrap = $("#pinned");
  wrap.innerHTML = "";
  const hasProject = !!state.detection?.hasProject;
  // Keep toolbar buttons in the canonical task order (package.json order, with
  // script-less specials first) regardless of the order tasks were pinned in.
  const order = new Map(classifyTasks().map((e, i) => [taskKey(e.task), i]));
  const tasks = (state.settings.pinnedTasks || [])
    .filter(taskAvailable)
    .sort((a, b) => (order.get(taskKey(a)) ?? Infinity) - (order.get(taskKey(b)) ?? Infinity));
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
  recomputePinnedOverflow();
}

function isPinned(t) {
  const key = taskKey(t);
  return (state.settings.pinnedTasks || []).some((p) => taskKey(p) === key);
}

// Build the unified, package.json-ordered task list for the dropdown. Each entry
// is { task, special, scriptName, taskLabel }. A script that backs a built-in
// special task (build/lint/format/test) represents the *lane* (so there's no
// duplicate lane/script row); built-in tasks with no backing script are listed
// as script-less specials at the top.
function classifyTasks() {
  const a = state.detection?.availability || {};
  const scriptNames = state.detection?.scriptNames || [];
  // Bind each available special lane to its first present candidate script.
  const binding = new Map(); // laneId -> scriptName | null
  for (const t of LANE_TASKS) {
    if (a[t.id] === false) continue;
    const cand = (LANE_CANDIDATES[t.id] || []).find((c) => scriptNames.includes(c)) || null;
    binding.set(t.id, cand);
  }
  // Reverse map (bound script -> laneId) so we can promote it during the scan.
  const scriptToLane = new Map();
  for (const [id, script] of binding) if (script) scriptToLane.set(script, id);

  const entries = [];
  // 1) Script-less specials first, in LANE_TASKS order.
  for (const t of LANE_TASKS) {
    if (binding.get(t.id) === null) {
      entries.push({ task: { type: "lane", id: t.id }, special: true, taskLabel: t.label });
    }
  }
  // 2) All package.json scripts in declared order; promote the ones that back a lane.
  for (const name of scriptNames) {
    const laneId = scriptToLane.get(name);
    if (laneId) {
      entries.push({
        task: { type: "lane", id: laneId },
        special: true,
        taskLabel: LANE_LABEL[laneId] || laneId,
        scriptName: name,
      });
    } else {
      entries.push({ task: { type: "script", name }, special: false, scriptName: name });
    }
  }
  return entries;
}

// A small accent zap octicon flagging "special" (built-in) tasks — i.e. tasks
// Cockpit handles natively, parsing their output into a dedicated tab.
function taskBadge() {
  const m = document.createElement("span");
  m.className = "task-mark";
  m.setAttribute("aria-hidden", "true");
  m.innerHTML = '<svg class="oi"><use href="#oct-zap" /></svg>';
  return m;
}

// Render one dropdown row: a pin checkbox plus a run label. Special tasks get a
// zap marker after the name (explained by the menu footnote).
function renderTaskItem(e) {
  const item = document.createElement("div");
  item.className = e.special ? "menu-item special" : "menu-item";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isPinned(e.task);
  cb.title = "Pin to toolbar";
  cb.addEventListener("change", () => togglePin(e.task, cb.checked));
  const label = document.createElement("span");
  label.className = "menu-name";
  label.title = "Run now";
  // Script-backed specials and ordinary scripts show the script name; script-less
  // specials show the task label.
  label.append(document.createTextNode(e.scriptName || e.taskLabel));
  if (e.special) {
    const mark = taskBadge();
    mark.title = "Built-in task";
    label.append(mark);
  }
  label.addEventListener("click", () => {
    runTask(e.task);
    closeScriptsMenu();
  });
  item.append(cb, label);
  return item;
}

function renderScriptsMenu() {
  const menu = $("#scripts-menu");
  menu.innerHTML = "";
  const entries = classifyTasks();
  if (!entries.length) {
    menu.innerHTML = '<div class="menu-empty">No tasks available.</div>';
    return;
  }
  let anySpecial = false;
  for (const e of entries) {
    if (e.special) anySpecial = true;
    menu.append(renderTaskItem(e));
  }
  if (anySpecial) {
    const note = document.createElement("div");
    note.className = "menu-foot";
    note.append(
      taskBadge(),
      document.createTextNode(" Built-in task — output is parsed into its tab (Tests, Problems…)."),
    );
    menu.append(note);
  }
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
  closeTabMore();
  closePinnedMore();
  closeProjectMenu();
  renderScriptsMenu();
  const menu = $("#scripts-menu");
  menu.classList.remove("hidden");
  $("#scripts-toggle").setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closeScriptsMenu() {
  $("#scripts-menu").classList.add("hidden");
  $("#scripts-toggle").setAttribute("aria-expanded", "false");
}

// ---- Project selector (monorepo / multi-root) -----------------------------
// Shown only when more than one project is discovered under the session root.
// Picking one re-anchors the whole Cockpit to that directory (server-side).

function renderProjects() {
  const wrap = $("#project-wrap");
  const sep = $("#project-sep");
  const p = state.projects;
  const show = !!(p && p.multi);
  wrap.classList.toggle("hidden", !show);
  sep.classList.toggle("hidden", !show);
  if (!show) {
    closeProjectMenu();
    return;
  }
  const active = p.projects.find((x) => x.dir === p.active) || null;
  $("#project-name").textContent = active ? active.name : "Project";
  $("#project-toggle").title = active
    ? `Project: ${active.name} (${active.rel})`
    : "Switch project";
}

function renderProjectMenu() {
  const menu = $("#project-menu");
  menu.innerHTML = "";
  const p = state.projects;
  if (!p || !p.projects.length) {
    menu.innerHTML = '<div class="menu-empty">No projects found.</div>';
    return;
  }
  let lastGroup = null;
  for (const proj of p.projects) {
    if (proj.group !== lastGroup) {
      lastGroup = proj.group;
      const header = document.createElement("div");
      header.className = "menu-group-header";
      header.textContent = proj.group;
      menu.append(header);
    }
    const isActive = proj.dir === p.active;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "more-menu-item project-item" + (isActive ? " active" : "");
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", isActive ? "true" : "false");
    const check = document.createElement("svg");
    check.setAttribute("class", "oi check");
    check.innerHTML = '<use href="#oct-check" />';
    const label = document.createElement("span");
    label.className = "project-item-label";
    const name = document.createElement("span");
    name.className = "project-item-name";
    name.textContent = proj.name;
    label.append(name);
    if (proj.rel && proj.rel !== ".") {
      const rel = document.createElement("span");
      rel.className = "project-item-rel";
      rel.textContent = proj.rel;
      label.append(rel);
    }
    item.append(check, label);
    item.addEventListener("click", () => selectProject(proj.dir));
    menu.append(item);
  }
}

async function selectProject(dir) {
  closeProjectMenu();
  if (state.projects && dir === state.projects.active) return;
  const res = await api("/api/projects/select", { dir });
  if (res && res.ok === false) {
    toast(res.reason || "Could not switch project.");
  }
  // The server broadcasts fresh `projects` + `snapshot` events on success, which
  // re-render the selector and every tab — no optimistic update needed here.
}

function openProjectMenu() {
  closeScriptsMenu();
  closeTabMore();
  closePinnedMore();
  renderProjectMenu();
  const menu = $("#project-menu");
  menu.classList.remove("hidden");
  $("#project-toggle").setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closeProjectMenu() {
  $("#project-menu").classList.add("hidden");
  $("#project-toggle").setAttribute("aria-expanded", "false");
}

async function loadProjects() {
  const p = await api("/api/projects");
  if (p && Array.isArray(p.projects)) {
    state.projects = p;
    renderProjects();
  }
}

// ---- Pinned-tasks overflow (mirrors the tab overflow menu) ----------------
// At narrow widths the toolbar can't fit every pinned task. Collapse the
// trailing ones into a "More" menu that runs them on click, keeping the Tasks
// menu (the pin manager) always reachable on the right.
let pinnedOverflow = [];

function recomputePinnedOverflow() {
  const bar = $("#toolbar");
  const moreWrap = $("#pinned-more-wrap");
  if (!bar || !moreWrap) return;
  const all = [...$("#pinned").children];
  for (const b of all) b.classList.remove("overflow");
  moreWrap.classList.add("hidden");
  pinnedOverflow = [];
  if (bar.scrollWidth <= bar.clientWidth) {
    closePinnedMore();
    return;
  }
  // Reveal More (reserves its width), then collapse pinned tasks from the right.
  moreWrap.classList.remove("hidden");
  for (let i = all.length - 1; i >= 0 && bar.scrollWidth > bar.clientWidth; i--) {
    all[i].classList.add("overflow");
    pinnedOverflow.unshift(all[i]);
  }
  if (!pinnedOverflow.length) {
    // Overflow came from the Tasks button alone (no pinned tasks to collapse).
    moreWrap.classList.add("hidden");
    closePinnedMore();
    return;
  }
  // Extreme narrow: even ⋯ + Tasks won't fit. Drop ⋯ so the Tasks button (which
  // lists and runs every task anyway) isn't clipped off the right edge.
  if (bar.scrollWidth > bar.clientWidth) {
    moreWrap.classList.add("hidden");
    closePinnedMore();
    return;
  }
  if (!$("#pinned-more-menu").classList.contains("hidden")) buildPinnedMoreMenu();
}

function buildPinnedMoreMenu() {
  const menu = $("#pinned-more-menu");
  menu.innerHTML = "";
  for (const b of pinnedOverflow) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "more-menu-item";
    item.setAttribute("role", "menuitem");
    item.disabled = b.disabled;
    item.innerHTML = `<svg class="oi" aria-hidden="true"><use href="#oct-terminal" /></svg><span class="more-menu-name"></span>`;
    item.querySelector(".more-menu-name").textContent = b.textContent;
    item.addEventListener("click", () => {
      b.click();
      closePinnedMore();
    });
    menu.append(item);
  }
}

function openPinnedMore() {
  closeScriptsMenu();
  closeTabMore();
  closeProjectMenu();
  buildPinnedMoreMenu();
  const menu = $("#pinned-more-menu");
  menu.classList.remove("hidden");
  $("#pinned-more").setAttribute("aria-expanded", "true");
  clampPopover(menu);
}

function closePinnedMore() {
  $("#pinned-more-menu").classList.add("hidden");
  $("#pinned-more").setAttribute("aria-expanded", "false");
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
  // The update lane has its own agent-driven fix flow (no fixContext entry),
  // so don't offer the generic console "fix" button for it.
  fix.classList.toggle("hidden", st !== "failed" || id === "update");
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

// Tab badge: red failed count when the last run had failures, else hidden.
function setTestsBadge(failed) {
  const badge = $("#tests-badge");
  if (!badge) return;
  if (failed > 0) {
    badge.textContent = String(failed);
    badge.className = "tab-badge error";
  } else {
    badge.textContent = "";
    badge.className = "tab-badge hidden";
  }
}

// Reflect the backend watch state onto the Tests tab Watch switch.
function syncTestWatchSwitch() {
  const cb = $("#test-watch-check");
  if (cb) cb.checked = !!state.test?.watch;
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
    setTestsBadge(0);
    recomputeTabOverflow();
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
  setTestsBadge(report.failed);

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
  recomputeTabOverflow();
}

// ---- Problems (TypeScript language-server diagnostics) --------------------

// Lazily ask the backend for a fresh project-wide diagnostics snapshot. Results
// also arrive via SSE (ts:status / ts:diagnostics), so this just primes them.
function requestDiagnostics() {
  const a = state.detection?.availability || {};
  const hasProject = !!state.detection?.hasProject;
  if (!hasProject || (a.diagnostics === false && a.lint === false)) {
    renderProblems();
    return;
  }
  if (a.diagnostics !== false) {
    api("/api/diagnostics", {}).then((ts) => {
      if (ts && typeof ts === "object" && "status" in ts) {
        state.tsLs = ts;
        renderProblems();
      }
    });
  }
  if (a.lint !== false) {
    api("/api/lint", {}).then((lint) => {
      if (lint && typeof lint === "object" && "status" in lint) {
        state.lint = lint;
        renderProblems();
      }
    });
  }
}

const DIAG_ICON = { error: "x-circle-fill", warning: "alert", suggestion: "info" };
const CAT_RANK = { error: 0, warning: 1, suggestion: 2, message: 3 };

// Tag shown in the per-row code column: TS#### for the language server, the lint
// rule id for linter findings.
function diagCodeLabel(d) {
  if (d.source === "lint") return d.rule || "lint";
  return d.code ? `TS${d.code}` : d.category;
}

// Combine the two diagnostic sources into one analyzing/error/idle status used by
// the header chip and the empty state.
function combinedProblemsStatus() {
  const ts = state.tsLs;
  const lint = state.lint;
  const a = state.detection?.availability || {};
  const tsAvail = a.diagnostics !== false;
  const lintAvail = a.lint !== false;
  const tsBusy = tsAvail && (ts.status === "starting" || ts.status === "analyzing");
  const lintBusy = lintAvail && lint.status === "linting";
  const tsErr = tsAvail && ts.status === "error";
  const lintErr = lintAvail && lint.status === "error";
  const errorCount = (tsAvail ? ts.errorCount || 0 : 0) + (lintAvail ? lint.errorCount || 0 : 0);
  const warningCount =
    (tsAvail ? ts.warningCount || 0 : 0) + (lintAvail ? lint.warningCount || 0 : 0);
  const infoCount = lintAvail ? lint.infoCount || 0 : 0;
  let status = "ready";
  if (tsBusy || lintBusy) status = "analyzing";
  else if (tsErr || lintErr) status = "error";
  const reason = lintErr ? lint.reason : tsErr ? ts.reason : null;
  return { status, errorCount, warningCount, infoCount, reason };
}

function setProblemsStatus(chip, s) {
  chip.className = "status-chip";
  chip.innerHTML = "";
  if (s.status === "analyzing") {
    chip.classList.add("running");
    chip.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg>`;
    chip.append(document.createTextNode("analyzing"));
  } else if (s.status === "error") {
    chip.classList.add("failed");
    chip.innerHTML = `<svg class="oi"><use href="#oct-x-circle-fill" /></svg>`;
    chip.append(document.createTextNode("error"));
  } else if (!s.errorCount && !s.warningCount && !s.infoCount) {
    chip.classList.add("passed");
    chip.innerHTML = `<svg class="oi"><use href="#oct-check-circle-fill" /></svg>`;
    chip.append(document.createTextNode("no problems"));
  }
}

function renderProblems() {
  renderProblemsBody();
  // The Problems tab badge can appear/grow/shrink on SSE updates, changing the
  // tab row's intrinsic width without resizing #tabs itself (so the
  // ResizeObserver won't fire). Recompute overflow directly; this also refreshes
  // the More badge via finishTabOverflow().
  recomputeTabOverflow();
}

function renderProblemsBody() {
  const a = state.detection?.availability || {};
  const hasProject = !!state.detection?.hasProject;
  const tsAvail = a.diagnostics !== false;
  const lintAvail = a.lint !== false;
  const chips = $("#problems-chips");
  const status = $("#problems-status");
  const fixBtn = $("#problems-fix");
  const groups = $("#problems-groups");
  const empty = $("#problems-empty");
  const badge = $("#problems-badge");

  const s = combinedProblemsStatus();
  const totalErr = s.errorCount;
  const totalWarn = s.warningCount;
  const totalInfo = s.infoCount;

  // Tab badge: error count, else warning count (suggestions don't badge).
  if (totalErr) {
    badge.textContent = String(totalErr);
    badge.className = "tab-badge error";
  } else if (totalWarn) {
    badge.textContent = String(totalWarn);
    badge.className = "tab-badge warning";
  } else {
    badge.className = "tab-badge hidden";
  }

  // Unavailable: no project, or neither TypeScript nor a linter in the project.
  if (!hasProject || (!tsAvail && !lintAvail)) {
    chips.innerHTML = "";
    groups.innerHTML = "";
    fixBtn.classList.add("hidden");
    badge.className = "tab-badge hidden";
    status.className = "status-chip";
    status.innerHTML = "";
    empty.classList.remove("hidden");
    if (!hasProject) {
      empty.innerHTML = `<svg class="oi"><use href="#oct-info" /></svg> No Node.js project detected.`;
    } else {
      empty.innerHTML = `<svg class="oi"><use href="#oct-info" /></svg> No TypeScript or linter detected — add <code>typescript</code>/<code>tsconfig.json</code> or a linter (Biome, ESLint, oxlint) to enable live diagnostics.`;
    }
    return;
  }

  setProblemsStatus(status, s);

  chips.innerHTML = "";
  const mk = (cls, label) => {
    const c = document.createElement("span");
    c.className = `chip ${cls}`;
    c.textContent = label;
    return c;
  };
  if (totalErr) chips.append(mk("fail", `${totalErr} error${totalErr === 1 ? "" : "s"}`));
  if (totalWarn) chips.append(mk("skip", `${totalWarn} warning${totalWarn === 1 ? "" : "s"}`));
  if (totalInfo) chips.append(mk("skip", `${totalInfo} info`));

  const diags = [
    ...(tsAvail ? state.tsLs.diagnostics || [] : []),
    ...(lintAvail ? state.lint.diagnostics || [] : []),
  ];
  fixBtn.classList.toggle("hidden", diags.length === 0);

  if (!diags.length) {
    groups.innerHTML = "";
    empty.classList.remove("hidden");
    if (s.status === "analyzing") {
      empty.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg> Analyzing project…`;
    } else if (s.status === "error") {
      empty.innerHTML = `<svg class="oi"><use href="#oct-x-circle-fill" /></svg> `;
      empty.append(document.createTextNode(s.reason || "Diagnostics unavailable."));
    } else {
      empty.innerHTML = `<svg class="oi"><use href="#oct-check-circle-fill" /></svg> No problems found.`;
    }
    return;
  }
  empty.classList.add("hidden");

  // Group diagnostics by file (TS + lint merged), errors-first within each file.
  const byFile = new Map();
  for (const d of diags) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file).push(d);
  }

  groups.innerHTML = "";
  for (const [file, list] of byFile) {
    list.sort(
      (x, y) =>
        (CAT_RANK[x.category] ?? 9) - (CAT_RANK[y.category] ?? 9) ||
        x.start.line - y.start.line ||
        x.start.offset - y.start.offset,
    );
    const errs = list.filter((d) => d.category === "error").length;
    const warns = list.filter((d) => d.category === "warning").length;
    const infos = list.length - errs - warns;
    const det = document.createElement("details");
    det.className = `suite ${errs ? "failed" : warns ? "warning" : "info"}`;
    det.open = true;
    const head = document.createElement("summary");
    head.className = "suite-head";
    const headIcon = errs ? "x-circle-fill" : warns ? "alert" : "info";
    head.innerHTML = `<svg class="oi suite-status"><use href="#oct-${headIcon}" /></svg>`;
    const name = document.createElement("span");
    name.className = "suite-name";
    name.textContent = relPath(file);
    name.title = file;
    head.append(name);
    const counts = [];
    if (errs) counts.push(`${errs} error${errs === 1 ? "" : "s"}`);
    if (warns) counts.push(`${warns} warning${warns === 1 ? "" : "s"}`);
    if (infos) counts.push(`${infos} info`);
    const meta = document.createElement("span");
    meta.className = "suite-meta";
    meta.textContent = counts.join(" · ");
    head.append(meta);
    det.append(head);

    const rows = document.createElement("div");
    rows.className = "suite-rows";
    for (const d of list) {
      const row = document.createElement("div");
      row.className = `diag-row ${d.category}`;
      row.innerHTML = `<svg class="oi diag-icon"><use href="#oct-${DIAG_ICON[d.category] || "dot-fill"}" /></svg>`;
      const loc = document.createElement("span");
      loc.className = "diag-loc";
      loc.textContent = `${d.start.line}:${d.start.offset}`;
      const code = document.createElement("span");
      code.className = "diag-code";
      code.textContent = diagCodeLabel(d);
      const msg = document.createElement("span");
      msg.className = "diag-msg";
      msg.textContent = d.text;
      const fix = document.createElement("button");
      fix.type = "button";
      fix.className = "diag-fix fix-btn";
      fix.title = "Fix with Copilot";
      fix.innerHTML = `<svg class="oi" aria-hidden="true"><use href="#oct-copilot" /></svg>`;
      fix.addEventListener("click", () => api("/api/diagnostics/fix", { diagnostic: d }));
      row.append(loc, code, msg, fix);
      rows.append(row);
    }
    det.append(rows);
    groups.append(det);
  }
}

// ---- Dev ------------------------------------------------------------------

// The preview iframe is served same-origin through the canvas server's reverse
// proxy, so the URL loaded in the iframe (canvas origin) differs from the dev
// server's real URL. We show the *real* URL in the URL bar / use it for
// open-external, and map to the proxied URL when loading the iframe.
function devRealOrigin() {
  try {
    return state.dev?.url ? new URL(state.dev.url).origin : null;
  } catch {
    return null;
  }
}
function toProxy(realUrl) {
  try {
    const u = new URL(realUrl, state.dev?.url || location.origin);
    return location.origin + u.pathname + u.search + u.hash;
  } catch {
    return realUrl;
  }
}
function toReal(proxyUrl) {
  const base = devRealOrigin();
  try {
    const u = new URL(proxyUrl, location.origin);
    return (base || location.origin) + u.pathname + u.search + u.hash;
  } catch {
    return proxyUrl;
  }
}

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
  const urlInput = $("#dev-url");
  const hasUrl = running && Boolean(dev.url);
  if (hasUrl) {
    urlWrap.classList.remove("hidden");
    // Seed the preview + URL bar once, the first time the server URL is known.
    // Afterwards the user owns navigation; don't reset on every state update.
    if (!devPreviewUrl) {
      devPreviewUrl = dev.url;
      preview.src = toProxy(dev.url);
    }
    if (document.activeElement !== urlInput && urlInput.value === "") {
      urlInput.value = devPreviewUrl;
    }
    preview.classList.remove("hidden");
  } else {
    urlWrap.classList.add("hidden");
    preview.classList.add("hidden");
    devPreviewUrl = null;
    urlInput.value = "";
  }
  // Capture + Logs controls only make sense while a preview is showing.
  $("#dev-fix").classList.toggle("hidden", !hasUrl);
  $("#dev-logs-toggle").classList.toggle("hidden", !hasUrl);
  $("#dev-splitter").hidden = !hasUrl || !$("#dev-logs-check").checked;

  const c = $("#dev-console");
  c.textContent = strip(dev.output || "");
  c.scrollTop = c.scrollHeight;
}

// Normalize a user-typed URL and load it in the preview iframe (via the proxy).
function navigatePreview(raw) {
  let url = (raw || "").trim();
  if (!url) return;
  const origin = devRealOrigin();
  if (url.startsWith("/") && origin) {
    url = origin + url; // bare path → real dev URL
  } else if (!/^[a-z]+:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  devPreviewUrl = url;
  $("#dev-preview").src = toProxy(url);
  $("#dev-url").value = url;
}

// ---- Dependencies ---------------------------------------------------------

// One link per package row: changelog if known, else repo, else npm.
function depLinksCell(links) {
  if (!links) return "—";
  if (links.changelog)
    return `<a href="${esc(links.changelog)}" target="_blank" rel="noopener">${links.isGithub ? "Changelog" : "Repo"}</a>`;
  if (links.repo) return `<a href="${esc(links.repo)}" target="_blank" rel="noopener">Repo</a>`;
  if (links.npm) return `<a href="${esc(links.npm)}" target="_blank" rel="noopener">npm</a>`;
  return "—";
}

// Short prod/dev badge from the npm "type" field (devDependencies -> dev).
function depTypeBadge(type) {
  const dev = /dev/i.test(type || "");
  return `<span class="dep-type ${dev ? "dev" : "prod"}">${dev ? "dev" : "prod"}</span>`;
}

function renderOutdated() {
  const wrap = $("#outdated");
  const od = state.deps.outdated;
  if (!od) {
    depsChecked.clear();
    wrap.innerHTML = '<div class="empty">Press <b>Refresh</b> to check for updates.</div>';
    updateDepsButtons();
    return;
  }
  if (!od.list.length) {
    depsChecked.clear();
    wrap.innerHTML = '<div class="empty">All dependencies are up to date.</div>';
    updateDepsButtons();
    return;
  }
  // A row is updatable when the target for the current mode differs from the
  // installed version: Default targets the in-range `wanted`, Latest targets
  // `latest`. Pre-select every updatable row (user can deselect individually).
  const latest = depsScope === "latest";
  const isUpdatable = (o) =>
    latest ? !!o.latest && o.latest !== o.current : !!o.wanted && o.wanted !== o.current;
  const checkable = new Set(od.list.filter(isUpdatable).map((o) => o.name));
  for (const name of [...depsChecked]) if (!checkable.has(name)) depsChecked.delete(name);
  for (const name of checkable) depsChecked.add(name);
  const rows = od.list
    .map((o) => {
      const pickable = checkable.has(o.name);
      const checkbox = `<td class="dep-pick">${
        pickable
          ? `<input type="checkbox" class="dep-check" data-name="${esc(o.name)}"${depsChecked.has(o.name) ? " checked" : ""} aria-label="Update ${esc(o.name)}" />`
          : ""
      }</td>`;
      return `<tr>
        ${checkbox}
        <td class="dep-name">${esc(o.name)} ${depTypeBadge(o.type)}</td>
        <td class="ver">${o.current ?? "—"}</td>
        <td class="ver">${o.wanted ?? o.latest ?? "—"}</td>
        <td class="ver">${o.latest ?? "—"}</td>
        <td><span class="bump ${o.bump}">${o.bump}</span></td>
        <td class="dep-links">${depLinksCell(o.links)}</td>
      </tr>`;
    })
    .join("");
  const allOn = checkable.size > 0;
  const selectAll = `<input type="checkbox" id="deps-select-all" class="dep-check"${allOn ? " checked" : ""}${checkable.size ? "" : " disabled"} aria-label="Select all updates" />`;
  wrap.innerHTML = `<table class="dep-table">
    <thead><tr><th class="dep-pick">${selectAll}</th><th>Package</th><th>Current</th><th>Wanted</th><th>Latest</th><th>Bump</th><th>Link</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${od.supported ? "" : '<div class="empty">JSON output unavailable for this package manager — values are best-effort.</div>'}`;
  for (const cb of $$("#outdated .dep-check[data-name]")) {
    cb.addEventListener("change", (e) => {
      const name = e.currentTarget.dataset.name;
      if (e.currentTarget.checked) depsChecked.add(name);
      else depsChecked.delete(name);
      syncSelectAll(checkable);
      updateDepsButtons();
    });
  }
  const selAll = $("#deps-select-all");
  if (selAll)
    selAll.addEventListener("change", (e) => {
      const on = e.currentTarget.checked;
      for (const name of checkable) {
        if (on) depsChecked.add(name);
        else depsChecked.delete(name);
      }
      for (const cb of $$("#outdated .dep-check[data-name]")) cb.checked = on;
      updateDepsButtons();
    });
  updateDepsButtons();
}

// Keep the header "select all" box in sync with the row checkboxes.
function syncSelectAll(checkable) {
  const selAll = $("#deps-select-all");
  if (!selAll) return;
  let checked = 0;
  for (const name of checkable) if (depsChecked.has(name)) checked++;
  selAll.checked = checkable.size > 0 && checked === checkable.size;
  selAll.indeterminate = checked > 0 && checked < checkable.size;
}

// Enable/disable the two Copilot action buttons based on what's actionable.
function updateDepsButtons() {
  const upd = $("#deps-update");
  if (upd) upd.disabled = depsChecked.size === 0;
  const fix = $("#deps-audit-fix");
  if (fix) {
    const vulns = state.deps.audit?.vulnerabilities || [];
    fix.disabled = !vulns.some((v) => v.fixAvailable);
  }
}

function renderAudit() {
  const a = state.deps.audit;
  const el = $("#audit-summary");
  if (!a) {
    el.classList.add("hidden");
    renderAuditDetail();
    return;
  }
  el.classList.remove("hidden");
  el.innerHTML = "";
  const m = a.metadata;
  if ((m && (m.total ?? 0) === 0) || !a.vulnerabilities.length) {
    const s = document.createElement("span");
    s.className = "sev clean";
    s.textContent = "No known vulnerabilities";
    el.append(s);
    renderAuditDetail();
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
  renderAuditDetail();
}

// Per-package vulnerability rows: severity, vulnerable range, fix target, links.
function renderAuditDetail() {
  const wrap = $("#audit-detail");
  if (!wrap) return;
  const vulns = state.deps.audit?.vulnerabilities || [];
  if (!vulns.length) {
    wrap.innerHTML = "";
    updateDepsButtons();
    return;
  }
  const fixCell = (v) => {
    if (v.fix?.version)
      return `<span class="fix yes">${esc(v.fix.name || v.name)}@${esc(v.fix.version)}${v.fix.major ? ' <span class="fix-major">major</span>' : ""}</span>`;
    if (v.fixAvailable) return '<span class="fix yes">fix available</span>';
    return '<span class="fix no">no fix yet</span>';
  };
  const advCell = (v) => {
    const links = (v.advisories || [])
      .filter((adv) => adv.url)
      .slice(0, 2)
      .map(
        (adv) =>
          `<a href="${esc(adv.url)}" target="_blank" rel="noopener" title="${esc(adv.title)}">advisory</a>`,
      );
    return links.length ? links.join('<span class="dep-link-sep">·</span>') : "—";
  };
  const rows = vulns
    .map(
      (v) => `<tr>
        <td class="dep-name">${esc(v.name)}</td>
        <td><span class="sev ${esc(v.severity)}">${esc(v.severity)}</span></td>
        <td class="ver">${v.range ? esc(v.range) : "—"}</td>
        <td>${fixCell(v)}</td>
        <td class="dep-links">${advCell(v)}</td>
      </tr>`,
    )
    .join("");
  wrap.innerHTML = `<table class="dep-table">
    <thead><tr><th>Package</th><th>Severity</th><th>Vulnerable</th><th>Fix</th><th>Advisory</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  updateDepsButtons();
}

// Dependencies tab pill: number of pending updates (or vulnerabilities when
// nothing is outdated). Turns red when a high/critical advisory is present.
function renderDepsBadge() {
  const badge = $("#deps-badge");
  if (!badge) return;
  const outdated = state.deps.outdated?.list?.length || 0;
  const vulns = state.deps.audit?.vulnerabilities?.length || 0;
  const m = state.deps.audit?.metadata || {};
  const severe = (m.critical || 0) + (m.high || 0);
  if (!outdated && !vulns) {
    badge.className = "tab-badge hidden";
  } else {
    badge.textContent = String(outdated || vulns);
    badge.className = severe ? "tab-badge error" : "tab-badge";
  }
  recomputeTabOverflow();
}

// ---- Debugger -------------------------------------------------------------

// The variables tree fetches lazily: pick a frame -> /api/debug/variables,
// then expand objects on demand via /api/debug/properties. Caches are cleared
// whenever a new pause/frame is selected so stale object ids aren't reused.
let dbgSelectedFrame = null;
let dbgVars = null; // { frameId, scopes } for the selected frame
const dbgExpanded = new Set(); // objectIds currently expanded
const dbgChildren = new Map(); // objectId -> properties[] (lazy)

function appendDebugConsole(text) {
  const c = $("#dbg-console");
  if (!c) return;
  c.textContent += strip(text);
  c.scrollTop = c.scrollHeight;
}

function renderDebugger() {
  const d = state.debug;
  const status = d.status || "stopped";
  const active = status !== "stopped";
  const paused = status === "paused";

  $("#dbg-start")?.classList.toggle("hidden", active);
  $("#dbg-attach")?.classList.toggle("hidden", active);
  $("#dbg-stop")?.classList.toggle("hidden", !active);
  const program = $("#dbg-program");
  if (program) program.disabled = active;

  const chip = $("#dbg-status");
  if (chip) {
    if (status === "starting") {
      chip.className = "status-chip running";
      chip.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg>`;
      chip.append(document.createTextNode("starting"));
    } else {
      statusChip(chip, status);
    }
  }

  const toolbar = $("#dbg-toolbar");
  if (toolbar) toolbar.hidden = !active;
  const setDisabled = (sel, off) => {
    const el = $(sel);
    if (el) el.disabled = off;
  };
  setDisabled("#dbg-continue", !paused);
  setDisabled("#dbg-step-over", !paused);
  setDisabled("#dbg-step-into", !paused);
  setDisabled("#dbg-step-out", !paused);
  setDisabled("#dbg-pause", status !== "running");

  const reason = $("#dbg-pause-reason");
  if (reason) {
    if (paused && d.paused) {
      const r = d.paused.reason || "paused";
      reason.textContent = d.paused.text ? `${r}: ${d.paused.text}` : r;
    } else {
      reason.textContent = active ? "running" : "";
    }
  }

  renderDebugStack();
  renderDebugVariables();
  renderDebugBreakpoints();
}

function renderDebugStack() {
  const host = $("#dbg-stack");
  if (!host) return;
  const d = state.debug;
  if (d.status !== "paused" || !d.paused || !d.paused.frames.length) {
    host.innerHTML = `<div class="dbg-empty">${d.status === "running" ? "Running…" : "Not paused."}</div>`;
    return;
  }
  const frames = d.paused.frames;
  if (!frames.some((f) => f.id === dbgSelectedFrame)) dbgSelectedFrame = d.paused.topFrameId;
  host.innerHTML = frames
    .map((f) => {
      const loc = f.file ? `${esc(relPath(f.file))}:${f.line}` : "&lt;native&gt;";
      const sel = f.id === dbgSelectedFrame ? " selected" : "";
      return `<button type="button" class="dbg-frame${sel}" data-frame="${esc(f.id)}">
        <span class="dbg-frame-fn">${esc(f.functionName || "(anonymous)")}</span>
        <span class="dbg-frame-loc">${loc}</span>
      </button>`;
    })
    .join("");
}

function renderDebugVariables() {
  const host = $("#dbg-vars");
  if (!host) return;
  const d = state.debug;
  if (d.status !== "paused") {
    host.innerHTML = `<div class="dbg-empty">Variables appear when paused.</div>`;
    return;
  }
  if (!dbgVars || !dbgVars.scopes) {
    host.innerHTML = `<div class="dbg-empty">Loading…</div>`;
    return;
  }
  host.innerHTML = dbgVars.scopes
    .map((scope) => {
      const title = scope.name ? `${scope.type}: ${scope.name}` : scope.type;
      const rows = (scope.variables || []).map((v) => dbgVarRow(v, 0)).join("");
      return `<div class="dbg-scope"><div class="dbg-scope-head">${esc(title)}</div>${
        rows || `<div class="dbg-empty">—</div>`
      }</div>`;
    })
    .join("");
}

function dbgVarRow(v, depth) {
  const pad = depth * 12 + 8;
  const expandable = v.expandable && v.objectId;
  const open = expandable && dbgExpanded.has(v.objectId);
  const caret = expandable
    ? `<span class="dbg-caret${open ? " open" : ""}">▸</span>`
    : `<span class="dbg-caret-spacer"></span>`;
  let html = `<div class="dbg-var${expandable ? " expandable" : ""}" style="padding-left:${pad}px"${
    expandable ? ` data-objid="${esc(v.objectId)}"` : ""
  }>${caret}<span class="dbg-var-name">${esc(v.name)}</span><span class="dbg-var-sep">:</span><span class="dbg-var-val dbg-t-${esc(v.type)}">${esc(v.value)}</span></div>`;
  if (open) {
    const kids = dbgChildren.get(v.objectId);
    if (kids) html += kids.map((c) => dbgVarRow(c, depth + 1)).join("");
    else
      html += `<div class="dbg-var" style="padding-left:${pad + 20}px"><span class="dbg-empty">Loading…</span></div>`;
  }
  return html;
}

function renderDebugBreakpoints() {
  const host = $("#dbg-breakpoints");
  if (!host) return;
  const bps = state.debug.breakpoints || [];
  if (!bps.length) {
    host.innerHTML = `<div class="dbg-empty">No breakpoints yet. The agent can add them via debug_set_breakpoint.</div>`;
    return;
  }
  host.innerHTML = bps
    .map((b) => {
      const dot = b.verified ? "verified" : "pending";
      const cond = b.condition
        ? `<span class="dbg-bp-cond" title="${esc(b.condition)}">if ${esc(b.condition)}</span>`
        : "";
      return `<div class="dbg-bp">
        <span class="dbg-bp-dot ${dot}" title="${b.verified ? "Verified" : "Unverified"}"></span>
        <span class="dbg-bp-loc">${esc(relPath(b.file))}:${b.line}</span>
        ${cond}
        <button type="button" class="dbg-bp-remove icon-btn" data-bp="${esc(b.id)}" title="Remove breakpoint" aria-label="Remove breakpoint">
          <svg class="oi" aria-hidden="true"><use href="#oct-x" /></svg>
        </button>
      </div>`;
    })
    .join("");
}

// Fetch the variables for the currently selected frame and re-render the tree.
async function refreshDebugVariables() {
  const d = state.debug;
  if (d.status !== "paused") {
    dbgVars = null;
    renderDebugVariables();
    return;
  }
  dbgChildren.clear();
  dbgExpanded.clear();
  const res = await api("/api/debug/variables", {
    frameId: dbgSelectedFrame || undefined,
  });
  dbgVars = res?.ok ? { frameId: res.frameId, scopes: res.scopes || [] } : { scopes: [] };
  renderDebugVariables();
}

async function toggleDebugVar(objectId) {
  if (dbgExpanded.has(objectId)) {
    dbgExpanded.delete(objectId);
    renderDebugVariables();
    return;
  }
  dbgExpanded.add(objectId);
  if (!dbgChildren.has(objectId)) {
    renderDebugVariables();
    const res = await api("/api/debug/properties", { objectId });
    dbgChildren.set(objectId, res?.ok ? res.properties || [] : []);
  }
  renderDebugVariables();
}

// ---- SSE ------------------------------------------------------------------

async function refreshSettings() {
  const s = await api("/api/settings");
  applySettings(s);
}

// Normalize a server settings payload into state and re-render anything driven
// by it (theme, pinned tasks, tab layout, the Settings panel).
function applySettings(s) {
  state.settings = {
    theme: s.theme || "auto",
    pinnedTasks: s.pinnedTasks || [],
    tabOrder: Array.isArray(s.tabOrder) ? s.tabOrder : null,
    hiddenTabs: Array.isArray(s.hiddenTabs) ? s.hiddenTabs : [],
    autoProblems: !!s.autoProblems,
    autoTest: !!s.autoTest,
    autoDeps: !!s.autoDeps,
    checkUpdatesOnLaunch: s.checkUpdatesOnLaunch !== false,
  };
  applyTheme(state.settings.theme);
  renderPinned();
  applyTabLayout();
  renderSettingsPanel();
}

async function persistSettings(patch) {
  const s = await api("/api/settings", patch);
  if (s && typeof s === "object") applySettings(s);
}

function applyEvent(e) {
  switch (e.type) {
    case "snapshot":
      Object.assign(state, e.state);
      state.lanes = e.state.lanes || {};
      renderProject();
      renderAbout();
      renderTests();
      syncTestWatchSwitch();
      renderProblems();
      renderDev();
      renderOutdated();
      renderAudit();
      renderDepsBadge();
      renderDebugger();
      renderRunning();
      if (activeConsoleLane) {
        setConsoleLane(activeConsoleLane);
      } else {
        // On (re)connect, surface a console lane that's mid-run (e.g. an
        // in-progress dependency update) so its output isn't hidden.
        const running = Object.keys(state.lanes).find(
          (id) => isConsoleLane(id) && state.lanes[id]?.status === "running",
        );
        if (running) setConsoleLane(running);
      }
      break;
    case "detection":
      state.detection = e.detection;
      state.stats = null;
      state.rayfin = null;
      renderProject();
      refreshSettings();
      if (e.detection?.rayfin && $("#tabbtn-rayfin")?.classList.contains("active")) loadRayfin();
      break;
    case "rayfin:state":
      state.rayfin = e.rayfin;
      renderRayfin();
      break;
    case "projects":
      state.projects = e.projects;
      renderProjects();
      break;
    case "lane:start": {
      state.lanes[e.lane] = { id: e.lane, label: e.label, status: "running", output: "" };
      if (isConsoleLane(e.lane)) {
        setConsoleLane(e.lane);
        if (!e.auto) showTab("console");
      } else if (e.lane === "test") {
        if (!e.auto) showTab("tests");
        renderTests();
      }
      if (e.lane === "update") setDepsBusy($("#deps-update"), true);
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
      if (e.lane === "update") setDepsBusy($("#deps-update"), false);
      renderRunning();
      break;
    }
    case "test:report":
      state.test.report = e.report;
      renderTests();
      break;
    case "test:watch":
      state.test.watch = !!e.on;
      syncTestWatchSwitch();
      break;
    case "ts:status":
      state.tsLs = {
        ...state.tsLs,
        status: e.status,
        errorCount: e.errorCount ?? state.tsLs.errorCount,
        warningCount: e.warningCount ?? state.tsLs.warningCount,
      };
      renderProblems();
      break;
    case "ts:diagnostics":
      state.tsLs = e.tsLs;
      renderProblems();
      break;
    case "lint:status":
      state.lint = {
        ...state.lint,
        status: e.status,
        errorCount: e.errorCount ?? state.lint.errorCount,
        warningCount: e.warningCount ?? state.lint.warningCount,
      };
      renderProblems();
      break;
    case "lint:diagnostics":
      state.lint = e.lint;
      renderProblems();
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
      renderDepsBadge();
      break;
    case "deps:audit":
      state.deps.audit = e.audit;
      renderAudit();
      renderDepsBadge();
      break;
    case "debug:state":
      state.debug = {
        ...state.debug,
        status: e.status,
        target: e.target ?? null,
        paused: e.paused ?? null,
        breakpoints: e.breakpoints || [],
        reason: e.reason ?? null,
      };
      renderDebugger();
      break;
    case "debug:paused":
      state.debug.status = "paused";
      state.debug.paused = e.paused;
      dbgSelectedFrame = e.paused?.topFrameId ?? null;
      renderDebugger();
      if ($("#tab-debugger")?.classList.contains("active")) refreshDebugVariables();
      break;
    case "debug:resumed":
      if (state.debug.status !== "stopped") state.debug.status = "running";
      state.debug.paused = null;
      dbgSelectedFrame = null;
      renderDebugger();
      break;
    case "debug:data":
      state.debug.output = (state.debug.output || "") + e.chunk;
      appendDebugConsole(strip(e.chunk));
      break;
    case "debug:console":
      state.debug.console = (state.debug.console || "") + (e.text || "");
      appendDebugConsole(e.text || "");
      break;
    case "debug:exit":
      state.debug.status = "stopped";
      state.debug.paused = null;
      dbgSelectedFrame = null;
      if (e.exitCode != null && e.exitCode !== 0) {
        appendDebugConsole(`\n[process exited with code ${e.exitCode}]\n`);
      }
      renderDebugger();
      break;
  }
}

function connect() {
  const es = new EventSource(`${BASE}/events`);
  es.onopen = () => {
    // The connect snapshot omits projects (enumeration is async), so re-fetch
    // them on every (re)connect to keep the selector in sync after a reconnect.
    loadProjects();
  };
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

for (const b of $$("#theme-seg button")) {
  b.addEventListener("click", () => {
    const next = b.dataset.themeChoice;
    state.settings.theme = next;
    applyTheme(next);
    api("/api/settings", { theme: next });
  });
}

$("#scripts-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#scripts-menu").classList.contains("hidden")) openScriptsMenu();
  else closeScriptsMenu();
});
$("#project-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#project-menu").classList.contains("hidden")) openProjectMenu();
  else closeProjectMenu();
});
$("#tab-more").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#tab-more-menu").classList.contains("hidden")) openTabMore();
  else closeTabMore();
});
$("#pinned-more").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#pinned-more-menu").classList.contains("hidden")) openPinnedMore();
  else closePinnedMore();
});
document.addEventListener("click", (e) => {
  const target = /** @type {Element | null} */ (e.target);
  if (!target?.closest(".menu-wrap")) closeScriptsMenu();
  if (!target?.closest("#project-wrap")) closeProjectMenu();
  if (!target?.closest("#rf-switch-wrap")) closeRayfinSwitchMenu();
  if (!target?.closest("#rf-export-wrap")) closeRayfinExportMenu();
  if (!target?.closest(".tab-more-wrap")) closeTabMore();
  if (!target?.closest(".pinned-more-wrap")) closePinnedMore();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeScriptsMenu();
    closeProjectMenu();
    closeRayfinSwitchMenu();
    closeRayfinExportMenu();
    closeTabMore();
    closePinnedMore();
  }
});

$("#console-fix").addEventListener("click", (e) =>
  api("/api/fix", { lane: e.currentTarget.dataset.lane }),
);
$("#test-fix").addEventListener("click", () => api("/api/fix", { lane: "test" }));
$("#test-logs-check").addEventListener("change", (e) => {
  $("#test-raw").classList.toggle("hidden", !e.currentTarget.checked);
});
$("#test-watch-check").addEventListener("change", async (e) => {
  const on = e.currentTarget.checked;
  const res = await api("/api/test/watch", { on });
  if (res && res.ok === false) {
    e.currentTarget.checked = !on;
    if (res.reason) toast(res.reason);
  }
});

$("#problems-refresh").addEventListener("click", () => requestDiagnostics());
$("#problems-fix").addEventListener("click", () => api("/api/diagnostics/fix", { all: true }));

$("#dev-start").addEventListener("click", () => api("/api/dev/start", {}));
$("#dev-stop").addEventListener("click", () => api("/api/dev/stop", {}));
$("#dev-reload").addEventListener("click", () => {
  const p = $("#dev-preview");
  if (devPreviewUrl) {
    p.src = toProxy(devPreviewUrl);
  } else if (p.src) {
    // biome-ignore lint/correctness/noSelfAssign: reassigning iframe.src to the same URL forces a reload
    p.src = p.src;
  }
});
// The preview is same-origin (proxied), so we can read its location after
// in-iframe navigation and reflect the *real* dev URL back into the URL bar.
$("#dev-preview").addEventListener("load", () => {
  const p = $("#dev-preview");
  let href;
  try {
    href = p.contentWindow?.location?.href;
  } catch {
    return; // genuinely cross-origin (e.g. external link) → leave the bar as-is
  }
  if (!href || href === "about:blank" || !href.startsWith(location.origin)) return;
  const real = toReal(href);
  devPreviewUrl = real;
  const input = $("#dev-url");
  if (document.activeElement !== input) input.value = real;
});
$("#dev-open-ext").addEventListener("click", () => {
  const url = devPreviewUrl || $("#dev-url").value.trim();
  if (url) window.open(url, "_blank", "noreferrer");
});
$("#dev-url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    navigatePreview(e.currentTarget.value);
    e.currentTarget.blur();
  } else if (e.key === "Escape") {
    e.currentTarget.value = devPreviewUrl || "";
    e.currentTarget.blur();
  }
});
$("#dev-url").addEventListener("blur", (e) => {
  const v = e.currentTarget.value.trim();
  if (v && v !== devPreviewUrl) navigatePreview(v);
});

// ---- Debugger wiring ------------------------------------------------------
$("#dbg-start").addEventListener("click", async () => {
  const program = $("#dbg-program").value.trim();
  if (!program) {
    toast("Enter a program to debug.");
    return;
  }
  const res = await api("/api/debug/start", { program });
  if (res && res.ok === false && res.reason) toast(res.reason);
});
$("#dbg-attach").addEventListener("click", async () => {
  const res = await api("/api/debug/attach", {});
  if (res && res.ok === false && res.reason) toast(res.reason);
});
$("#dbg-stop").addEventListener("click", () => api("/api/debug/stop", {}));
$("#dbg-continue").addEventListener("click", () => api("/api/debug/continue", {}));
$("#dbg-pause").addEventListener("click", () => api("/api/debug/pause", {}));
$("#dbg-step-over").addEventListener("click", () => api("/api/debug/step-over", {}));
$("#dbg-step-into").addEventListener("click", () => api("/api/debug/step-into", {}));
$("#dbg-step-out").addEventListener("click", () => api("/api/debug/step-out", {}));

// Pick a call frame -> reload its variables.
$("#dbg-stack").addEventListener("click", (e) => {
  const btn = e.target.closest(".dbg-frame");
  if (!btn) return;
  dbgSelectedFrame = btn.dataset.frame;
  renderDebugStack();
  refreshDebugVariables();
});

// Expand/collapse objects in the variables tree.
$("#dbg-vars").addEventListener("click", (e) => {
  const row = e.target.closest(".dbg-var.expandable");
  if (!row || !row.dataset.objid) return;
  toggleDebugVar(row.dataset.objid);
});

// Remove a breakpoint.
$("#dbg-breakpoints").addEventListener("click", (e) => {
  const btn = e.target.closest(".dbg-bp-remove");
  if (!btn) return;
  api("/api/debug/breakpoint/remove", { id: btn.dataset.bp });
});

async function runDebugEval() {
  const input = $("#dbg-eval-input");
  const expression = input.value.trim();
  if (!expression) return;
  appendDebugConsole(`> ${expression}\n`);
  input.value = "";
  const res = await api("/api/debug/evaluate", {
    expression,
    frameId: dbgSelectedFrame || undefined,
  });
  if (res?.ok) {
    appendDebugConsole(`${res.result?.value ?? "undefined"}\n`);
  } else {
    appendDebugConsole(`⚠ ${res?.error || res?.reason || "Evaluation failed."}\n`);
  }
}
$("#dbg-eval-run").addEventListener("click", runDebugEval);
$("#dbg-eval-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runDebugEval();
  }
});
$("#dbg-program").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#dbg-start").click();
  }
});

// ---- Logs toggle + draggable splitter -------------------------------------
function applyConsoleHeight() {
  $("#dev-console").style.height = `${consoleHeight}px`;
}
$("#dev-logs-check").addEventListener("change", (e) => {
  const hidden = !e.currentTarget.checked;
  $("#dev-split").classList.toggle("logs-hidden", hidden);
  $("#dev-splitter").hidden = hidden;
});
(function wireSplitter() {
  const splitter = $("#dev-splitter");
  const split = $("#dev-split");
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    // Dragging up grows the console; clamp so neither pane collapses.
    const dy = startY - e.clientY;
    const max = split.clientHeight - 80;
    consoleHeight = Math.max(60, Math.min(max, startH + dy));
    applyConsoleHeight();
  };
  const onUp = () => {
    splitter.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    window.removeEventListener("blur", onUp);
  };
  splitter.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = $("#dev-console").offsetHeight;
    splitter.classList.add("dragging");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
  });
})();
applyConsoleHeight();

// ---- Fix with Copilot: in-page capture + crop -----------------------------
let captureCanvas = null;
let captureSel = null; // { x, y, w, h } in canvas pixels, or null for full frame

// Ask the injected bridge (public/preview-capture.js, running inside the
// same-origin proxied preview) to rasterize the page and return a PNG dataURL.
function captureViaIframe() {
  const preview = $("#dev-preview");
  const win = preview?.contentWindow;
  if (!win) return Promise.resolve({ error: "no-frame" });
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ error: "timeout" });
    }, 20000);
    function onMsg(ev) {
      if (ev.source !== win || ev.origin !== location.origin) return;
      const d = ev.data;
      if (!d || d.type !== "cockpit:capture:result" || d.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(d);
    }
    window.addEventListener("message", onMsg);
    try {
      win.postMessage({ type: "cockpit:capture", id }, location.origin);
    } catch {
      clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve({ error: "post-failed" });
    }
  });
}

// Decode a PNG dataURL into a canvas (the crop overlay operates on pixels).
function dataUrlToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1;
      c.height = img.naturalHeight || 1;
      c.getContext("2d").drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => reject(new Error("decode failed"));
    img.src = dataUrl;
  });
}

function openCapture(srcCanvas) {
  captureCanvas = srcCanvas;
  captureSel = null;
  const overlay = $("#capture-overlay");
  const dst = $("#capture-canvas");
  dst.width = srcCanvas.width;
  dst.height = srcCanvas.height;
  dst.getContext("2d").drawImage(srcCanvas, 0, 0);
  $("#capture-sel").classList.add("hidden");
  $("#capture-prompt").value = "";
  overlay.classList.remove("hidden");
}

function closeCapture() {
  $("#capture-overlay").classList.add("hidden");
  captureCanvas = null;
  captureSel = null;
}

(function wireCaptureSelection() {
  const dst = $("#capture-canvas");
  const selBox = $("#capture-sel");
  const stage = $("#capture-stage");
  let dragging = false;
  let originX = 0;
  let originY = 0;

  // Clamp the drag (two client-space points) to the visible canvas rect.
  const clampedRect = (ax, ay, bx, by) => {
    const r = dst.getBoundingClientRect();
    const left = Math.max(r.left, Math.min(ax, bx));
    const top = Math.max(r.top, Math.min(ay, by));
    const right = Math.min(r.right, Math.max(ax, bx));
    const bottom = Math.min(r.bottom, Math.max(ay, by));
    return { r, left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  };

  const draw = (box) => {
    const stageRect = stage.getBoundingClientRect();
    selBox.style.left = `${box.left - stageRect.left}px`;
    selBox.style.top = `${box.top - stageRect.top}px`;
    selBox.style.width = `${box.width}px`;
    selBox.style.height = `${box.height}px`;
  };

  dst.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    originX = e.clientX;
    originY = e.clientY;
    selBox.classList.remove("hidden");
    draw(clampedRect(originX, originY, originX, originY));
    dst.setPointerCapture(e.pointerId);
  });
  dst.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    draw(clampedRect(originX, originY, e.clientX, e.clientY));
  });
  const finish = (e) => {
    if (!dragging) return;
    dragging = false;
    const box = clampedRect(originX, originY, e.clientX, e.clientY);
    if (box.width < 8 || box.height < 8) {
      // Treat a click/tiny drag as "clear selection" (send full frame).
      captureSel = null;
      selBox.classList.add("hidden");
      return;
    }
    const scaleX = dst.width / box.r.width;
    const scaleY = dst.height / box.r.height;
    const x = Math.round((box.left - box.r.left) * scaleX);
    const y = Math.round((box.top - box.r.top) * scaleY);
    captureSel = {
      x,
      y,
      w: Math.min(Math.round(box.width * scaleX), dst.width - x),
      h: Math.min(Math.round(box.height * scaleY), dst.height - y),
    };
  };
  dst.addEventListener("pointerup", finish);
  dst.addEventListener("pointercancel", () => {
    dragging = false;
  });
})();

$("#dev-fix").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  const prev = btn.innerHTML;
  btn.innerHTML = `<svg class="oi spin"><use href="#oct-sync" /></svg>`;
  try {
    const r = await captureViaIframe();
    if (r.error || !r.dataUrl) {
      toast(r.error === "timeout" ? "Capture timed out." : "Couldn't capture the preview.");
      return;
    }
    const canvas = await dataUrlToCanvas(r.dataUrl);
    openCapture(canvas);
  } catch (err) {
    toast(`Capture failed: ${err}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = prev;
  }
});
$("#capture-full").addEventListener("click", () => {
  captureSel = null;
  $("#capture-sel").classList.add("hidden");
});
$("#capture-cancel").addEventListener("click", closeCapture);
$("#capture-overlay").addEventListener("pointerdown", (e) => {
  if (e.target === $("#capture-overlay")) closeCapture();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#capture-overlay").classList.contains("hidden")) closeCapture();
});
$("#capture-send").addEventListener("click", async (e) => {
  if (!captureCanvas) return;
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const sel = captureSel;
    const sx = sel ? sel.x : 0;
    const sy = sel ? sel.y : 0;
    const sw = sel ? sel.w : captureCanvas.width;
    const sh = sel ? sel.h : captureCanvas.height;
    // Cap the longest edge so a Retina/full-screen grab doesn't produce a huge
    // base64 payload; keeps the chat attachment focused and small.
    const MAX_EDGE = 2048;
    const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    out.getContext("2d").drawImage(captureCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const prompt = $("#capture-prompt").value.trim();
    const res = await api("/api/dev/screenshot", { data, mimeType: "image/png", prompt });
    closeCapture();
    toast(
      res?.ok === false
        ? `Couldn't send screenshot: ${res.reason || "error"}`
        : "Screenshot sent to Copilot.",
    );
  } catch (err) {
    toast(`Screenshot failed: ${err}`);
  } finally {
    btn.disabled = false;
  }
});

$("#deps-updates-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setDepsBusy(btn, true);
  try {
    await api("/api/deps/outdated", {});
  } finally {
    setDepsBusy(btn, false);
  }
});
$("#deps-audit-refresh").addEventListener("click", async (e) => {
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
    depsScope = b.dataset.scope === "latest" ? "latest" : "default";
    renderOutdated();
  });
});
$("#deps-update").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  setDepsBusy(btn, true);
  try {
    const r = await api("/api/deps/update", {
      mode: depsScope,
      packages: [...depsChecked],
    });
    if (r?.ok) toast("Asked Copilot to update dependencies. Watch the chat.");
    else if (r?.reason) toast(r.reason);
  } finally {
    setDepsBusy(btn, false);
  }
});
$("#deps-audit-fix").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (btn.disabled) return;
  setDepsBusy(btn, true);
  try {
    const r = await api("/api/deps/audit-fix", {});
    if (!r?.ok) {
      if (r?.reason) toast(r.reason);
      return;
    }
    const fixed = r.fixed || 0;
    const remaining = r.remaining || 0;
    if (r.escalated) {
      if (r.rolledBack) {
        toast(
          "Audit fix would break the app — rolled back. Asked Copilot to fix it. Watch the chat.",
        );
      } else if (r.ran && fixed > 0) {
        toast(
          `Audit fix resolved ${fixed}; asked Copilot for the remaining ${remaining}. Watch the chat.`,
        );
      } else {
        toast("Asked Copilot to fix vulnerabilities. Watch the chat.");
      }
    } else {
      const lead =
        fixed > 0
          ? `Audit fix resolved ${fixed} vulnerability group(s).`
          : "Vulnerabilities fixed.";
      toast(remaining > 0 ? `${lead} ${remaining} remain with no automatic fix.` : lead);
    }
  } finally {
    setDepsBusy(btn, false);
  }
});

// ---- Rayfin wiring --------------------------------------------------------

$("#rf-refresh").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setDepsBusy(btn, true);
  try {
    await loadRayfin(true);
  } finally {
    setDepsBusy(btn, false);
  }
});

// Intro state: hand Copilot the canonical "scaffold a new Rayfin app" prompt.
$("#rf-create")?.addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  setDepsBusy(btn, true);
  try {
    const r = await api("/api/rayfin/start", {});
    if (r && r.ok === false) toast(r.reason || "Couldn't start a Rayfin project.");
    else toast("Sent the Rayfin setup prompt to Copilot.");
  } finally {
    setDepsBusy(btn, false);
  }
});

// Delegated handler for every CLI button (data-rf-cli="dev start"). Streams to
// the Console tab via the rayfin:<cmd> lane.
$("#tab-rayfin").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-rf-cli]");
  if (!btn) return;
  const args = btn.dataset.rfCli.split(/\s+/).filter(Boolean);
  if (!args.length) return;
  const r = await api("/api/rayfin/cli", { args });
  if (r && r.started === false && r.reason) toast(r.reason);
});

// Deploy button. Picks up the optional workspace target from the not-deployed
// empty-state input; blank deploys to the default workspace. The server picks
// the right --workspace/--workspace-id/--workspace-uri flag by value shape.
$("#tab-rayfin").addEventListener("click", async (e) => {
  if (!e.target.closest("[data-rf-deploy]")) return;
  const input = $("#rf-deploy-workspace");
  const workspace = input ? input.value.trim() : "";
  const r = await api("/api/rayfin/deploy", { workspace });
  if (r && r.started === false && r.reason) toast(r.reason);
});

$("#rf-switch-toggle").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#rf-switch-toggle").disabled) return;
  if ($("#rf-switch-menu").classList.contains("hidden")) openRayfinSwitchMenu();
  else closeRayfinSwitchMenu();
});

// Data model: List | Graph toggle, entity selection, graph fit.
$("#rf-model-view").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-view]");
  if (btn) setRayfinModelView(btn.dataset.view);
});
$("#rf-model-list").addEventListener("click", (e) => {
  const row = e.target.closest(".rf-entity-row");
  if (row) selectRayfinEntity(row.dataset.entity);
});
$("#rf-model-list").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const entities = rfEntities;
  if (!entities.length) return;
  e.preventDefault();
  const idx = entities.findIndex((x) => x.name === rfSelectedEntity);
  const next =
    e.key === "ArrowDown" ? Math.min(entities.length - 1, idx + 1) : Math.max(0, idx - 1);
  selectRayfinEntity(entities[next].name);
  $("#rf-model-list").querySelector(".rf-entity-row.active")?.focus();
});
$("#rf-graph-fit").addEventListener("click", () => {
  if (rfCytoscape) rfCytoscape.fit(undefined, 20);
});
$("#rf-graph-export").addEventListener("click", (e) => {
  e.stopPropagation();
  if ($("#rf-export-menu").classList.contains("hidden")) openRayfinExportMenu();
  else closeRayfinExportMenu();
});
$("#rf-export-menu").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-export]");
  if (btn) rfExportGraph(btn.dataset.export);
});

// ---- Settings panel -------------------------------------------------------

// The Settings panel is a gear-launched pseudo-tab (not part of #tabs). Opening
// it deactivates every real tab; clicking any real tab (or the gear again)
// returns to normal.
function openSettings() {
  closeScriptsMenu();
  closePinnedMore();
  closeTabMore();
  for (const b of tabBtns()) b.classList.remove("active");
  $("#tab-more")?.classList.remove("active");
  for (const p of $$(".tab-panel")) p.classList.toggle("active", p.id === "tab-settings");
  $("#settings-toggle").classList.add("active");
  renderSettingsPanel();
  recomputeTabOverflow();
}

function firstVisibleTab() {
  return (
    tabBtns().find((b) => !b.classList.contains("tab-hidden") && !b.classList.contains("hidden")) ||
    tabBtns()[0]
  );
}

$("#settings-toggle").addEventListener("click", () => {
  if ($("#settings-toggle").classList.contains("active")) {
    const first = firstVisibleTab();
    if (first) showTab(first.dataset.tab);
  } else {
    openSettings();
  }
});

// Rebuild the Tabs list (drag handle + icon/label + visibility switch) and sync
// the On-load auto-run checkboxes from current settings.
function renderSettingsPanel() {
  applyTheme(state.settings.theme);
  const al = $("#set-autoproblems");
  if (al) al.checked = !!state.settings.autoProblems;
  const at = $("#set-autotest");
  if (at) at.checked = !!state.settings.autoTest;
  const ad = $("#set-autodeps");
  if (ad) ad.checked = !!state.settings.autoDeps;
  const cu = $("#set-checkupdates");
  if (cu) cu.checked = state.settings.checkUpdatesOnLaunch !== false;
  renderAbout();

  const list = $("#settings-tabs");
  if (!list) return;
  list.innerHTML = "";
  const hidden = new Set(state.settings.hiddenTabs || []);
  for (const id of effectiveTabOrder()) {
    const meta = TAB_META[id];
    if (!meta) continue;
    const row = document.createElement("div");
    row.className = "settings-tab-row";
    row.draggable = true;
    row.dataset.tab = id;
    row.innerHTML =
      `<svg class="oi drag-handle" aria-hidden="true"><use href="#oct-grabber" /></svg>` +
      `<svg class="oi settings-tab-icon" aria-hidden="true"><use href="#${meta.icon}" /></svg>` +
      `<span class="settings-tab-name"></span><span class="grow"></span>` +
      `<label class="switch"><input type="checkbox" ${hidden.has(id) ? "" : "checked"} />` +
      `<span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label>`;
    row.querySelector(".settings-tab-name").textContent = meta.label;
    const cb = /** @type {HTMLInputElement} */ (row.querySelector('input[type="checkbox"]'));
    cb.addEventListener("change", () => toggleTabHidden(id, !cb.checked));
    wireTabRowDnD(row, list);
    list.append(row);
  }
}

async function toggleTabHidden(id, hide) {
  const hidden = new Set(state.settings.hiddenTabs || []);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  if (DEFAULT_TAB_ORDER.filter((t) => !hidden.has(t)).length < 1) {
    toast("At least one tab must stay visible.");
    renderSettingsPanel();
    return;
  }
  await persistSettings({ hiddenTabs: [...hidden] });
}

// HTML5 drag-and-drop reorder (works in WKWebView). On dragover we reposition
// the dragged row live; on dragend we commit the new order to settings.
function wireTabRowDnD(row, list) {
  row.addEventListener("dragstart", (e) => {
    row.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", row.dataset.tab);
    } catch {}
  });
  row.addEventListener("dragend", () => {
    row.classList.remove("dragging");
    commitTabOrder(list);
  });
  row.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = list.querySelector(".settings-tab-row.dragging");
    if (!dragging || dragging === row) return;
    const rect = row.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    list.insertBefore(dragging, after ? row.nextSibling : row);
  });
}

async function commitTabOrder(list) {
  const order = [...list.querySelectorAll(".settings-tab-row")].map((r) => r.dataset.tab);
  await persistSettings({ tabOrder: order });
}

$("#set-autoproblems").addEventListener("change", (e) =>
  persistSettings({ autoProblems: e.currentTarget.checked }),
);
$("#set-autotest").addEventListener("change", (e) =>
  persistSettings({ autoTest: e.currentTarget.checked }),
);
$("#set-autodeps").addEventListener("change", (e) =>
  persistSettings({ autoDeps: e.currentTarget.checked }),
);
$("#set-checkupdates").addEventListener("change", (e) =>
  persistSettings({ checkUpdatesOnLaunch: e.currentTarget.checked }),
);

// ---- Self-update ----------------------------------------------------------
// Cockpit can't reload itself, so "Update Cockpit.js" hands the swap to Copilot
// chat. The check compares the running version against the latest GitHub Release
// of the distribution repo; failures stay quiet (never a false "update ready").

let updateChecking = false;

// Render the About card (version line + status) and the gear update dot from
// state.version (state snapshot) and state.update (the last check result).
function renderAbout() {
  const verEl = $("#about-version");
  if (verEl) verEl.textContent = state.version ? `v${state.version}` : "—";

  const statusEl = $("#about-status");
  const notes = $("#update-notes");
  const apply = $("#update-apply");
  const dot = $("#settings-update-dot");
  const u = state.update;

  if (statusEl) {
    statusEl.classList.remove("up-to-date", "available", "error");
    if (updateChecking && !u) {
      statusEl.textContent = "Checking for updates…";
    } else if (!u) {
      statusEl.textContent = "";
    } else if (u.error) {
      statusEl.textContent = "Couldn't check for updates";
      statusEl.classList.add("error");
    } else if (u.updateAvailable) {
      statusEl.textContent = `Update available → v${u.latestVersion}`;
      statusEl.classList.add("available");
    } else {
      statusEl.textContent = "Up to date";
      statusEl.classList.add("up-to-date");
    }
  }

  const available = !!(u?.updateAvailable && !u.error);
  if (notes) {
    notes.classList.toggle("hidden", !(available && u.releaseUrl));
    if (available && u.releaseUrl) notes.href = u.releaseUrl;
  }
  if (apply) apply.classList.toggle("hidden", !available);
  if (dot) dot.classList.toggle("hidden", !available);
}

async function runUpdateCheck(force) {
  if (updateChecking) return;
  updateChecking = true;
  const btn = $("#update-check");
  if (btn) btn.classList.toggle("spinning", true);
  renderAbout();
  try {
    const info = await api("/api/update/check", { force: !!force });
    if (info && typeof info === "object") state.update = info;
  } finally {
    updateChecking = false;
    if (btn) btn.classList.toggle("spinning", false);
    renderAbout();
  }
}

$("#update-check").addEventListener("click", () => runUpdateCheck(true));

$("#update-apply").addEventListener("click", async () => {
  const res = await api("/api/update/apply", {});
  if (res?.ok) toast("Asked Copilot to update Cockpit.js…");
  else toast(res?.reason || "Couldn't start the update.");
});

// Apply persisted tab order/visibility before opening the SSE stream so a custom
// layout doesn't briefly flash in the default order on first paint. connect()
// still runs even if the settings fetch fails. The project list is fetched up
// front too (init() may have broadcast it before the SSE stream connected).
refreshSettings().finally(() => {
  loadProjects();
  connect();
  // Auto-check after settings load so we honor the checkUpdatesOnLaunch toggle.
  if (state.settings.checkUpdatesOnLaunch !== false) runUpdateCheck(false);
});

// Keep the tab bar and toolbar responsive: recompute their overflow menus
// whenever the panel is resized, plus once on initial layout.
if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    recomputeTabOverflow();
    recomputePinnedOverflow();
  });
  ro.observe($("#tabs"));
  ro.observe($("#toolbar"));
}
recomputeTabOverflow();
recomputePinnedOverflow();

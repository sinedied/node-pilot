// Node Pilot UI controller. Talks to the per-instance loopback server over a
// small JSON API and an SSE event stream, and keeps the DOM in sync with the
// shared controller state.

const $ = (sel) => document.querySelector(sel);
const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s) => (s || "").replace(ANSI, "");

const state = {
  detection: null,
  lanes: {},
  test: { report: null },
  dev: { status: "stopped", url: null, output: "" },
  deps: { outdated: null, audit: null, update: null },
};

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

// ---- Tabs -----------------------------------------------------------------

function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button"))
    b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".tab-panel"))
    p.classList.toggle("active", p.id === `tab-${name}`);
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => showTab(b.dataset.tab));
});

// ---- Header / detection ---------------------------------------------------

function badge(text) {
  const s = document.createElement("span");
  s.className = "badge";
  s.textContent = text;
  return s;
}

function renderProject() {
  const d = state.detection;
  const wrap = $("#project");
  wrap.innerHTML = "";
  const notice = $("#notice");
  if (!d || !d.hasProject) {
    notice.textContent = d?.reason || "No Node.js project (package.json) found in this folder.";
    notice.classList.remove("hidden");
    document.querySelectorAll(".lane-btn, #scripts").forEach((b) => (b.disabled = true));
    return;
  }
  notice.classList.add("hidden");
  document.querySelectorAll(".lane-btn, #scripts").forEach((b) => (b.disabled = false));
  wrap.append(badge(`${d.name}${d.version ? " " + d.version : ""}`));
  wrap.append(badge(d.pm));
  wrap.append(badge(d.framework.label));
  if (d.typescript) wrap.append(badge("TypeScript"));
  if (d.testRunner) wrap.append(badge(d.testRunner));
  if (d.linter) wrap.append(badge(d.linter));
  if (d.workspaces) wrap.append(badge("workspaces"));

  const sel = $("#scripts");
  sel.innerHTML = '<option value="">—</option>';
  for (const name of d.scriptNames || []) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = name;
    sel.append(o);
  }
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
  chip.textContent = st;
  chip.className = `status-chip ${st}`;
  fix.classList.toggle("hidden", st !== "failed");
  fix.dataset.lane = id;
}

// ---- Tests ----------------------------------------------------------------

function renderTests() {
  const report = state.test.report;
  const empty = $("#tests-empty");
  const body = $("#tests-body");
  if (!report) {
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
    const div = document.createElement("div");
    div.className = "suite";
    const head = document.createElement("div");
    head.className = "suite-name";
    head.textContent = s.name;
    div.append(head);
    for (const t of s.tests || []) {
      const row = document.createElement("div");
      row.className = `test-row ${t.status}`;
      const icon =
        { passed: "✓", failed: "✕", skipped: "○", pending: "○", todo: "○" }[t.status] || "·";
      row.innerHTML = `<span class="icon">${icon}</span><span class="name"></span>`;
      row.querySelector(".name").textContent = t.name || "(unnamed)";
      div.append(row);
      if (t.status === "failed" && t.message) {
        const msg = document.createElement("pre");
        msg.className = "test-msg";
        msg.textContent = strip(t.message);
        div.append(msg);
      }
    }
    suites.append(div);
  }
  $("#test-raw").textContent = strip(state.lanes.test?.output || "");
}

// ---- Dev ------------------------------------------------------------------

function renderDev() {
  const dev = state.dev;
  const running = dev.status === "running";
  $("#dev-start").classList.toggle("hidden", running);
  $("#dev-stop").classList.toggle("hidden", !running);
  const chip = $("#dev-status");
  chip.textContent = dev.status;
  chip.className = `status-chip ${running ? "running" : ""}`;

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
    wrap.innerHTML = '<div class="empty">All dependencies are up to date. ✓</div>';
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
    s.textContent = "No known vulnerabilities ✓";
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
      if (activeConsoleLane) setConsoleLane(activeConsoleLane);
      break;
    case "detection":
      state.detection = e.detection;
      renderProject();
      break;
    case "lane:start": {
      state.lanes[e.lane] = { id: e.lane, label: e.label, status: "running", output: "" };
      if (isConsoleLane(e.lane)) {
        setConsoleLane(e.lane);
        showTab("console");
      } else if (e.lane === "test") {
        showTab("tests");
      }
      renderConsoleStatus();
      break;
    }
    case "lane:data": {
      const lane = (state.lanes[e.lane] = state.lanes[e.lane] || { id: e.lane, output: "" });
      lane.output = (lane.output || "") + e.chunk;
      if (e.lane === activeConsoleLane) {
        const c = $("#console");
        c.textContent += strip(e.chunk);
        c.scrollTop = c.scrollHeight;
      }
      break;
    }
    case "lane:end": {
      const lane = (state.lanes[e.lane] = state.lanes[e.lane] || { id: e.lane });
      lane.status = e.status;
      lane.exitCode = e.exitCode;
      if (e.lane === activeConsoleLane) renderConsoleStatus();
      if (e.lane === "test") renderTests();
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
      renderUpdate();
      break;
    case "deps:update-log":
      (state.deps.update = state.deps.update || { log: [] }).log.push(e.chunk);
      renderUpdate();
      break;
    case "deps:update-done":
      Object.assign((state.deps.update = state.deps.update || { log: [] }), {
        status: "done",
        kept: e.kept,
        failed: e.failed,
        fixAvailable: e.fixAvailable,
      });
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

document.querySelectorAll(".lane-btn[data-lane]").forEach((b) => {
  b.addEventListener("click", () => api("/api/lane", { id: b.dataset.lane }));
});
$("#test-btn").addEventListener("click", () => api("/api/test", {}));
$("#refresh").addEventListener("click", () => api("/api/refresh", {}));
$("#scripts").addEventListener("change", (e) => {
  const name = e.target.value;
  if (name) api("/api/script", { name });
  e.target.value = "";
});
$("#console-fix").addEventListener("click", (e) =>
  api("/api/fix", { lane: e.target.dataset.lane }),
);
$("#test-fix").addEventListener("click", () => api("/api/fix", { lane: "test" }));
$("#test-raw-toggle").addEventListener("click", () => $("#test-raw").classList.toggle("hidden"));

$("#dev-start").addEventListener("click", () => api("/api/dev/start", {}));
$("#dev-stop").addEventListener("click", () => api("/api/dev/stop", {}));
$("#dev-reload").addEventListener("click", () => {
  const p = $("#dev-preview");
  if (p.src) p.src = p.src;
});

$("#deps-check").addEventListener("click", () => api("/api/deps/outdated", {}));
$("#deps-audit").addEventListener("click", () => api("/api/deps/audit", {}));
$("#deps-update").addEventListener("click", () =>
  api("/api/deps/update", { scope: $("#deps-scope").value }),
);
$("#deps-fix").addEventListener("click", () => api("/api/deps/fix", {}));

connect();

"use strict";

/* ------------------------------------------------------------------ *
 * Freshdesk Stats — static dashboard
 *
 * Talks to the Freshdesk API *through* the Cloudflare Worker proxy
 * (Freshdesk itself sends no CORS headers, so a browser can't call it
 * directly). The API key + domain live only in this browser's
 * localStorage and ride along in each request; nothing is stored server
 * side.
 * ------------------------------------------------------------------ */

const DEFAULT_PROXY = "https://freshdesk-proxy.spades09.workers.dev";

const LS = {
  domain: "fd_domain",
  apiKey: "fd_apikey",
  proxy: "fd_proxy",
  agentMap: "fd_agentmap",   // { "<agentId>": "Name", ... }
  seenAgents: "fd_seen_agents", // [<agentId>, ...] observed in the last load
};

const STATUS_MAP = { 2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed" };
const PRIORITY_MAP = { 1: "Low", 2: "Medium", 3: "High", 4: "Urgent" };
const SOURCE_MAP = {
  1: "Email", 2: "Portal", 3: "Phone", 5: "Twitter", 6: "Facebook",
  7: "Chat", 8: "MobiHelp", 9: "Feedback Widget", 10: "Outbound Email",
  11: "Ecommerce", 12: "Bot", 13: "Whatsapp",
};

const PALETTE = ["#4f8cff", "#7c5cff", "#35c07f", "#f0b43f", "#f45b6b",
  "#3fd0d4", "#c46bff", "#ff9f5b", "#6bd08a", "#9aa3b2"];

// Distinct color per index — palette first, then spread hues by golden angle.
function colorFor(i) {
  if (i < PALETTE.length) return PALETTE[i];
  const hue = Math.round((i * 137.508) % 360);
  return `hsl(${hue} 65% 62%)`;
}

/* ---------- small DOM helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/* ---------- settings ---------- */
function getSettings() {
  return {
    domain: localStorage.getItem(LS.domain) || "",
    apiKey: localStorage.getItem(LS.apiKey) || "",
    proxy: (localStorage.getItem(LS.proxy) || DEFAULT_PROXY).replace(/\/+$/, ""),
  };
}
function hasCredentials() {
  const s = getSettings();
  return Boolean(s.domain && s.apiKey);
}
// Manual agent-ID → name overrides (used when the API can't list agents).
function getAgentMap() {
  try { return JSON.parse(localStorage.getItem(LS.agentMap) || "{}"); }
  catch { return {}; }
}

// Accept "acme", "acme.freshdesk.com", or a full URL — return the bare label.
function normalizeDomain(raw) {
  let d = (raw || "").trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  d = d.replace(/\.freshdesk\.com$/, "");
  return d;
}

/* ---------- proxy API client ---------- */
function authHeader(apiKey) {
  // Freshdesk basic auth: username = API key, password = "X".
  return "Basic " + btoa(apiKey + ":X");
}

// Fetch one Freshdesk API path through the proxy. Retries once on 429.
async function fdFetch(path) {
  const s = getSettings();
  const url = s.proxy + path;
  const headers = {
    "Authorization": authHeader(s.apiKey),
    "X-Freshdesk-Domain": s.domain,
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      const wait = parseInt(res.headers.get("Retry-After") || "5", 10);
      await sleep((wait + 1) * 1000);
      continue;
    }
    if (res.status === 401) throw new ApiError("Invalid API key (401). Check the key in Settings.", res.status);
    if (res.status === 403) {
      // Distinguish the Worker's own origin rejection from a Freshdesk
      // permission denial (both are 403, but they mean very different things).
      const body = await res.text().catch(() => "");
      if (body.includes("Forbidden origin")) {
        throw new ApiError("Proxy blocked this site's origin (403) — add the site URL to the Worker's allowlist.", 403);
      }
      throw new ApiError("Freshdesk denied access to this endpoint (403) — this API key's agent lacks permission for it (an admin key is usually required).", 403);
    }
    if (res.status === 404) throw new ApiError("Not found (404). Check the Freshdesk domain in Settings.", res.status);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(`Request failed (${res.status}). ${body.slice(0, 160)}`, res.status);
    }
    return res.json();
  }
  throw new ApiError("Rate limited by Freshdesk (429). Try a smaller window or wait a minute.", 429);
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Page through a list endpoint. Stops when a page is short or the cap is hit. */
async function fetchPaged(basePath, { perPage = 100, maxPages = 50, onProgress } = {}) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = basePath.includes("?") ? "&" : "?";
    const batch = await fdFetch(`${basePath}${sep}per_page=${perPage}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (onProgress) onProgress(all.length, page);
    if (batch.length < perPage) break;
    if (page === maxPages) all.capped = true;
  }
  return all;
}

async function fetchTickets(windowDays, onProgress) {
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();
  const path = `/api/v2/tickets?updated_since=${encodeURIComponent(since)}&include=stats&order_by=updated_at&order_type=asc`;
  return fetchPaged(path, { onProgress });
}
async function fetchGroups() {
  return fetchPaged("/api/v2/groups", { maxPages: 10 });
}
async function fetchAgents() {
  return fetchPaged("/api/v2/agents", { maxPages: 20 });
}

/* ---------- aggregation ---------- */
function countBy(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// Build a list of the last `windowDays` calendar days as YYYY-MM-DD (UTC).
function dayRange(windowDays) {
  const days = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

// Tickets each agent resolved, per day — one dataset (line) per agent.
function agentDailyResolved(tickets, agentName, windowDays) {
  const days = dayRange(windowDays);
  const inRange = new Set(days);
  const counts = new Map(); // responder_id -> Map(day -> count)
  const totals = new Map(); // responder_id -> total resolved in window

  for (const t of tickets) {
    const st = t.stats || {};
    const iso = st.resolved_at || st.closed_at; // the day the ticket was "done"
    if (!iso || !t.responder_id) continue;
    const day = iso.slice(0, 10);
    if (!inRange.has(day)) continue; // resolved outside the window
    if (!counts.has(t.responder_id)) counts.set(t.responder_id, new Map());
    const m = counts.get(t.responder_id);
    m.set(day, (m.get(day) || 0) + 1);
    totals.set(t.responder_id, (totals.get(t.responder_id) || 0) + 1);
  }

  const MAX_LINES = 12;
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  let unnamed = 0;
  const datasets = ranked.slice(0, MAX_LINES).map(([aid], i) => {
    const m = counts.get(aid);
    const color = colorFor(i);
    const name = agentName.get(aid);
    if (name == null) unnamed++;
    return {
      label: name || `Agent ${aid}`,
      data: days.map((d) => m.get(d) || 0),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: 2,
      tension: 0.25,
    };
  });

  return { labels: days, datasets, agentCount: ranked.length, shown: datasets.length, unnamed };
}

// Average tickets resolved per week, per agent (bar chart data).
function agentWeeklyAvg(tickets, agentName, windowDays) {
  const inRange = new Set(dayRange(windowDays));
  const totals = new Map(); // responder_id -> resolved count in window
  for (const t of tickets) {
    const st = t.stats || {};
    const iso = st.resolved_at || st.closed_at;
    if (!iso || !t.responder_id) continue;
    if (!inRange.has(iso.slice(0, 10))) continue;
    totals.set(t.responder_id, (totals.get(t.responder_id) || 0) + 1);
  }
  const weeks = Math.max(windowDays / 7, 1);
  const ranked = [...totals.entries()]
    .map(([id, n]) => ({ id, avg: Math.round((n / weeks) * 10) / 10 }))
    .sort((a, b) => b.avg - a.avg);
  return {
    labels: ranked.map((a) => agentName.get(a.id) || `Agent ${a.id}`),
    data: ranked.map((a) => a.avg),
  };
}

function aggregate(tickets, groups, agents, windowDays) {
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const agentName = new Map(agents.map((a) => [a.id, (a.contact && a.contact.name) || a.name]));
  // Manual overrides win — this is how names appear when the API can't list agents.
  for (const [id, name] of Object.entries(getAgentMap())) {
    if (name) agentName.set(Number(id), name);
  }

  const byStatus = countBy(tickets, (t) => STATUS_MAP[t.status] || `Status ${t.status}`);
  const byPriority = countBy(tickets, (t) => PRIORITY_MAP[t.priority] || `P${t.priority}`);
  const bySource = countBy(tickets, (t) => SOURCE_MAP[t.source] || `Source ${t.source}`);
  const byGroup = countBy(tickets, (t) => (t.group_id ? (groupName.get(t.group_id) || `Group ${t.group_id}`) : "Unassigned"));
  const byAgent = countBy(tickets, (t) => (t.responder_id ? (agentName.get(t.responder_id) || `Agent ${t.responder_id}`) : "Unassigned"));

  // Tickets created per day, within the window.
  const perDay = new Map();
  for (const t of tickets) {
    const day = (t.created_at || "").slice(0, 10);
    if (day) perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const days = [...perDay.keys()].sort();

  const statusCount = (name) => byStatus.get(name) || 0;

  // Distinct agent IDs seen as responders, most active first — used to
  // pre-fill the manual name map in Settings.
  const seenById = countBy(tickets.filter((t) => t.responder_id), (t) => t.responder_id);
  const agentsSeen = [...seenById.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

  return {
    total: tickets.length,
    capped: Boolean(tickets.capped),
    agentsSeen,
    kpis: {
      total: tickets.length,
      open: statusCount("Open"),
      pending: statusCount("Pending"),
      resolved: statusCount("Resolved"),
      closed: statusCount("Closed"),
    },
    byStatus, byPriority, bySource, byGroup, byAgent,
    volume: { labels: days, data: days.map((d) => perDay.get(d)) },
    agentDaily: agentDailyResolved(tickets, agentName, windowDays),
    agentWeekly: agentWeeklyAvg(tickets, agentName, windowDays),
  };
}

/* ---------- rendering ---------- */
const charts = {};
function drawChart(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($("#" + id), config);
}
const commonOpts = {
  responsive: true,
  plugins: { legend: { labels: { color: "#9aa3b2" } } },
};
const axisOpts = {
  x: { ticks: { color: "#9aa3b2" }, grid: { color: "#2a2f3a" } },
  y: { ticks: { color: "#9aa3b2" }, grid: { color: "#2a2f3a" }, beginAtZero: true },
};

function renderKpis(k) {
  const grid = $("#kpis");
  grid.innerHTML = "";
  const cards = [
    ["Total tickets", k.total, ""],
    ["Open", k.open, "accent-open"],
    ["Pending", k.pending, "accent-pending"],
    ["Resolved", k.resolved, "accent-resolved"],
    ["Closed", k.closed, "accent-closed"],
  ];
  for (const [label, value, cls] of cards) {
    const card = el("div", "kpi");
    card.appendChild(el("div", "kpi-value " + cls, String(value)));
    card.appendChild(el("div", "kpi-label", label));
    grid.appendChild(card);
  }
}

function mapToArrays(map, order) {
  const entries = order
    ? order.filter((k) => map.has(k)).map((k) => [k, map.get(k)])
    : [...map.entries()];
  return { labels: entries.map((e) => e[0]), data: entries.map((e) => e[1]) };
}

function renderCharts(agg) {
  drawChart("chartAgentDaily", {
    type: "line",
    data: { labels: agg.agentDaily.labels, datasets: agg.agentDaily.datasets },
    options: {
      ...commonOpts,
      interaction: { mode: "index", intersect: false },
      scales: axisOpts,
    },
  });

  drawChart("chartAgentWeekly", {
    type: "bar",
    data: {
      labels: agg.agentWeekly.labels,
      datasets: [{ label: "Avg / week", data: agg.agentWeekly.data, backgroundColor: "#4f8cff" }],
    },
    options: { ...commonOpts, indexAxis: "y", plugins: { legend: { display: false } }, scales: axisOpts },
  });

  const status = mapToArrays(agg.byStatus, ["Open", "Pending", "Resolved", "Closed"]);
  drawChart("chartStatus", {
    type: "doughnut",
    data: { labels: status.labels, datasets: [{ data: status.data, backgroundColor: PALETTE, borderColor: "#1b1f28" }] },
    options: commonOpts,
  });

  const prio = mapToArrays(agg.byPriority, ["Low", "Medium", "High", "Urgent"]);
  drawChart("chartPriority", {
    type: "bar",
    data: { labels: prio.labels, datasets: [{ data: prio.data, backgroundColor: PALETTE }] },
    options: { ...commonOpts, plugins: { legend: { display: false } }, scales: axisOpts },
  });

  drawChart("chartVolume", {
    type: "line",
    data: { labels: agg.volume.labels, datasets: [{ label: "Created", data: agg.volume.data, borderColor: "#4f8cff", backgroundColor: "rgba(79,140,255,0.15)", fill: true, tension: 0.25 }] },
    options: { ...commonOpts, plugins: { legend: { display: false } }, scales: axisOpts },
  });

  const src = mapToArrays(agg.bySource);
  drawChart("chartSource", {
    type: "doughnut",
    data: { labels: src.labels, datasets: [{ data: src.data, backgroundColor: PALETTE, borderColor: "#1b1f28" }] },
    options: commonOpts,
  });

  const groups = topN(agg.byGroup, 8);
  drawChart("chartGroups", {
    type: "bar",
    data: { labels: groups.map((g) => g[0]), datasets: [{ data: groups.map((g) => g[1]), backgroundColor: "#7c5cff" }] },
    options: { ...commonOpts, indexAxis: "y", plugins: { legend: { display: false } }, scales: axisOpts },
  });

  const agents = topN(agg.byAgent, 10);
  drawChart("chartAgents", {
    type: "bar",
    data: { labels: agents.map((a) => a[0]), datasets: [{ data: agents.map((a) => a[1]), backgroundColor: "#35c07f" }] },
    options: { ...commonOpts, indexAxis: "y", plugins: { legend: { display: false } }, scales: axisOpts },
  });
}

/* ---------- status messages ---------- */
function showStatus(msg, kind = "info") {
  const bar = $("#statusBar");
  bar.textContent = msg;
  bar.className = "status-bar " + kind;
}
function clearStatus() { $("#statusBar").className = "status-bar hidden"; }

/* ---------- main load flow ---------- */
let loading = false;
async function loadDashboard() {
  if (loading) return;
  if (!hasCredentials()) { showEmptyState(); return; }
  loading = true;
  $("#emptyState").classList.add("hidden");
  $("#dashboard").classList.remove("hidden");

  const windowDays = parseInt($("#rangeSelect").value, 10);
  const s = getSettings();
  $("#domainBadge").textContent = s.domain + ".freshdesk.com";
  $("#domainBadge").classList.remove("hidden");

  try {
    showStatus("Loading tickets…", "info");

    // Groups and agents are used to label IDs. They may require higher
    // permissions than tickets, so load them tolerantly and report failures
    // instead of silently showing raw IDs.
    let groups = [], agents = [], agentsApiFailed = false;
    const warnings = [];
    const [gRes, aRes] = await Promise.allSettled([fetchGroups(), fetchAgents()]);
    if (gRes.status === "fulfilled") groups = gRes.value;
    else warnings.push(`group names unavailable (${gRes.reason.message})`);
    if (aRes.status === "fulfilled") agents = aRes.value;
    else agentsApiFailed = true;

    const tickets = await fetchTickets(windowDays, (n) => showStatus(`Loaded ${n} tickets…`, "info"));

    const agg = aggregate(tickets, groups, agents, windowDays);
    renderKpis(agg.kpis);
    renderCharts(agg);

    // Remember the agent IDs that showed up, so Settings can pre-fill them.
    localStorage.setItem(LS.seenAgents, JSON.stringify(agg.agentsSeen));

    if (tickets.length === 0) {
      showStatus(`No tickets updated in the last ${windowDays} days.`, "info");
      return;
    }

    let msg = `Showing ${agg.total} tickets updated in the last ${windowDays} days.`;
    const ad = agg.agentDaily;
    if (ad.agentCount > ad.shown) msg += ` Agent chart shows the top ${ad.shown} of ${ad.agentCount} agents.`;
    if (agg.capped) msg += " Capped at the fetch limit — narrow the window for full accuracy.";
    if (ad.unnamed > 0) {
      warnings.push(`${ad.unnamed} agent(s) show IDs${agentsApiFailed ? " (this key can't list agents)" : ""} — set names in Settings → Agent names`);
    }

    if (warnings.length) {
      showStatus(`${msg}  ⚠ ${warnings.join("; ")}.`, "info");
    } else {
      showStatus(msg, "success");
      setTimeout(() => clearStatus(), 4000);
    }
  } catch (err) {
    showStatus(err.message || "Something went wrong loading data.", "error");
  } finally {
    loading = false;
  }
}

function showEmptyState() {
  $("#dashboard").classList.add("hidden");
  $("#emptyState").classList.remove("hidden");
  $("#domainBadge").classList.add("hidden");
}

/* ---------- settings modal ---------- */
function openSettings() {
  const s = getSettings();
  $("#domainInput").value = s.domain;
  $("#apiKeyInput").value = s.apiKey;
  $("#proxyInput").value = s.proxy === DEFAULT_PROXY ? "" : s.proxy;
  $("#testResult").className = "test-result hidden";
  buildAgentMapRows();
  $("#settingsModal").classList.remove("hidden");
}
function closeSettings() { $("#settingsModal").classList.add("hidden"); }

/* ---------- manual agent name map ---------- */
function addAgentMapRow(id = "", name = "") {
  const row = el("div", "agent-map-row");
  const idIn = el("input", "am-id");
  idIn.placeholder = "Agent ID"; idIn.value = id; idIn.setAttribute("inputmode", "numeric");
  const nameIn = el("input", "am-name");
  nameIn.placeholder = "Name"; nameIn.value = name;
  row.appendChild(idIn);
  row.appendChild(nameIn);
  $("#agentMapRows").appendChild(row);
}
function buildAgentMapRows() {
  const container = $("#agentMapRows");
  container.innerHTML = "";
  const map = getAgentMap();
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(LS.seenAgents) || "[]"); } catch { seen = []; }
  // Show every ID we've seen plus any already mapped, seen-first.
  const ids = [...new Set([...seen.map(String), ...Object.keys(map)])];
  if (ids.length === 0) { addAgentMapRow(); return; }
  for (const id of ids) addAgentMapRow(id, map[id] || "");
}
function readAgentMap() {
  const map = {};
  for (const row of document.querySelectorAll("#agentMapRows .agent-map-row")) {
    const id = row.querySelector(".am-id").value.trim();
    const name = row.querySelector(".am-name").value.trim();
    if (id && name) map[id] = name;
  }
  return map;
}

function readSettingsForm() {
  return {
    domain: normalizeDomain($("#domainInput").value),
    apiKey: $("#apiKeyInput").value.trim(),
    proxy: ($("#proxyInput").value.trim() || DEFAULT_PROXY).replace(/\/+$/, ""),
  };
}
function persist(form) {
  localStorage.setItem(LS.domain, form.domain);
  localStorage.setItem(LS.apiKey, form.apiKey);
  localStorage.setItem(LS.proxy, form.proxy);
}

async function testConnection() {
  const form = readSettingsForm();
  const box = $("#testResult");
  if (!form.domain || !form.apiKey) {
    box.className = "test-result bad";
    box.textContent = "Enter both a domain and an API key first.";
    return;
  }
  box.className = "test-result";
  box.textContent = "Testing…";
  // Persist temporarily so fdFetch uses these values.
  const prev = getSettings();
  persist(form);
  try {
    await fdFetch("/api/v2/tickets?per_page=1");
    box.className = "test-result ok";
    box.textContent = "✓ Connected — key and domain look good.";
  } catch (err) {
    persist(prev); // roll back on failure
    box.className = "test-result bad";
    box.textContent = "✗ " + (err.message || "Connection failed.");
  }
}

/* ---------- wire up ---------- */
function init() {
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#emptyConnectBtn").addEventListener("click", openSettings);
  $("#closeSettings").addEventListener("click", closeSettings);
  $("#settingsModal").addEventListener("click", (e) => { if (e.target.id === "settingsModal") closeSettings(); });
  $("#testBtn").addEventListener("click", testConnection);
  $("#toggleKey").addEventListener("click", () => {
    const inp = $("#apiKeyInput");
    inp.type = inp.type === "password" ? "text" : "password";
  });
  $("#addAgentRow").addEventListener("click", () => addAgentMapRow());
  $("#saveBtn").addEventListener("click", () => {
    const form = readSettingsForm();
    if (!form.domain || !form.apiKey) {
      const box = $("#testResult");
      box.className = "test-result bad";
      box.textContent = "Enter both a domain and an API key.";
      return;
    }
    persist(form);
    localStorage.setItem(LS.agentMap, JSON.stringify(readAgentMap()));
    closeSettings();
    loadDashboard();
  });
  $("#refreshBtn").addEventListener("click", loadDashboard);
  $("#rangeSelect").addEventListener("change", () => { if (hasCredentials()) loadDashboard(); });

  if (hasCredentials()) loadDashboard();
  else showEmptyState();
}

document.addEventListener("DOMContentLoaded", init);

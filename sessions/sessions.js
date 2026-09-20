"use strict";

// Focus Space — the sessions page. Opened in a tab from the legend's "Sessions"
// button as chrome://sine/content/focus-space/sessions/sessions.html, so it runs
// in the parent process with system privileges and works on the same prefs as
// the mod: it reads and writes the session store directly (every window's bar
// repaints via its own pref observer) and reaches the space list through the
// browser window. It has no access to the mod's module scope, so the few data
// helpers it needs are mirrored here — keep them in step with focus-space.uc.mjs.
//
// Two views, picked by the URL fragment (#sessions / #pages):
//   - Sessions: the editable space-session log, grouped by day.
//   - Pages: the optional page log (visits: URL + tab title + start/end), read
//     from the per-day files the mod appends to, in one of several groupings
//     and paginated, since months of browsing add up.

const PREF_SESSIONS = "extensions.focus-space.sessions";
const PREF_DAY_START = "extensions.focus-space.day-start-hour";
const PREF_WEEK_START = "extensions.focus-space.week-start";
const PREF_LOG_PAGES = "extensions.focus-space.log-pages";
const PREF_OPEN_VISITS = "extensions.focus-space.open-visits";
const PREF_VISITS_VERSION = "extensions.focus-space.visits-version";
const VISITS_DIR_PARTS = ["focus-space", "visits"];
const RETENTION_DAYS = 90;
const DEFAULT_DAY_START = 4;
const PERIODS = ["today", "week", "month", "all"];
const VIEWS = ["sessions", "pages"];
const GROUPINGS = ["visits", "stays", "urls"];
// Rows per page in the Pages view. A page of rows renders in a blink; the
// cost of a big log is in reading and grouping it, which happens once per
// load, not per page.
const PAGE_SIZE = 100;
const FALLBACK_PALETTE = [
  "#7F77DD",
  "#1D9E75",
  "#D85A30",
  "#378ADD",
  "#EF9F27",
  "#D4537E",
  "#639922",
  "#888780",
];

let dayStartHour = DEFAULT_DAY_START;
let weekStartDow = 1;
let view = "sessions";
let period = "today";
let spaceFilter = "";
let sessions = [];

// --- Pages state --------------------------------------------------------------
let grouping = "visits";
let search = "";
let pageIndex = 0;
// Every visit from the day files covering the loaded period, plus the running
// ones from the pref; filtered and grouped at render time.
let visits = [];
let visitsLoadedFor = null; // the period `visits` was loaded for
let visitsLoadSeq = 0; // discards a load that a newer one overtook
let visitsRefreshTimer = null;
let searchTimer = null;
const expandedRows = new Set();

// --- helpers mirrored from the mod -------------------------------------------
function pad2(n) {
  return n.toString().padStart(2, "0");
}

function dayKeyFor(date) {
  const d = new Date(date);
  if (d.getHours() < dayStartHour) {
    d.setDate(d.getDate() - 1);
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayKey() {
  return dayKeyFor(new Date());
}

function cutoffKey() {
  return dayKeyFor(new Date(Date.now() - RETENTION_DAYS * 86400000));
}

function periodStartKey(which) {
  const today = todayKey();
  if (which === "today") {
    return today;
  }
  if (which === "all") {
    return "";
  }
  const [y, m, d] = today.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (which === "month") {
    date.setDate(1);
  } else {
    const diff = (date.getDay() - weekStartDow + 7) % 7;
    date.setDate(date.getDate() - diff);
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function prevDayKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d - 1, 12, 0, 0);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatLocal(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function formatClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatShort(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}

function sameCalendarDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

const LOCAL_TIME_RE =
  /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/;

function parseLocal(str) {
  const m = LOCAL_TIME_RE.exec(str);
  if (!m) {
    return NaN;
  }
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isNaN(d.getTime()) ? NaN : d.getTime();
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${hrs}h ${pad2(mins)}m`;
  }
  if (mins > 0) {
    return `${mins}m ${pad2(secs)}s`;
  }
  return `${secs}s`;
}

function formatDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const label = date.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return key === todayKey() ? `Today — ${label}` : label;
}

function plural(n, noun) {
  return `${n.toLocaleString()} ${noun}${n === 1 ? "" : "s"}`;
}

function spaceColor(workspace, index) {
  const colors = workspace && workspace.theme && workspace.theme.gradientColors;
  if (Array.isArray(colors) && colors.length) {
    const dot =
      colors.find((color) => color && color.isPrimary) ||
      colors[Math.floor(colors.length / 2)];
    const c = dot && dot.c;
    if (Array.isArray(c) && c.length >= 3) {
      return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
    }
    if (typeof c === "string" && c) {
      return c;
    }
  }
  return FALLBACK_PALETTE[index % FALLBACK_PALETTE.length];
}

function legendName(workspace) {
  const icon = workspace.icon;
  if (icon && icon !== "" && !icon.endsWith(".svg")) {
    return `${icon}  ${workspace.name}`;
  }
  return workspace.name;
}

function readSessions() {
  try {
    const raw = Services.prefs.getStringPref(PREF_SESSIONS, "");
    const list = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) {
      return [];
    }
    return list.filter(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.uuid === "string" &&
        Number.isFinite(item.start) &&
        Number.isFinite(item.end),
    );
  } catch {
    return [];
  }
}

function writeSessions(list) {
  try {
    Services.prefs.setStringPref(PREF_SESSIONS, JSON.stringify(list));
  } catch {}
}

function pruneSessions(list) {
  const cutoff = cutoffKey();
  return list.filter((session) => dayKeyFor(session.start) >= cutoff);
}

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function updateSessions(mutate) {
  const list = readSessions();
  const next = mutate(list) || list;
  writeSessions(pruneSessions(next));
}

function readDayStartHour() {
  let hour = DEFAULT_DAY_START;
  try {
    const type = Services.prefs.getPrefType(PREF_DAY_START);
    if (type === 64) {
      hour = Services.prefs.getIntPref(PREF_DAY_START, DEFAULT_DAY_START);
    } else if (type === 32) {
      hour = parseInt(Services.prefs.getStringPref(PREF_DAY_START, ""), 10);
    }
  } catch {}
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    hour = DEFAULT_DAY_START;
  }
  return hour;
}

function readWeekStartPref() {
  try {
    const type = Services.prefs.getPrefType(PREF_WEEK_START);
    if (type === 64) {
      return String(Services.prefs.getIntPref(PREF_WEEK_START, 0));
    }
    if (type === 32) {
      return Services.prefs.getStringPref(PREF_WEEK_START, "auto");
    }
  } catch {}
  return "auto";
}

function resolveWeekStartDow(pref) {
  if (pref !== "auto") {
    const n = parseInt(pref, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 6) {
      return n;
    }
  }
  try {
    const locale = new Intl.Locale(Services.locale.appLocaleAsBCP47);
    const info =
      typeof locale.getWeekInfo === "function"
        ? locale.getWeekInfo()
        : locale.weekInfo;
    const firstDay = info && info.firstDay;
    if (firstDay === 7) {
      return 0;
    }
    if (Number.isInteger(firstDay) && firstDay >= 1 && firstDay <= 6) {
      return firstDay;
    }
  } catch {}
  return 1;
}

function readLogPagesPref() {
  try {
    return Services.prefs.getBoolPref(PREF_LOG_PAGES, false);
  } catch {
    return false;
  }
}

function csvField(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// --- spaces ------------------------------------------------------------------
function browserWindow() {
  return Services.wm.getMostRecentWindow("navigator:browser");
}

function spacesById() {
  let spaces;
  try {
    spaces = browserWindow().gZenWorkspaces.getWorkspaces();
  } catch {
    spaces = [];
  }
  const map = new Map();
  spaces.forEach((workspace, index) => {
    map.set(workspace.uuid, { workspace, index });
  });
  return map;
}

function activeSpaceUuid() {
  try {
    return browserWindow().gZenWorkspaces.activeWorkspace || null;
  } catch {
    return null;
  }
}

function colorFor(uuid, byId) {
  const entry = byId.get(uuid);
  return entry
    ? spaceColor(entry.workspace, entry.index)
    : FALLBACK_PALETTE[FALLBACK_PALETTE.length - 1];
}

// --- the visit store ---------------------------------------------------------
// Mirrors the writer in focus-space.uc.mjs: one JSONL file per day under the
// profile, keyed by the day the visit started on, plus the running visits in
// a pref. The page is the only reader.
function visitsDir() {
  return PathUtils.join(PathUtils.profileDir, ...VISITS_DIR_PARTS);
}

async function listVisitFiles() {
  let children;
  try {
    children = await IOUtils.getChildren(visitsDir(), { ignoreAbsent: true });
  } catch {
    return [];
  }
  const files = [];
  for (const path of children) {
    const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(PathUtils.filename(path));
    if (match) {
      files.push({ key: match[1], path });
    }
  }
  return files.sort((a, b) => (a.key < b.key ? -1 : 1));
}

function validVisit(item) {
  return (
    item &&
    typeof item.id === "string" &&
    typeof item.url === "string" &&
    Number.isFinite(item.start) &&
    Number.isFinite(item.end)
  );
}

// A file is append-only, so a torn last line (a crash mid-write) is skipped
// rather than failing the whole day.
async function readVisitFile(path, dayKey) {
  let text;
  try {
    text = await IOUtils.readUTF8(path);
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const visit = JSON.parse(line);
      if (validVisit(visit)) {
        visit.title = typeof visit.title === "string" ? visit.title : "";
        visit.uuid = typeof visit.uuid === "string" ? visit.uuid : "";
        visit.file = path;
        visit.day = dayKey;
        out.push(visit);
      }
    } catch {}
  }
  return out;
}

function readOpenVisits() {
  try {
    const raw = Services.prefs.getStringPref(PREF_OPEN_VISITS, "");
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter(validVisit).map((visit) => ({
          ...visit,
          title: typeof visit.title === "string" ? visit.title : "",
          uuid: typeof visit.uuid === "string" ? visit.uuid : "",
          open: true,
        }))
      : [];
  } catch {
    return [];
  }
}

function bumpVisitsVersion() {
  try {
    const n = Services.prefs.getIntPref(PREF_VISITS_VERSION, 0);
    Services.prefs.setIntPref(PREF_VISITS_VERSION, n >= 1e9 ? 1 : n + 1);
  } catch {}
}

// Load the visits for `which`, then repaint. A visit's file is named for the
// day-start hour in force when it was written; if that has changed since, it
// can sit one file off in either direction, so one extra day back is read as
// well and every visit is re-bucketed by dayKeyFor at render time.
//
// `incremental` (the live-update path) re-reads only the files new visits can
// land in — today's and, right after a rollover, yesterday's — and keeps the
// rest from memory, so a long "All" list isn't re-parsed every time a visit
// closes. Only used when the same period is already loaded.
async function loadVisits(which, incremental = false) {
  const seq = ++visitsLoadSeq;
  const startKey = periodStartKey(which);
  const recentKey = prevDayKey(todayKey());
  const partial = incremental && visitsLoadedFor === which;
  const files = (await listVisitFiles()).filter(
    (file) =>
      (which === "all" || file.key >= prevDayKey(startKey)) &&
      (!partial || file.key >= recentKey),
  );
  // Running visits first, so a file's (closed, final) copy of an id wins.
  const byId = new Map(readOpenVisits().map((visit) => [visit.id, visit]));
  for (const file of files) {
    for (const visit of await readVisitFile(file.path, file.key)) {
      byId.set(visit.id, visit);
    }
  }
  if (seq !== visitsLoadSeq) {
    return;
  }
  const next = [...byId.values()];
  if (partial) {
    for (const visit of visits) {
      if (!visit.open && visit.day < recentKey && !byId.has(visit.id)) {
        next.push(visit);
      }
    }
  }
  visits = next;
  visitsLoadedFor = which;
  if (view === "pages") {
    renderPages();
  }
}

function scheduleVisitsRefresh(delay, incremental) {
  clearTimeout(visitsRefreshTimer);
  visitsRefreshTimer = setTimeout(() => {
    visitsRefreshTimer = null;
    if (view === "pages") {
      loadVisits(period, incremental);
    } else {
      visitsLoadedFor = null; // reload when the view is next shown
    }
  }, delay);
}

// Remove visits by id from their files. Each file is re-read just before it
// is rewritten so a line a window appended since the page loaded isn't lost
// (the window for that is small — appends land every ~10 s, only in today's
// file — and there is no cheaper way to edit an append-only log). Running
// visits live in the pref and would be re-upserted, so they're skipped.
async function deleteVisits(ids) {
  const idSet = new Set(ids);
  const files = new Set();
  for (const visit of visits) {
    if (idSet.has(visit.id) && visit.file) {
      files.add(visit.file);
    }
  }
  for (const path of files) {
    let text;
    try {
      text = await IOUtils.readUTF8(path);
    } catch {
      continue;
    }
    const kept = text.split("\n").filter((line) => {
      if (!line) {
        return false;
      }
      try {
        return !idSet.has(JSON.parse(line).id);
      } catch {
        return true;
      }
    });
    try {
      if (kept.length) {
        await IOUtils.writeUTF8(path, kept.join("\n") + "\n");
      } else {
        await IOUtils.remove(path);
      }
    } catch (e) {
      console.error("[focus-space] could not rewrite the page log:", e);
    }
  }
  bumpVisitsVersion();
  scheduleVisitsRefresh(0, false);
}

function confirmDelete(count) {
  return Services.prompt.confirm(
    window,
    "Delete visits",
    `Delete ${plural(count, "visit")} from the page log? This can't be undone.`,
  );
}

// --- rendering ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      if (attrs[key] != null) {
        node.setAttribute(key, attrs[key]);
      }
    }
  }
  for (const child of children) {
    if (child != null) {
      node.append(child);
    }
  }
  return node;
}

// The header controls common to both views: the view tabs, the period, the
// space filter (rebuilt from the live space list, keeping the selection), and
// which of the view-specific controls are shown.
function renderChrome() {
  for (const btn of $("views").children) {
    btn.toggleAttribute("active", btn.dataset.view === view);
  }
  for (const btn of $("periods").children) {
    btn.toggleAttribute("active", btn.dataset.period === period);
  }
  for (const btn of $("groupings").children) {
    btn.toggleAttribute("active", btn.dataset.grouping === grouping);
  }

  const byId = spacesById();
  const filter = $("space-filter");
  const current = filter.value;
  filter.textContent = "";
  filter.append(el("option", { value: "" }, "All spaces"));
  for (const { workspace } of byId.values()) {
    filter.append(el("option", { value: workspace.uuid }, legendName(workspace)));
  }
  filter.value = byId.has(current) ? current : "";
  spaceFilter = filter.value;

  const pages = view === "pages";
  $("add").hidden = pages;
  $("search").hidden = !pages;
  $("clear").hidden = !pages;
  $("groupings").hidden = !pages;
  $("hint-sessions").hidden = pages;
  $("hint-pages").hidden = !pages;
  if (!pages) {
    $("notice").hidden = true;
    $("pager-top").hidden = true;
    $("pager-bottom").hidden = true;
  }
  return byId;
}

function render() {
  const byId = renderChrome();
  if (view === "pages") {
    renderPages(byId);
  } else {
    renderSessions(byId);
  }
}

// --- Sessions view -----------------------------------------------------------
function visibleSessions() {
  const startKey = periodStartKey(period);
  const today = todayKey();
  return sessions
    .filter((session) => {
      if (spaceFilter && session.uuid !== spaceFilter) {
        return false;
      }
      const key = dayKeyFor(session.start);
      return period === "all" || (key >= startKey && key <= today);
    })
    .sort((a, b) => b.start - a.start);
}

function sessionRow(session, byId) {
  const running = Boolean(session.open);
  const color = colorFor(session.uuid, byId);

  const select = el("select");
  let known = false;
  for (const { workspace } of byId.values()) {
    const opt = el("option", { value: workspace.uuid }, legendName(workspace));
    if (workspace.uuid === session.uuid) {
      opt.selected = true;
      known = true;
    }
    select.append(opt);
  }
  if (!known) {
    const opt = el("option", { value: session.uuid }, "Unknown space");
    opt.selected = true;
    select.append(opt);
  }
  const startInput = el("input", {
    type: "text",
    value: formatLocal(session.start),
    spellcheck: "false",
  });
  const endInput = el("input", {
    type: "text",
    value: running ? "running" : formatLocal(session.end),
    spellcheck: "false",
  });
  const durEl = el(
    "span",
    { class: "dur" },
    formatDuration((session.end - session.start) / 1000),
  );
  const delBtn = el(
    "button",
    { type: "button", class: "del", title: "Delete this session" },
    "✕",
  );

  // A running session belongs to a live window, which keeps extending its end;
  // only its start can be corrected (the window adopts that from the store).
  if (running) {
    select.disabled = true;
    endInput.disabled = true;
    delBtn.disabled = true;
    delBtn.title = "This session is still running";
  } else {
    select.addEventListener("change", () => {
      updateSessions((list) => {
        const target = list.find((item) => item.id === session.id);
        if (target) {
          target.uuid = select.value;
        }
      });
    });
    delBtn.addEventListener("click", () => {
      updateSessions((list) => list.filter((item) => item.id !== session.id));
      render();
    });
  }
  const commitTimes = () => {
    const start = parseLocal(startInput.value);
    const end = running ? Date.now() : parseLocal(endInput.value);
    const valid = !Number.isNaN(start) && !Number.isNaN(end) && end > start;
    startInput.toggleAttribute("invalid", Number.isNaN(start) || !valid);
    if (!running) {
      endInput.toggleAttribute("invalid", Number.isNaN(end) || !valid);
    }
    if (!valid) {
      return;
    }
    durEl.textContent = formatDuration((end - start) / 1000);
    updateSessions((list) => {
      const target = list.find((item) => item.id === session.id);
      if (target) {
        target.start = start;
        if (!running) {
          target.end = end;
        }
      }
    });
  };
  startInput.addEventListener("change", commitTimes);
  endInput.addEventListener("change", commitTimes);

  const row = el(
    "div",
    { class: "row", "data-id": session.id },
    el("span", { class: "space" }, el("span", { class: "swatch", style: `background:${color}` }), select),
    startInput,
    el("span", { class: "arrow" }, "→"),
    endInput,
    durEl,
    delBtn,
  );
  if (running) {
    row.setAttribute("running", "");
  }
  if (session.migrated) {
    row.title =
      "Converted from the pre-1.1 daily totals; its time of day is a guess";
  }
  return row;
}

function renderSessions(byId) {
  const list = visibleSessions();
  const days = new Map();
  let totalSeconds = 0;
  for (const session of list) {
    const key = dayKeyFor(session.start);
    if (!days.has(key)) {
      days.set(key, []);
    }
    days.get(key).push(session);
    totalSeconds += (session.end - session.start) / 1000;
  }

  const container = $("days");
  container.textContent = "";
  for (const [key, daySessions] of days) {
    let daySeconds = 0;
    for (const session of daySessions) {
      daySeconds += (session.end - session.start) / 1000;
    }
    const section = el(
      "section",
      null,
      el(
        "h2",
        null,
        formatDay(key),
        el("span", { class: "total" }, formatDuration(daySeconds)),
      ),
    );
    for (const session of daySessions) {
      section.append(sessionRow(session, byId));
    }
    container.append(section);
  }

  const empty = $("empty");
  empty.textContent = "No sessions in this period.";
  empty.hidden = list.length > 0;
  $("summary").textContent = list.length
    ? `${plural(list.length, "session")}, ${formatDuration(totalSeconds)} in total`
    : "";
}

// --- Pages view --------------------------------------------------------------
function filteredVisits() {
  const startKey = periodStartKey(period);
  const today = todayKey();
  const needle = search.trim().toLowerCase();
  return visits.filter((visit) => {
    if (spaceFilter && visit.uuid !== spaceFilter) {
      return false;
    }
    if (
      needle &&
      !visit.title.toLowerCase().includes(needle) &&
      !visit.url.toLowerCase().includes(needle)
    ) {
      return false;
    }
    if (period === "all") {
      return true;
    }
    const key = dayKeyFor(visit.start);
    return key >= startKey && key <= today;
  });
}

const byStartDesc = (a, b) => b.start - a.start;

// One displayed row over one or more visits (newest first). Its title, URL,
// and space come from the newest; its span from the oldest start to the
// latest end; its length is the visits' time added up, so gaps between them
// (pauses, time elsewhere) don't count.
function rowFrom(group, key) {
  const sorted = group.slice().sort(byStartDesc);
  const newest = sorted[0];
  let seconds = 0;
  let end = 0;
  let running = false;
  for (const visit of sorted) {
    seconds += (visit.end - visit.start) / 1000;
    end = Math.max(end, visit.end);
    running = running || Boolean(visit.open);
  }
  return {
    key,
    url: newest.url,
    title: newest.title,
    uuid: newest.uuid,
    start: sorted[sorted.length - 1].start,
    end,
    seconds,
    running,
    visits: sorted,
  };
}

// How the Pages view groups visits into rows. Each entry turns the filtered
// visits into display rows in display order; `dayHeaders` says whether the
// rows are chronological and should be sectioned by day. Adding a grouping
// is a new entry here plus a button in sessions.html.
const GROUPINGS_BY_KEY = {
  // Every visit on its own, newest first.
  visits: {
    noun: "visit",
    dayHeaders: true,
    build(list) {
      return list
        .slice()
        .sort(byStartDesc)
        .map((visit) => rowFrom([visit], visit.id));
    },
  },
  // Back-to-back visits to one URL fold into a row — the page stayed the same
  // through a pause or a day rollover — while a visit anywhere else in between
  // starts a new row.
  stays: {
    noun: "stay",
    dayHeaders: true,
    build(list) {
      const asc = list.slice().sort((a, b) => a.start - b.start);
      const groups = [];
      for (const visit of asc) {
        const last = groups[groups.length - 1];
        if (last && last[0].url === visit.url) {
          last.push(visit);
        } else {
          groups.push([visit]);
        }
      }
      return groups
        .map((group) => rowFrom(group, group[0].id))
        .sort(byStartDesc);
    },
  },
  // One row per URL across the whole period, most time first.
  urls: {
    noun: "page",
    dayHeaders: false,
    build(list) {
      const byUrl = new Map();
      for (const visit of list) {
        if (!byUrl.has(visit.url)) {
          byUrl.set(visit.url, []);
        }
        byUrl.get(visit.url).push(visit);
      }
      return [...byUrl.entries()]
        .map(([url, group]) => rowFrom(group, url))
        .sort((a, b) => b.seconds - a.seconds || b.end - a.end);
    },
  },
};

// Only URL kinds a click should load; a javascript: or data: URL in the log
// stays plain text.
const OPENABLE_URL_RE = /^(https?|file|about|moz-extension):/i;

function openUrl(url) {
  try {
    browserWindow().switchToTabHavingURI(url, true, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  } catch (e) {
    console.error("[focus-space] could not open the page:", e);
  }
}

function visitTimes(start, end, running, withDate) {
  if (withDate) {
    return [formatShort(start), running ? "running" : formatShort(end)];
  }
  const endText = running
    ? "running"
    : sameCalendarDay(start, end)
      ? formatClock(end)
      : formatLocal(end);
  return [formatClock(start), endText];
}

function pageCell(row, byId) {
  const titleText = row.title || row.url;
  const title = OPENABLE_URL_RE.test(row.url)
    ? el("a", { class: "title", href: "#", title: row.url }, titleText)
    : el("span", { class: "title", title: row.url }, titleText);
  if (title.tagName === "A") {
    title.addEventListener("click", (event) => {
      event.preventDefault();
      openUrl(row.url);
    });
  }
  return el(
    "span",
    { class: "page" },
    el("span", { class: "swatch", style: `background:${colorFor(row.uuid, byId)}` }),
    el("img", { class: "favicon", src: `page-icon:${row.url}`, alt: "" }),
    el(
      "span",
      { class: "page-text" },
      title,
      el("span", { class: "url" }, row.url),
    ),
  );
}

function deleteButton(count, running, onClick) {
  const btn = el(
    "button",
    {
      type: "button",
      class: "del",
      title: count === 1 ? "Delete this visit" : `Delete these ${count} visits`,
    },
    "✕",
  );
  if (running) {
    btn.disabled = true;
    btn.title = "This visit is still running";
  } else {
    btn.addEventListener("click", onClick);
  }
  return btn;
}

function visitRow(row, byId, withDate) {
  const [startText, endText] = visitTimes(
    row.start,
    row.end,
    row.running,
    withDate,
  );
  const count = row.visits.length;
  const closedIds = row.visits.filter((v) => !v.open).map((v) => v.id);
  const expanded = count > 1 && expandedRows.has(row.key);

  let countEl;
  if (count > 1) {
    countEl = el(
      "button",
      { type: "button", class: "chip", title: "Show each visit" },
      `${count} visits`,
    );
    countEl.toggleAttribute("open", expanded);
    countEl.addEventListener("click", () => {
      if (expandedRows.has(row.key)) {
        expandedRows.delete(row.key);
      } else {
        expandedRows.add(row.key);
      }
      renderPages();
    });
  } else {
    countEl = el("span");
  }

  const rowEl = el(
    "div",
    { class: "row vrow", "data-key": row.key },
    pageCell(row, byId),
    el("span", { class: "time" }, startText),
    el("span", { class: "arrow" }, "→"),
    el("span", { class: "time" }, endText),
    el("span", { class: "dur" }, formatDuration(row.seconds)),
    countEl,
    deleteButton(count, closedIds.length === 0, () => {
      if (closedIds.length > 1 && !confirmDelete(closedIds.length)) {
        return;
      }
      deleteVisits(closedIds);
    }),
  );
  if (row.running) {
    rowEl.setAttribute("running", "");
  }
  if (!expanded) {
    return [rowEl];
  }

  // The row's visits, one per line, each deletable on its own.
  const subEls = row.visits.map((visit) => {
    const running = Boolean(visit.open);
    const s = formatLocal(visit.start);
    const e = running ? "running" : formatLocal(visit.end);
    const sub = el(
      "div",
      { class: "row sub", "data-id": visit.id },
      el("span", { class: "sub-title", title: visit.url }, visit.title || visit.url),
      el("span", { class: "time" }, s),
      el("span", { class: "arrow" }, "→"),
      el("span", { class: "time" }, e),
      el("span", { class: "dur" }, formatDuration((visit.end - visit.start) / 1000)),
      el("span"),
      deleteButton(1, running, () => deleteVisits([visit.id])),
    );
    if (running) {
      sub.setAttribute("running", "");
    }
    return sub;
  });
  return [rowEl, ...subEls];
}

function renderPager(nav, total, pageCount) {
  nav.textContent = "";
  nav.hidden = pageCount <= 1;
  if (pageCount <= 1) {
    return;
  }
  const go = (index) => {
    pageIndex = Math.max(0, Math.min(pageCount - 1, index));
    renderPages();
    window.scrollTo(0, 0);
  };
  const prev = el("button", { type: "button", title: "Previous page" }, "‹");
  prev.disabled = pageIndex === 0;
  prev.addEventListener("click", () => go(pageIndex - 1));
  const next = el("button", { type: "button", title: "Next page" }, "›");
  next.disabled = pageIndex >= pageCount - 1;
  next.addEventListener("click", () => go(pageIndex + 1));
  const from = pageIndex * PAGE_SIZE + 1;
  const to = Math.min(total, (pageIndex + 1) * PAGE_SIZE);
  nav.append(
    prev,
    el(
      "span",
      { class: "range" },
      `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`,
    ),
    next,
  );
}

function renderPages(byId = spacesById()) {
  const container = $("days");
  const notice = $("notice");
  const empty = $("empty");

  notice.hidden = readLogPagesPref();
  notice.textContent =
    "Page logging is off. Turn on “Log the pages you visit” under Focus Space in Zen's Sine settings to start recording.";

  if (visitsLoadedFor !== period) {
    container.textContent = "";
    empty.hidden = true;
    $("summary").textContent = "Loading…";
    $("pager-top").hidden = true;
    $("pager-bottom").hidden = true;
    loadVisits(period);
    return;
  }

  const spec = GROUPINGS_BY_KEY[grouping];
  const list = filteredVisits();
  const rows = spec.build(list);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  pageIndex = Math.min(pageIndex, pageCount - 1);
  const slice = rows.slice(pageIndex * PAGE_SIZE, (pageIndex + 1) * PAGE_SIZE);

  // Day totals come from every row of the day, not just the ones on this page.
  let totalSeconds = 0;
  const dayTotals = new Map();
  for (const row of rows) {
    totalSeconds += row.seconds;
    if (spec.dayHeaders) {
      const key = dayKeyFor(row.start);
      dayTotals.set(key, (dayTotals.get(key) || 0) + row.seconds);
    }
  }

  container.textContent = "";
  let section = null;
  let sectionKey = null;
  for (const row of slice) {
    if (spec.dayHeaders) {
      const key = dayKeyFor(row.start);
      if (key !== sectionKey) {
        section = el(
          "section",
          null,
          el(
            "h2",
            null,
            formatDay(key),
            el("span", { class: "total" }, formatDuration(dayTotals.get(key))),
          ),
        );
        container.append(section);
        sectionKey = key;
      }
    } else if (!section) {
      section = el("section", { class: "flat" });
      container.append(section);
    }
    section.append(...visitRow(row, byId, !spec.dayHeaders));
  }

  empty.textContent = search.trim()
    ? "No visits match."
    : "No visits in this period.";
  empty.hidden = rows.length > 0;
  $("summary").textContent = rows.length
    ? `${plural(rows.length, spec.noun)}, ${formatDuration(totalSeconds)} in total` +
      (grouping === "visits" ? "" : ` (${plural(list.length, "visit")})`)
    : "";
  renderPager($("pager-top"), rows.length, pageCount);
  renderPager($("pager-bottom"), rows.length, pageCount);
}

function clearListed() {
  const ids = filteredVisits()
    .filter((visit) => !visit.open)
    .map((visit) => visit.id);
  if (!ids.length || !confirmDelete(ids.length)) {
    return;
  }
  deleteVisits(ids);
}

// --- actions -----------------------------------------------------------------
function addSession() {
  const byId = spacesById();
  let uuid = spaceFilter || activeSpaceUuid();
  if (!uuid || !byId.has(uuid)) {
    const first = byId.keys().next();
    uuid = first.done ? null : first.value;
  }
  if (!uuid) {
    return;
  }
  const end = Date.now();
  const start = end - 30 * 60000;
  const id = newSessionId();
  updateSessions((list) => {
    list.push({ id, uuid, start, end });
  });
  if (period !== "all" && dayKeyFor(start) < periodStartKey(period)) {
    period = "today";
  }
  render();
  const row = document.querySelector(`.row[data-id="${id}"]`);
  const field = row && row.querySelector("input");
  if (field) {
    field.focus();
    field.select();
  }
}

function saveText(text, filename, format) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker,
  );
  picker.init(window.browsingContext, "Export", Ci.nsIFilePicker.modeSave);
  picker.defaultString = filename;
  picker.defaultExtension = format;
  picker.appendFilter(format.toUpperCase(), `*.${format}`);
  picker.open((result) => {
    if (result === Ci.nsIFilePicker.returnCancel || !picker.file) {
      return;
    }
    IOUtils.writeUTF8(picker.file.path, text).catch((e) => {
      console.error("[focus-space] export failed:", e);
    });
  });
}

function serialize(rows, header, format) {
  if (format === "csv") {
    return (
      header.join(",") +
      "\n" +
      rows
        .map((row) => header.map((key) => csvField(row[key])).join(","))
        .join("\n") +
      "\n"
    );
  }
  return JSON.stringify(rows, null, 2) + "\n";
}

function exportSessions(format) {
  const byId = spacesById();
  const rows = visibleSessions()
    .slice()
    .reverse()
    .map((session) => {
      const entry = byId.get(session.uuid);
      return {
        id: session.id,
        space: entry ? legendName(entry.workspace) : "Unknown space",
        space_id: session.uuid,
        start: formatLocal(session.start),
        end: formatLocal(session.end),
        seconds: Math.round((session.end - session.start) / 1000),
        running: Boolean(session.open),
      };
    });
  const header = ["space", "space_id", "start", "end", "seconds", "running"];
  saveText(
    serialize(rows, header, format),
    `focus-sessions-${period}-${todayKey()}.${format}`,
    format,
  );
}

// Exports the rows as listed — so the grouping decides whether a line is a
// visit, a stay, or a URL's total — oldest first.
function exportPages(format) {
  const byId = spacesById();
  const spec = GROUPINGS_BY_KEY[grouping];
  const rows = spec
    .build(filteredVisits())
    .slice()
    .reverse()
    .map((row) => {
      const entry = byId.get(row.uuid);
      return {
        space: entry ? legendName(entry.workspace) : "Unknown space",
        space_id: row.uuid,
        title: row.title,
        url: row.url,
        start: formatLocal(row.start),
        end: formatLocal(row.end),
        seconds: Math.round(row.seconds),
        visits: row.visits.length,
        running: row.running,
      };
    });
  const header = [
    "space",
    "space_id",
    "title",
    "url",
    "start",
    "end",
    "seconds",
    "visits",
    "running",
  ];
  saveText(
    serialize(rows, header, format),
    `focus-pages-${grouping}-${period}-${todayKey()}.${format}`,
    format,
  );
}

// --- wiring ------------------------------------------------------------------
function reload() {
  dayStartHour = readDayStartHour();
  weekStartDow = resolveWeekStartDow(readWeekStartPref());
  sessions = readSessions();
}

function viewFromHash() {
  const hash = location.hash.replace(/^#/, "");
  return VIEWS.includes(hash) ? hash : "sessions";
}

function setView(next) {
  if (next === view) {
    return;
  }
  view = next;
  pageIndex = 0;
  if (viewFromHash() !== view) {
    history.replaceState(null, "", `#${view}`);
  }
  render();
}

// Any window's flush or edit repaints the page — but not out from under a
// field being edited here (a rebuild would drop its pending value). A change
// to the day-start hour also moves the day boundaries the visit files are
// read by, so those are reloaded.
function onStoreChanged(subject, topic, pref) {
  reload();
  if (pref !== PREF_SESSIONS) {
    visitsLoadedFor = null;
  }
  const focused = document.activeElement;
  if (focused && focused.matches("input, select") && focused.closest(".row")) {
    return;
  }
  render();
}

// The mod bumps the version after each file write and rewrites the open
// visits on every flush; a short delay folds a burst from several windows
// into one re-read.
function onVisitsChanged() {
  scheduleVisitsRefresh(300, true);
}

function onLogPagesChanged() {
  if (view === "pages") {
    renderPages();
  }
}

const OBSERVERS = [
  [PREF_SESSIONS, onStoreChanged],
  [PREF_DAY_START, onStoreChanged],
  [PREF_WEEK_START, onStoreChanged],
  [PREF_VISITS_VERSION, onVisitsChanged],
  [PREF_OPEN_VISITS, onVisitsChanged],
  [PREF_LOG_PAGES, onLogPagesChanged],
];

window.addEventListener("DOMContentLoaded", () => {
  reload();
  view = viewFromHash();
  for (const btn of $("views").children) {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  }
  window.addEventListener("hashchange", () => setView(viewFromHash()));
  for (const btn of $("periods").children) {
    btn.addEventListener("click", () => {
      period = PERIODS.includes(btn.dataset.period) ? btn.dataset.period : "today";
      pageIndex = 0;
      render();
    });
  }
  for (const btn of $("groupings").children) {
    btn.addEventListener("click", () => {
      grouping = GROUPINGS.includes(btn.dataset.grouping)
        ? btn.dataset.grouping
        : "visits";
      pageIndex = 0;
      renderChrome();
      renderPages();
    });
  }
  $("space-filter").addEventListener("change", (event) => {
    spaceFilter = event.target.value;
    pageIndex = 0;
    render();
  });
  $("search").addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = event.target.value;
      pageIndex = 0;
      renderPages();
    }, 120);
  });
  $("add").addEventListener("click", addSession);
  $("clear").addEventListener("click", clearListed);
  $("export-csv").addEventListener("click", () =>
    view === "pages" ? exportPages("csv") : exportSessions("csv"),
  );
  $("export-json").addEventListener("click", () =>
    view === "pages" ? exportPages("json") : exportSessions("json"),
  );
  for (const [pref, handler] of OBSERVERS) {
    Services.prefs.addObserver(pref, handler);
  }
  window.addEventListener(
    "unload",
    () => {
      for (const [pref, handler] of OBSERVERS) {
        Services.prefs.removeObserver(pref, handler);
      }
    },
    { once: true },
  );
  render();
});

"use strict";

// Focus Space — the sessions page. Opened in a tab from the legend's "Sessions"
// button as chrome://sine/content/focus-space/sessions/sessions.html, so it runs
// in the parent process with system privileges and works on the same prefs as
// the mod: it reads and writes the session store directly (every window's bar
// repaints via its own pref observer) and reaches the space list through the
// browser window. It has no access to the mod's module scope, so the few data
// helpers it needs are mirrored here — keep them in step with focus-space.uc.mjs.

const PREF_SESSIONS = "extensions.focus-space.sessions";
const PREF_DAY_START = "extensions.focus-space.day-start-hour";
const PREF_WEEK_START = "extensions.focus-space.week-start";
const RETENTION_DAYS = 90;
const DEFAULT_DAY_START = 4;
const PERIODS = ["today", "week", "month", "all"];
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
let period = "today";
let spaceFilter = "";
let sessions = [];

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

function formatLocal(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
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

// --- rendering ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

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

function sessionRow(session, byId) {
  const running = Boolean(session.open);
  const entry = byId.get(session.uuid);
  const color = entry
    ? spaceColor(entry.workspace, entry.index)
    : FALLBACK_PALETTE[FALLBACK_PALETTE.length - 1];

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

function render() {
  for (const btn of $("periods").children) {
    btn.toggleAttribute("active", btn.dataset.period === period);
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

  $("empty").hidden = list.length > 0;
  $("summary").textContent = list.length
    ? `${list.length} session${list.length === 1 ? "" : "s"}, ${formatDuration(totalSeconds)} in total`
    : "";
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
  let text;
  if (format === "csv") {
    const header = ["space", "space_id", "start", "end", "seconds", "running"];
    text =
      header.join(",") +
      "\n" +
      rows
        .map((row) => header.map((key) => csvField(row[key])).join(","))
        .join("\n") +
      "\n";
  } else {
    text = JSON.stringify(rows, null, 2) + "\n";
  }

  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
    Ci.nsIFilePicker,
  );
  picker.init(
    window.browsingContext,
    "Export focus sessions",
    Ci.nsIFilePicker.modeSave,
  );
  picker.defaultString = `focus-sessions-${period}-${todayKey()}.${format}`;
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

// --- wiring ------------------------------------------------------------------
function reload() {
  dayStartHour = readDayStartHour();
  weekStartDow = resolveWeekStartDow(readWeekStartPref());
  sessions = readSessions();
}

// Any window's flush or edit repaints the page — but not out from under a
// field being edited here (a rebuild would drop its pending value).
function onStoreChanged() {
  reload();
  const focused = document.activeElement;
  if (focused && focused.matches("input, select") && focused.closest(".row")) {
    return;
  }
  render();
}

const OBSERVED_PREFS = [PREF_SESSIONS, PREF_DAY_START, PREF_WEEK_START];

window.addEventListener("DOMContentLoaded", () => {
  reload();
  for (const btn of $("periods").children) {
    btn.addEventListener("click", () => {
      period = PERIODS.includes(btn.dataset.period) ? btn.dataset.period : "today";
      render();
    });
  }
  $("space-filter").addEventListener("change", (event) => {
    spaceFilter = event.target.value;
    render();
  });
  $("add").addEventListener("click", addSession);
  $("export-csv").addEventListener("click", () => exportSessions("csv"));
  $("export-json").addEventListener("click", () => exportSessions("json"));
  for (const pref of OBSERVED_PREFS) {
    Services.prefs.addObserver(pref, onStoreChanged);
  }
  window.addEventListener(
    "unload",
    () => {
      for (const pref of OBSERVED_PREFS) {
        Services.prefs.removeObserver(pref, onStoreChanged);
      }
    },
    { once: true },
  );
  render();
});

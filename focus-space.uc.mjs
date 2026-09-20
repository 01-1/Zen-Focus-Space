"use strict";

// Focus Space has two cooperating parts:
//   1. A live session stopwatch in the active workspace indicator (resets on
//      every space switch, with a pause/resume toggle — button or shortcut).
//   2. A "today" time-ratio bar at the sidebar foot: a stacked proportion bar
//      showing how today's time splits across spaces.
// Both are driven by the same 1s tick, so pausing freezes both. The stopwatch
// is per-session (resets on switch); the underlying record is a log of
// sessions — one per contiguous running stretch in a space — persisted in a
// pref, which the bar sums per day and a small editor lets the user view,
// correct, and export.

const HTML_NS = "http://www.w3.org/1999/xhtml";

const TIMER_LABEL_CLASS = "zen-focus-space-timer";
const TIMER_BUTTON_CLASS = "zen-focus-space-timer-toggle";
const ICON_RUNNING = 'url("chrome://browser/skin/zen-icons/media-pause.svg")';
const ICON_PAUSED = 'url("chrome://browser/skin/zen-icons/media-play.svg")';

const RATIO_CONTAINER_ID = "zen-focus-space-ratio";
const SESSIONS_PANEL_ID = "zen-focus-space-sessions-panel";
const PREF_SHOW = "extensions.focus-space.show-ratio-bar";
// The session log: [{ id, uuid, start, end, open? }] with ms timestamps. A
// session is one contiguous running stretch in a space; it closes on a space
// switch, pause, day rollover, sleep gap, or window unload. `open` marks the
// session a window is still running (its `end` is the last flush).
const PREF_SESSIONS = "extensions.focus-space.sessions";
// Pre-1.1 builds kept per-day, per-space totals in this pref. It's read once,
// converted into sessions, and then left alone (as a backup) — see
// migrateLegacyData.
const PREF_LEGACY_DATA = "extensions.focus-space.daily-data";
const PREF_MIGRATED = "extensions.focus-space.sessions-migrated";
const PREF_DAY_START = "extensions.focus-space.day-start-hour";
const PREF_VIEW = "extensions.focus-space.view-period";
const PREF_WEEK_START = "extensions.focus-space.week-start";
const PREF_SHORTCUT = "extensions.focus-space.pause-shortcut";
const PREF_SEPARATOR = "extensions.focus-space.show-separator";
const PREF_PLACEMENT = "extensions.focus-space.timer-placement";
// Where the stopwatch sits in the indicator row. "beside" glues it to the space
// name (pinning the name to its content width); "end" leaves the name's layout
// to Zen/the user's theme and floats the timer to the end of the row instead.
const PLACEMENTS = ["beside", "end"];
const DEFAULT_PLACEMENT = "beside";
const PLACEMENT_ATTR = "zen-focus-space-timer-placement";
const PREF_PAUSE_ON_BLUR = "extensions.focus-space.pause-on-blur";
const FLUSH_MS = 10000;
const RETENTION_DAYS = 90;
// A gap between ticks this long means the machine slept or the browser hung:
// none of it was focus time, so the running session is closed where the last
// tick left it and a fresh one starts. (Matches the old tick-counting model,
// where a sleeping timer simply didn't count.)
const GAP_SPLIT_MS = 120000;
// A session still flagged `open` whose end is this stale belongs to a window
// that went away without closing it (crash, kill); any flush clears the flag.
const STALE_OPEN_MS = 60000;
// The day boundary: time logged before this local hour counts toward the
// previous day, so a late-night session stays with the day it began on.
// User-overridable via PREF_DAY_START (0–23); 4am by default.
const DEFAULT_DAY_START = 4;

// The bar can show one of three periods, remembered globally in PREF_VIEW.
const PERIODS = ["today", "week", "month"];
const DEFAULT_VIEW = "today";

// Used only for spaces with no custom theme color of their own.
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

// The script is written to run once per window, but Sine re-injects it whenever
// the mod is toggled off and on (or updated) without unloading the previous
// run. Each run is a fresh module scope, so the earlier one keeps ticking with
// no way to reach it from here — unless it left a handle. Every run publishes
// its teardown under this window property and, on startup, tears down whatever
// run came before it, so exactly one stopwatch owns the indicator at a time.
const INSTANCE_KEY = "__zenFocusSpaceInstance";

// --- session stopwatch state -------------------------------------------------
let timerInterval = null;
let totalSeconds = 0;
let isPaused = false;
// True while the pause was made by us because the window went inactive (see
// PREF_PAUSE_ON_BLUR), so it can be undone when the window comes back — a
// pause the user made by hand is left alone.
let autoPaused = false;
let pauseOnBlur = true;
let activeTimerEl = null;
let activeToggleBtn = null;
let showSeparator = true;
let timerPlacement = DEFAULT_PLACEMENT;
let tornDown = false;

// --- pause/resume shortcut state ---------------------------------------------
// Our isolated <keyset>, re-inserted on rebind so Gecko re-registers the key.
let pauseKeysetEl = null;

// --- session-log state -------------------------------------------------------
// `sessions` mirrors the shared pref. This window contributes `openSession`
// (the stretch currently running here) and `pendingSessions` (ones it closed
// since the last flush); flush() upserts both into the store by id, so several
// windows append without clobbering each other. Trade-off: a space foregrounded
// in two windows at once is counted twice, so absolute legend times can exceed
// wall-clock — but the cross-space ratios (the point of the bar) stay correct,
// so we accept it rather than coordinate windows.
let sessions = [];
let sessionsVersion = 0;
let openSession = null;
let pendingSessions = [];
let lastTickAt = Date.now();
let dayStartHour = DEFAULT_DAY_START;
let currentDayKey = todayKey();
let activeUuid = null;
let flushTimer = null;
let showBar = true;
let viewPeriod = DEFAULT_VIEW;
let weekStartDow = 1; // 0=Sunday … 6=Saturday; resolved from the week-start pref

// Bar/legend element references. The bar is a minute-resolution view: it
// repaints only when a whole-minute value (or the set of spaces) changes, so
// there's no per-second churn — live seconds live in the indicator stopwatch.
let barEl = null;
let legendRowsEl = null;
let legendEmptyEl = null;
let periodButtonsEl = null;
let lastSignature = "";

// --- small helpers -----------------------------------------------------------
function pad2(n) {
  return n.toString().padStart(2, "0");
}

function dayKeyFor(date) {
  const d = new Date(date);
  // A new "day" begins at dayStartHour (local time); anything earlier belongs
  // to the previous calendar day, so e.g. a 2am session stays with the prior
  // day. setDate() handles month/year boundaries.
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

// Build an HTML-namespaced element for the ratio bar (plain div/span/button).
// The stopwatch's XUL elements (label, toolbarbutton) can't go through this —
// they're built via MozXULElement.parseXULToFragment in ensureTimerEl/
// ensureButton, so the two construction idioms coexist on purpose.
function el(tag, attrs, ...children) {
  const node = document.createElementNS(HTML_NS, tag);
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key];
      if (value != null) {
        node.setAttribute(key, value);
      }
    }
  }
  for (const child of children) {
    if (child == null) {
      continue;
    }
    node.append(
      child.nodeType ? child : document.createTextNode(String(child)),
    );
  }
  return node;
}

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const sec = seconds % 60;
  const mm = min.toString().padStart(2, "0");
  const ss = sec.toString().padStart(2, "0");
  // Only surface an hours field once the session crosses an hour, so short
  // sessions stay a clean "mm:ss" rather than "0:00:ss".
  return hrs > 0 ? `${hrs}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Legend-friendly whole-minute duration: "2h 41m", "5h 01m", "48m". Minutes are
// zero-padded once an hour is shown so the "Hh MMm" rows align as a column.
// Everything is in minutes, so the parts always add up to the period total.
function formatMinutes(totalMin) {
  const mins = Math.max(0, Math.floor(totalMin));
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs > 0) {
    return `${hrs}h ${pad2(rem)}m`;
  }
  return `${rem}m`;
}

// Collapse a space's gradient theme to one representative color (its primary
// dot), matching what the user sees as that space's signature color. Spaces
// with no custom theme fall back to a stable palette slot.
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

// Prefix the space name with its emoji icon when it has one (SVG icons are
// skipped — the colored swatch already identifies the space).
function legendName(workspace) {
  const icon = workspace.icon;
  if (icon && icon !== "" && !icon.endsWith(".svg")) {
    return `${icon}  ${workspace.name}`;
  }
  return workspace.name;
}

// --- persistence -------------------------------------------------------------
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

function newSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A session belongs to the logical day it started on; the tick splits running
// sessions at rollover, so only hand-edited ones can straddle a boundary.
function sessionDayKey(session) {
  return dayKeyFor(session.start);
}

function pruneSessions(list) {
  const cutoff = cutoffKey();
  // ISO date keys compare lexicographically, so this drops old days.
  return list.filter((session) => sessionDayKey(session) >= cutoff);
}

function beginSession(uuid, at) {
  openSession = { id: newSessionId(), uuid, start: at, end: at, open: true };
}

// Close this window's running session at `at`. Sub-second stretches (a quick
// switch through a space) are dropped rather than logged as clutter.
function endSession(at) {
  if (!openSession) {
    return;
  }
  const session = openSession;
  openSession = null;
  session.end = Math.max(session.start, at);
  delete session.open;
  if (session.end - session.start >= 1000) {
    pendingSessions.push(session);
  }
}

// Re-read the shared store, upsert this window's sessions, write it back. The
// read-modify-write is synchronous and every window shares the main thread, so
// two windows' flushes can't interleave.
function flush() {
  if (!openSession && !pendingSessions.length) {
    return;
  }
  const now = Date.now();
  const byId = new Map(readSessions().map((session) => [session.id, session]));
  for (const session of pendingSessions) {
    byId.set(session.id, session);
  }
  if (openSession) {
    byId.set(openSession.id, { ...openSession });
  }
  for (const session of byId.values()) {
    const ours = openSession && session.id === openSession.id;
    if (session.open && !ours && now - session.end > STALE_OPEN_MS) {
      delete session.open;
    }
  }
  const list = pruneSessions([...byId.values()]);
  // Update our in-memory view and clear the delta first, then persist, so the
  // observer's re-read — ours fires synchronously here — sees the same totals.
  pendingSessions = [];
  sessions = list;
  sessionsVersion++;
  writeSessions(list);
}

// Apply an edit to the store: flush first so everything this window knows is
// in there, then read-modify-write. `mutate` gets the list and returns the new
// one (or mutates in place and returns nothing).
function updateSessions(mutate) {
  flush();
  const list = readSessions();
  const next = mutate(list) || list;
  sessions = pruneSessions(next);
  sessionsVersion++;
  writeSessions(sessions);
}

// One-time conversion of the pre-1.1 per-day totals into sessions, so old data
// still shows in the bar and the editor. Each day's totals become back-to-back
// synthetic sessions from that day's start hour (marked `migrated`); the
// legacy pref is left untouched as a backup and never read again.
function migrateLegacyData() {
  try {
    if (Services.prefs.getBoolPref(PREF_MIGRATED, false)) {
      return;
    }
    const raw = Services.prefs.getStringPref(PREF_LEGACY_DATA, "");
    const legacy = raw ? JSON.parse(raw) : {};
    const list = readSessions();
    let added = false;
    for (const key of Object.keys(legacy)) {
      const [y, m, d] = key.split("-").map(Number);
      if (![y, m, d].every(Number.isInteger)) {
        continue;
      }
      let cursor = new Date(y, m - 1, d, dayStartHour, 0, 0).getTime();
      const day = legacy[key] || {};
      for (const uuid of Object.keys(day)) {
        const seconds = Math.floor(day[uuid]);
        if (!(seconds > 0)) {
          continue;
        }
        list.push({
          id: newSessionId(),
          uuid,
          start: cursor,
          end: cursor + seconds * 1000,
          migrated: true,
        });
        cursor += seconds * 1000;
        added = true;
      }
    }
    if (added) {
      writeSessions(pruneSessions(list));
    }
    Services.prefs.setBoolPref(PREF_MIGRATED, true);
  } catch (e) {
    console.error("[focus-space] legacy data migration failed:", e);
  }
}

// The first day-key of the selected period. "today" is just currentDayKey;
// week/month walk back from today's logical date (parsed at local noon, so DST
// can't shift it) to the week-start day or the 1st of the month.
function periodStartKey(period) {
  if (period === "today") {
    return currentDayKey;
  }
  const [y, m, d] = currentDayKey.split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0);
  if (period === "month") {
    date.setDate(1);
  } else {
    const diff = (date.getDay() - weekStartDow + 7) % 7;
    date.setDate(date.getDate() - diff);
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

// Per-space seconds across the selected period. Stored sessions are summed
// once per (store version, period, day) and cached, since this runs on every
// tick; this window's own running/unflushed sessions are added live on top.
let totalsCache = { key: "", totals: {} };

function inPeriod(session, startKey) {
  const key = sessionDayKey(session);
  return key >= startKey && key <= currentDayKey;
}

function periodTotals(period) {
  const startKey = periodStartKey(period);
  const cacheKey = [
    sessionsVersion,
    startKey,
    currentDayKey,
    dayStartHour,
  ].join("|");
  if (totalsCache.key !== cacheKey) {
    const stored = {};
    for (const session of sessions) {
      if (openSession && session.id === openSession.id) {
        continue; // counted live below, from memory
      }
      if (inPeriod(session, startKey)) {
        stored[session.uuid] =
          (stored[session.uuid] || 0) + (session.end - session.start) / 1000;
      }
    }
    totalsCache = { key: cacheKey, totals: stored };
  }
  const totals = { ...totalsCache.totals };
  const live = openSession
    ? [...pendingSessions, openSession]
    : pendingSessions;
  for (const session of live) {
    if (inPeriod(session, startKey)) {
      totals[session.uuid] =
        (totals[session.uuid] || 0) + (session.end - session.start) / 1000;
    }
  }
  return totals;
}

function periodPhrase(period) {
  if (period === "week") {
    return "this week";
  }
  if (period === "month") {
    return "this month";
  }
  return "today";
}

// --- session stopwatch -------------------------------------------------------
function renderTime() {
  if (activeTimerEl) {
    // Leading NBSP is exactly one space before the "|" (a normal leading space
    // would be collapsed). The indicator's flex `gap` ahead of the timer is
    // cancelled in CSS, so this NBSP is the only spacing after the space name.
    // The "|" itself is optional (PREF_SEPARATOR).
    const sep = showSeparator ? "| " : "";
    activeTimerEl.textContent = ` ${sep}${formatTime(totalSeconds)}`;
  }
}

function stopInterval() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// If the logical day has turned over (local midnight, or the configured
// day-start hour), split the running session at the boundary so the closing
// day keeps its part and the new day starts clean. No-op within the same day.
function rolloverIfNeeded() {
  const key = todayKey();
  if (key === currentDayKey) {
    return;
  }
  const now = Date.now();
  if (openSession) {
    const uuid = openSession.uuid;
    endSession(now);
    beginSession(uuid, now);
  }
  flush();
  currentDayKey = key;
}

// The shared 1s tick: advances the visible stopwatch AND the running session's
// end, handles sleep gaps and day rollover, then repaints the bar.
function startInterval() {
  stopInterval();
  lastTickAt = Date.now();
  timerInterval = setInterval(() => {
    const now = Date.now();
    if (openSession && now - lastTickAt > GAP_SPLIT_MS) {
      const uuid = openSession.uuid;
      endSession(lastTickAt);
      beginSession(uuid, now);
    }
    lastTickAt = now;
    rolloverIfNeeded();
    totalSeconds++;
    renderTime();
    if (openSession) {
      openSession.end = now;
    }
    renderBar();
  }, 1000);
}

function updateButtonVisual() {
  if (!activeToggleBtn) {
    return;
  }
  activeToggleBtn.style.setProperty(
    "list-style-image",
    isPaused ? ICON_PAUSED : ICON_RUNNING,
    "important",
  );
  let tooltip = "Pause timer";
  if (isPaused) {
    tooltip = autoPaused ? "Paused (window inactive) — resume" : "Resume timer";
  }
  activeToggleBtn.setAttribute("tooltiptext", tooltip);
}

function setPaused(paused) {
  if (paused === isPaused) {
    return;
  }
  isPaused = paused;
  if (isPaused) {
    // Pausing stops the shared tick and closes the running session, so the
    // break isn't logged; flush so it isn't sitting only in volatile memory.
    stopInterval();
    endSession(Date.now());
    flush();
  } else {
    if (activeUuid) {
      beginSession(activeUuid, Date.now());
    }
    startInterval();
  }
  updateButtonVisual();
}

// The user's toggle (button or shortcut). A deliberate pause or resume takes
// over from any automatic one: pausing by hand while auto-paused means "stay
// paused when the window comes back", resuming by hand just resumes.
function togglePause() {
  autoPaused = false;
  setPaused(!isPaused);
}

// --- auto-pause while the window is inactive ---------------------------------
// Time in another app (or another Zen window) isn't focus time in this space,
// so a running stopwatch pauses when the window deactivates and only resumes
// when it activates again if that pause was ours. "activate"/"deactivate" are
// the chrome-window events for top-level focus, unlike window "blur", which
// also fires for focus moving into the content area.
//
// Erring on the side of counting: the only thing that pauses is a definite
// signal that another window is in front. An unknown focus state (startup,
// before the OS has focused anything) counts as active, and because window
// activation events can go missing on some desktops (Wayland compositors in
// particular), any interaction with the window — a key, click, or scroll —
// also releases an automatic pause: a user typing here is plainly here.
function windowIsActive() {
  try {
    const active = Services.focus.activeWindow;
    return !active || active === window;
  } catch {
    return true;
  }
}

const INTERACTION_EVENTS = ["keydown", "mousedown", "wheel", "focus"];

function autoPauseIfInactive() {
  if (pauseOnBlur && !isPaused && !windowIsActive()) {
    autoPaused = true;
    setPaused(true);
  }
}

function onWindowDeactivate() {
  autoPauseIfInactive();
}

function onWindowActivate() {
  if (autoPaused) {
    autoPaused = false;
    setPaused(false);
  }
}

// Cheap: a no-op unless we currently hold an automatic pause.
function onWindowInteraction() {
  if (autoPaused) {
    onWindowActivate();
  }
}

function readPauseOnBlurPref() {
  try {
    return Services.prefs.getBoolPref(PREF_PAUSE_ON_BLUR, true);
  } catch {
    return true;
  }
}

function onPauseOnBlurChanged() {
  pauseOnBlur = readPauseOnBlurPref();
  if (pauseOnBlur) {
    autoPauseIfInactive();
  } else if (autoPaused) {
    // Turning it off while we hold an automatic pause releases it.
    autoPaused = false;
    setPaused(false);
  }
}

function ensureTimerEl(indicator) {
  const existing = indicator.querySelector(`.${TIMER_LABEL_CLASS}`);
  if (existing) {
    return existing;
  }

  const nameEl = indicator.querySelector(
    ".zen-current-workspace-indicator-name",
  );
  if (!nameEl) {
    return null;
  }

  const fragment = window.MozXULElement.parseXULToFragment(
    `<label class="${TIMER_LABEL_CLASS}"/>`,
  );
  const timerEl = fragment.firstElementChild;
  // Sit the timer right after the space name; its spacing and visibility are
  // handled in focus-space.css (the indicator's flex `gap` ahead of it is
  // cancelled there, so the leading NBSP in renderTime is the only separator).
  nameEl.after(timerEl);
  return timerEl;
}

function ensureButton(indicator) {
  const existing = indicator.querySelector(`.${TIMER_BUTTON_CLASS}`);
  if (existing) {
    return existing;
  }

  const fragment = window.MozXULElement.parseXULToFragment(
    `<toolbarbutton class="toolbarbutton-1 chromeclass-toolbar-additional zen-workspaces-actions ${TIMER_BUTTON_CLASS}"/>`,
  );
  const btn = fragment.firstElementChild;
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePause();
  });

  // Place the toggle just before the workspace actions ("...") button so the
  // overflow menu stays the trailing item, matching the usual toolbar order.
  // The stylesheet tucks "..." flush against the toggle (see focus-space.css).
  const actions = indicator.querySelector(
    `.zen-workspaces-actions:not(.${TIMER_BUTTON_CLASS})`,
  );
  if (actions) {
    actions.before(btn);
  } else {
    indicator.appendChild(btn);
  }
  return btn;
}

// --- pause/resume shortcut ---------------------------------------------------
// Why a real XUL <key> and not a window "keydown" listener: a chrome-window key
// listener doesn't fire while a web page (the remote <browser>) has focus — the
// keystroke is handled in the content process — so the shortcut would die the
// moment you click into a page, which is most of the time for a focus timer. A
// XUL <key> is matched by Gecko's native key handling and fires regardless of
// what's focused (the same path as F11, Ctrl+T, …). Zen's own
// ZenKeyboardShortcuts.mjs builds <key> nodes for exactly this reason. Keep it
// this way — swapping in addEventListener would quietly regress global reach.
const KEYSET_ID = "zen-focus-space-keyset";
const KEY_ID = "zen-focus-space-pause-key";
const COMMAND_ID = "zen-focus-space-pause-command";
// The default shortcut. Also hard-coded in preferences.json (defaultValue +
// placeholder) and named in the README / theme.json blurb — JSON can't import
// this constant, so keep those copies in sync by hand if it ever changes.
const DEFAULT_SHORTCUT = "F9";

// Combo tokens → the values a XUL <key> understands. Modifiers stay literal (no
// accel remap), so the binding matches exactly what the user typed.
const MODIFIER_TOKENS = {
  ctrl: "control",
  control: "control",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  win: "meta",
  super: "meta",
  accel: "accel",
};

// Named keys that ride on <key keycode="VK_…"> instead of a printable key="x".
// Function keys are the only named keys worth binding a pause toggle to (the
// default is F9); any other printable key goes through key="x" + a modifier.
const NAMED_KEYCODES = {
  f1: "VK_F1",
  f2: "VK_F2",
  f3: "VK_F3",
  f4: "VK_F4",
  f5: "VK_F5",
  f6: "VK_F6",
  f7: "VK_F7",
  f8: "VK_F8",
  f9: "VK_F9",
  f10: "VK_F10",
  f11: "VK_F11",
  f12: "VK_F12",
  f13: "VK_F13",
  f14: "VK_F14",
  f15: "VK_F15",
  f16: "VK_F16",
  f17: "VK_F17",
  f18: "VK_F18",
  f19: "VK_F19",
  f20: "VK_F20",
  f21: "VK_F21",
  f22: "VK_F22",
  f23: "VK_F23",
  f24: "VK_F24",
};

function readShortcutPref() {
  try {
    return Services.prefs.getStringPref(PREF_SHORTCUT, DEFAULT_SHORTCUT).trim();
  } catch {
    return DEFAULT_SHORTCUT;
  }
}

// Parse "Alt+Shift+P" / "F9" into the attributes a <key> needs, or null when
// there's no usable binding — in which case the shortcut is left disabled. A
// printable key must carry Ctrl/Alt/Meta (a bare or Shift-only key like "p"
// would clash with typing, so it's rejected); function keys need no modifier.
function parseShortcut(str) {
  if (!str) {
    return null;
  }
  const mods = [];
  let keyToken = null;
  for (const partRaw of str.split("+")) {
    const part = partRaw.trim().toLowerCase();
    if (!part) {
      continue;
    }
    const mod = MODIFIER_TOKENS[part];
    if (mod) {
      if (!mods.includes(mod)) {
        mods.push(mod);
      }
    } else {
      keyToken = part; // last non-modifier token wins
    }
  }
  if (!keyToken) {
    return null;
  }
  const modifiers = mods.join(" ");

  const keycode = NAMED_KEYCODES[keyToken];
  if (keycode) {
    return { keycode, modifiers };
  }
  // A printable key must pair with Ctrl/Alt/Meta; a bare (or Shift-only) one
  // would steal the keystroke from text entry, so it's disabled instead.
  const hasStrongMod =
    mods.includes("control") ||
    mods.includes("alt") ||
    mods.includes("meta") ||
    mods.includes("accel");
  if ([...keyToken].length !== 1 || !hasStrongMod) {
    return null;
  }
  return { key: keyToken, modifiers };
}

function removeShortcutKey() {
  const existing = pauseKeysetEl || document.getElementById(KEYSET_ID);
  if (existing) {
    existing.remove();
  }
  pauseKeysetEl = null;
}

// (Re)build our <key> from the current pref. Rebuilding drops the old keyset and
// inserts a fresh node — that re-insertion is what makes Gecko's key listener
// register the new binding live, without a restart.
function buildShortcutKey() {
  removeShortcutKey();

  // The shortcut only makes sense where the stopwatch lives (synced windows).
  if (!gZenWorkspaces.currentWindowIsSyncing) {
    return;
  }

  const parsed = parseShortcut(readShortcutPref());
  if (!parsed) {
    return;
  }

  const keyset = document.createXULElement("keyset");
  keyset.id = KEYSET_ID;

  // A <key> is only honoured once it carries a command-handler attribute. The
  // obvious choice — an inline oncommand="" — is an inline event handler, which
  // the chrome CSP (script-src-attr, no 'unsafe-inline') blocks on stricter
  // builds: the attribute is rejected when the key is parsed, the binding dies,
  // and — because this runs at startup before the pref observers register —
  // it can take the bar's reactivity down with it. Point the key at a real
  // <command> node instead and hang the toggle off its "command" event. This
  // is the CSP-safe pattern Zen's own ZenKeyboardShortcuts uses; the command
  // lives in the keyset so removeShortcutKey() tears it down with the rest.
  const command = document.createXULElement("command");
  command.id = COMMAND_ID;
  command.addEventListener("command", togglePause);
  keyset.appendChild(command);

  const keyEl = document.createXULElement("key");
  keyEl.id = KEY_ID;
  if (parsed.keycode) {
    keyEl.setAttribute("keycode", parsed.keycode);
  } else {
    keyEl.setAttribute("key", parsed.key);
  }
  if (parsed.modifiers) {
    keyEl.setAttribute("modifiers", parsed.modifiers);
  }
  keyEl.setAttribute("command", COMMAND_ID);
  keyset.appendChild(keyEl);

  // Sit beside the main keyset, isolated from Zen's own bindings.
  const mainKeyset = document.getElementById("mainKeyset");
  if (mainKeyset && mainKeyset.parentNode) {
    mainKeyset.after(keyset);
  } else {
    document.documentElement.appendChild(keyset);
  }
  pauseKeysetEl = keyset;
}

// --- the daily time-ratio bar ------------------------------------------------
function switchTo(workspace) {
  try {
    gZenWorkspaces.changeWorkspace(workspace);
  } catch {}
}

function periodButton(value, label) {
  const btn = el(
    "button",
    { class: "zen-fs-period", type: "button", "data-period": value },
    label,
  );
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    setViewPeriod(value);
  });
  return btn;
}

// Persist the choice; the pref observer (this window and others) repaints, so
// the period stays in sync across windows from a single write.
function setViewPeriod(value) {
  if (!PERIODS.includes(value)) {
    return;
  }
  try {
    Services.prefs.setStringPref(PREF_VIEW, value);
  } catch {}
}

function mountBar() {
  // The bar only makes sense in normal (synced) windows, same as the stopwatch.
  if (!gZenWorkspaces.currentWindowIsSyncing) {
    return;
  }
  if (document.getElementById(RATIO_CONTAINER_ID)) {
    return;
  }
  const foot = document.getElementById("zen-sidebar-foot-buttons");
  if (!foot || !foot.parentNode) {
    return;
  }

  periodButtonsEl = el(
    "div",
    { class: "zen-fs-periods" },
    periodButton("today", "Today"),
    periodButton("week", "Week"),
    periodButton("month", "Month"),
  );
  const editBtn = el(
    "button",
    {
      class: "zen-fs-edit",
      type: "button",
      title: "View, edit, and export focus sessions",
    },
    "Sessions",
  );
  editBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    openSessionsPanel();
  });
  const head = el(
    "div",
    { class: "zen-fs-legend-head" },
    periodButtonsEl,
    editBtn,
  );
  legendRowsEl = el("div", { class: "zen-fs-legend-rows" });
  legendEmptyEl = el(
    "div",
    { class: "zen-fs-legend-empty" },
    "No focus time yet today",
  );
  const card = el(
    "div",
    { class: "zen-fs-legend-card" },
    head,
    legendRowsEl,
    legendEmptyEl,
  );
  const legend = el("div", { class: "zen-fs-legend" }, card);

  barEl = el("div", { class: "zen-fs-bar" });

  const container = el(
    "div",
    { id: RATIO_CONTAINER_ID, class: "zen-focus-space-ratio" },
    legend,
    barEl,
  );
  container.hidden = !showBar;
  // Sit the bar just above the space-icon strip at the foot of the sidebar.
  foot.parentNode.insertBefore(container, foot);

  renderBar();
}

function rebuildBar(spaces, minutes, totalMinutes) {
  barEl.textContent = "";
  legendRowsEl.textContent = "";

  // Reflect the active period in the toggle and the empty-state wording.
  for (const btn of periodButtonsEl.children) {
    btn.toggleAttribute(
      "active",
      btn.getAttribute("data-period") === viewPeriod,
    );
  }
  legendEmptyEl.textContent = `No focus time yet ${periodPhrase(viewPeriod)}`;

  const hasAny = totalMinutes > 0;
  legendEmptyEl.hidden = hasAny;
  legendRowsEl.hidden = !hasAny;
  if (!hasAny) {
    return;
  }

  spaces.forEach((workspace, index) => {
    const mins = minutes[workspace.uuid] || 0;
    if (mins <= 0) {
      return;
    }
    const color = spaceColor(workspace, index);

    const seg = el("div", {
      class: "zen-fs-seg",
      style: `flex-grow:${mins};flex-shrink:0;flex-basis:0;background:${color};`,
      title: workspace.name,
    });
    seg.addEventListener("click", () => switchTo(workspace));
    barEl.append(seg);

    const swatch = el("span", {
      class: "zen-fs-swatch",
      style: `background:${color};`,
    });
    const nameEl = el("span", { class: "zen-fs-name" }, legendName(workspace));
    const pctEl = el(
      "span",
      { class: "zen-fs-pct" },
      `${Math.round((mins / totalMinutes) * 100)}%`,
    );
    const timeEl = el("span", { class: "zen-fs-time" }, formatMinutes(mins));
    const row = el(
      "div",
      { class: "zen-fs-row" },
      swatch,
      nameEl,
      pctEl,
      timeEl,
    );
    row.addEventListener("click", () => switchTo(workspace));
    legendRowsEl.append(row);
  });
}

function renderBar() {
  if (!barEl || !showBar) {
    return;
  }

  // Runs every tick. Everything down to the signature check is intentionally
  // cheap (a workspace read plus a sum over <=RETENTION_DAYS day-keys); the
  // costly DOM rebuild is gated below, so a quiet second does almost no work.
  let spaces;
  try {
    spaces = gZenWorkspaces.getWorkspaces();
  } catch {
    spaces = [];
  }
  const totals = periodTotals(viewPeriod);

  // Work in whole minutes: a space under a minute folds away (0 minutes), and
  // the shown total is the sum of the visible spaces. Only existing spaces
  // count, so a deleted space's leftover time never skews the ratio.
  const minutes = {};
  let totalMinutes = 0;
  for (const workspace of spaces) {
    const mins = Math.floor((totals[workspace.uuid] || 0) / 60);
    minutes[workspace.uuid] = mins;
    totalMinutes += mins;
  }

  // Repaint only when something visible changes — the period, a minute count, a
  // rename/recolour, or the set of spaces — never just because a second ticked.
  const signature =
    viewPeriod +
    "|" +
    spaces
      .map(
        (w, i) => `${w.uuid}:${w.name}:${spaceColor(w, i)}:${minutes[w.uuid]}`,
      )
      .join("|");
  if (signature === lastSignature) {
    return;
  }
  lastSignature = signature;
  rebuildBar(spaces, minutes, totalMinutes);
}

// --- sessions editor + export ------------------------------------------------
// A <panel> (so it can float over the content area, wider than the sidebar)
// listing the sessions of a chosen period, oldest last. Each row's space,
// start, and end are editable and apply on change; a session another window
// is still running (`open`) is read-only. Exports go through the native save
// dialog as CSV or JSON.
const PANEL_PERIODS = [...PERIODS, "all"];
let panelEl = null;
let panelListEl = null;
let panelEmptyEl = null;
let panelPeriodButtonsEl = null;
let panelPeriod = DEFAULT_VIEW;

function formatLocal(ms) {
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

const LOCAL_TIME_RE =
  /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/;

// "YYYY-MM-DD HH:MM[:SS]" (local time) → ms, or NaN. Plain text rather than
// <input type="datetime-local">: its picker popup isn't reliable inside a
// chrome <panel>, and typing a timestamp is the common edit anyway.
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

function spacesById() {
  let spaces;
  try {
    spaces = gZenWorkspaces.getWorkspaces();
  } catch {
    spaces = [];
  }
  const map = new Map();
  spaces.forEach((workspace, index) => {
    map.set(workspace.uuid, { workspace, index });
  });
  return map;
}

function spaceLabel(uuid, byId) {
  const entry = byId.get(uuid);
  return entry ? legendName(entry.workspace) : "Unknown space";
}

// Everything in the store plus this window's unflushed sessions, filtered to
// the panel's period and sorted newest first. The panel flushes before it
// opens and before every edit, so in practice the pending list is empty here
// and only the running session comes from memory.
function panelSessions() {
  const own = new Set();
  const live = openSession
    ? [...pendingSessions, openSession]
    : pendingSessions;
  for (const session of live) {
    own.add(session.id);
  }
  const list = sessions.filter((session) => !own.has(session.id)).concat(live);
  const startKey = panelPeriod === "all" ? "" : periodStartKey(panelPeriod);
  return list
    .filter((session) => panelPeriod === "all" || inPeriod(session, startKey))
    .sort((a, b) => b.start - a.start);
}

function ensureSessionsPanel() {
  if (panelEl) {
    return panelEl;
  }
  const panel = document.createXULElement("panel");
  panel.id = SESSIONS_PANEL_ID;
  panel.setAttribute("type", "arrow");
  // Editing shouldn't be cancelled by a stray click elsewhere; the panel closes
  // via its button or Escape.
  panel.setAttribute("noautohide", "true");
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeSessionsPanel();
    }
  });

  panelPeriodButtonsEl = el("div", { class: "zen-fs-periods" });
  for (const [value, label] of [
    ["today", "Today"],
    ["week", "Week"],
    ["month", "Month"],
    ["all", "All"],
  ]) {
    const btn = el(
      "button",
      { class: "zen-fs-period", type: "button", "data-period": value },
      label,
    );
    btn.addEventListener("click", () => {
      panelPeriod = value;
      renderSessionsPanel();
    });
    panelPeriodButtonsEl.append(btn);
  }

  const addBtn = el(
    "button",
    { class: "zen-fs-btn", type: "button", title: "Add a session by hand" },
    "Add",
  );
  addBtn.addEventListener("click", addSession);
  const csvBtn = el(
    "button",
    { class: "zen-fs-btn", type: "button", title: "Export listed sessions" },
    "Export CSV",
  );
  csvBtn.addEventListener("click", () => exportSessions("csv"));
  const jsonBtn = el(
    "button",
    { class: "zen-fs-btn", type: "button", title: "Export listed sessions" },
    "Export JSON",
  );
  jsonBtn.addEventListener("click", () => exportSessions("json"));
  const closeBtn = el(
    "button",
    { class: "zen-fs-btn zen-fs-close", type: "button", title: "Close" },
    "Close",
  );
  closeBtn.addEventListener("click", closeSessionsPanel);

  const head = el(
    "div",
    { class: "zen-fs-panel-head" },
    el("span", { class: "zen-fs-panel-title" }, "Focus sessions"),
    panelPeriodButtonsEl,
    el("span", { class: "zen-fs-spacer" }),
    addBtn,
    csvBtn,
    jsonBtn,
    closeBtn,
  );
  const columns = el(
    "div",
    { class: "zen-fs-sess-row zen-fs-sess-columns" },
    el("span", null, "Space"),
    el("span", null, "Start"),
    el("span", null, ""),
    el("span", null, "End"),
    el("span", { class: "zen-fs-sess-dur" }, "Length"),
    el("span", null, ""),
  );
  panelListEl = el("div", { class: "zen-fs-sess-list" });
  panelEmptyEl = el("div", { class: "zen-fs-legend-empty" }, "No sessions");
  const hint = el(
    "div",
    { class: "zen-fs-panel-hint" },
    "Times are local, YYYY-MM-DD HH:MM:SS. Changes apply as you leave a field.",
  );
  panel.append(
    el(
      "div",
      { class: "zen-fs-panel" },
      head,
      columns,
      panelListEl,
      panelEmptyEl,
      hint,
    ),
  );

  const popupSet = document.getElementById("mainPopupSet");
  (popupSet || document.documentElement).appendChild(panel);
  panelEl = panel;
  return panel;
}

function sessionRow(session, byId) {
  const running = Boolean(session.open);
  const select = el("select", { class: "zen-fs-sess-space" });
  let known = false;
  for (const { workspace } of byId.values()) {
    const opt = el("option", { value: workspace.uuid }, legendName(workspace));
    if (workspace.uuid === session.uuid) {
      opt.setAttribute("selected", "");
      known = true;
    }
    select.append(opt);
  }
  if (!known) {
    const opt = el("option", { value: session.uuid }, "Unknown space");
    opt.setAttribute("selected", "");
    select.append(opt);
  }
  const startInput = el("input", {
    class: "zen-fs-sess-time",
    type: "text",
    value: formatLocal(session.start),
    spellcheck: "false",
  });
  const endInput = el("input", {
    class: "zen-fs-sess-time",
    type: "text",
    value: running ? "running" : formatLocal(session.end),
    spellcheck: "false",
  });
  const durEl = el(
    "span",
    { class: "zen-fs-sess-dur" },
    formatDuration((session.end - session.start) / 1000),
  );
  const delBtn = el(
    "button",
    { class: "zen-fs-sess-del", type: "button", title: "Delete this session" },
    "✕",
  );

  if (running) {
    select.disabled = true;
    startInput.disabled = true;
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
    const commitTimes = () => {
      const start = parseLocal(startInput.value);
      const end = parseLocal(endInput.value);
      const valid = !Number.isNaN(start) && !Number.isNaN(end) && end > start;
      startInput.toggleAttribute("invalid", Number.isNaN(start) || !valid);
      endInput.toggleAttribute("invalid", Number.isNaN(end) || !valid);
      if (!valid) {
        return;
      }
      durEl.textContent = formatDuration((end - start) / 1000);
      updateSessions((list) => {
        const target = list.find((item) => item.id === session.id);
        if (target) {
          target.start = start;
          target.end = end;
        }
      });
    };
    startInput.addEventListener("change", commitTimes);
    endInput.addEventListener("change", commitTimes);
    delBtn.addEventListener("click", () => {
      updateSessions((list) => list.filter((item) => item.id !== session.id));
      renderSessionsPanel();
    });
  }

  const row = el(
    "div",
    { class: "zen-fs-sess-row", "data-id": session.id },
    select,
    startInput,
    el("span", { class: "zen-fs-sess-arrow" }, "→"),
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

function renderSessionsPanel() {
  if (!panelEl) {
    return;
  }
  for (const btn of panelPeriodButtonsEl.children) {
    btn.toggleAttribute(
      "active",
      btn.getAttribute("data-period") === panelPeriod,
    );
  }
  const byId = spacesById();
  const list = panelSessions();
  panelListEl.textContent = "";
  for (const session of list) {
    panelListEl.append(sessionRow(session, byId));
  }
  panelEmptyEl.hidden = list.length > 0;
  panelListEl.hidden = list.length === 0;
}

// Repaint after an external change, but not out from under an edit in
// progress (a rebuild would drop the focused field's pending value).
function refreshSessionsPanel() {
  if (!panelEl || panelEl.state !== "open") {
    return;
  }
  if (panelEl.contains(document.activeElement)) {
    return;
  }
  renderSessionsPanel();
}

function openSessionsPanel() {
  const panel = ensureSessionsPanel();
  flush();
  panelPeriod = PANEL_PERIODS.includes(viewPeriod) ? viewPeriod : DEFAULT_VIEW;
  renderSessionsPanel();
  const anchor = document.getElementById(RATIO_CONTAINER_ID);
  if (panel.state === "open") {
    return;
  }
  if (anchor) {
    panel.openPopup(anchor, "before_start", 0, -6, false, false);
  } else {
    panel.openPopupAtScreen(window.screenX + 40, window.screenY + 80, false);
  }
}

function closeSessionsPanel() {
  if (panelEl && panelEl.state !== "closed") {
    panelEl.hidePopup();
  }
}

// A hand-added session: the last half hour in the active (or first) space,
// ready to be corrected in place.
function addSession() {
  let uuid = activeUuid;
  if (!uuid) {
    const first = spacesById().keys().next();
    uuid = first.done ? null : first.value;
  }
  if (!uuid) {
    return;
  }
  const end = Date.now();
  const start = end - 30 * 60000;
  updateSessions((list) => {
    list.push({ id: newSessionId(), uuid, start, end });
  });
  if (
    panelPeriod !== "all" &&
    !inPeriod({ start }, periodStartKey(panelPeriod))
  ) {
    panelPeriod = "today";
  }
  renderSessionsPanel();
  const row = panelListEl.querySelector(".zen-fs-sess-row:not([running])");
  const field = row && row.querySelector(".zen-fs-sess-time");
  if (field) {
    field.focus();
    field.select();
  }
}

function csvField(value) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportSessions(format) {
  flush();
  const byId = spacesById();
  const rows = panelSessions()
    .slice()
    .reverse()
    .map((session) => ({
      id: session.id,
      space: spaceLabel(session.uuid, byId),
      space_id: session.uuid,
      start: formatLocal(session.start),
      end: formatLocal(session.end),
      seconds: Math.round((session.end - session.start) / 1000),
      running: Boolean(session.open),
    }));
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
  picker.defaultString = `focus-sessions-${panelPeriod}-${todayKey()}.${format}`;
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

// --- pref observers ----------------------------------------------------------
function onSessionsChanged() {
  // Fires on any window's flush or edit, including our own synchronous
  // self-write — harmless, since the writers update `sessions` before
  // persisting, so re-reading here yields the same list.
  sessions = readSessions();
  sessionsVersion++;
  renderBar();
  refreshSessionsPanel();
}

function onPrefShowChanged() {
  showBar = readShowPref();
  const container = document.getElementById(RATIO_CONTAINER_ID);
  if (container) {
    container.hidden = !showBar;
  }
  if (showBar) {
    renderBar();
  }
}

function readShowPref() {
  try {
    return Services.prefs.getBoolPref(PREF_SHOW, true);
  } catch {
    return true;
  }
}

// Sine's dropdown may persist the hour as either an int (after the user picks
// one) or a string (the initial default-save), so read whichever is there and
// fall back to the default for anything missing or out of range.
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

function onDayStartChanged() {
  dayStartHour = readDayStartHour();
  // The logical "today" may shift to a different bucket; re-roll and repaint.
  rolloverIfNeeded();
  renderBar();
}

function readViewPref() {
  try {
    const value = Services.prefs.getStringPref(PREF_VIEW, DEFAULT_VIEW);
    return PERIODS.includes(value) ? value : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function onViewChanged() {
  viewPeriod = readViewPref();
  renderBar();
}

function readSeparatorPref() {
  try {
    return Services.prefs.getBoolPref(PREF_SEPARATOR, true);
  } catch {
    return true;
  }
}

function onSeparatorChanged() {
  showSeparator = readSeparatorPref();
  renderTime();
}

function readPlacementPref() {
  try {
    const value = Services.prefs.getStringPref(
      PREF_PLACEMENT,
      DEFAULT_PLACEMENT,
    );
    return PLACEMENTS.includes(value) ? value : DEFAULT_PLACEMENT;
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

// The placement is purely a layout concern, so it's exposed to focus-space.css
// as a root attribute rather than restructuring the indicator's DOM.
function applyPlacement() {
  timerPlacement = readPlacementPref();
  document.documentElement.setAttribute(PLACEMENT_ATTR, timerPlacement);
}

// Like the day-start pref, the week-start dropdown may persist as a string
// ("auto" or a day index) or an int; accept either.
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

// Resolve the week-start pref to a JS day index (0=Sun … 6=Sat). "auto" reads
// the system locale's first day via Intl (firstDay 1=Mon … 7=Sun), falling
// back to Monday.
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

function updateWeekStart() {
  weekStartDow = resolveWeekStartDow(readWeekStartPref());
}

function onWeekStartChanged() {
  updateWeekStart();
  renderBar();
}

// Every pref the bar reacts to, paired with its handler. One list drives both
// registration (startup) and teardown (unload) so they can't drift apart.
const PREF_OBSERVERS = [
  [PREF_SESSIONS, onSessionsChanged],
  [PREF_SHOW, onPrefShowChanged],
  [PREF_DAY_START, onDayStartChanged],
  [PREF_VIEW, onViewChanged],
  [PREF_WEEK_START, onWeekStartChanged],
  [PREF_SHORTCUT, buildShortcutKey],
  [PREF_SEPARATOR, onSeparatorChanged],
  [PREF_PLACEMENT, applyPlacement],
  [PREF_PAUSE_ON_BLUR, onPauseOnBlurChanged],
];

// --- activation + startup ----------------------------------------------------
function activate(workspace) {
  // The focus-space features only make sense in normal (synced) windows; skip
  // unsynced/secondary and private windows entirely.
  if (!gZenWorkspaces.currentWindowIsSyncing) {
    return;
  }

  // Time now accrues to this space (until the next switch): close the session
  // in the space we're leaving and open one here. This is set up before the
  // stopwatch UI so logging keeps working even if the indicator isn't present.
  const now = Date.now();
  endSession(now);
  activeUuid = workspace.uuid;
  beginSession(activeUuid, now);

  const indicator = document
    .getElementById(workspace.uuid)
    ?.querySelector(".zen-current-workspace-indicator");
  const timerEl = indicator ? ensureTimerEl(indicator) : null;

  // Blank the space we're leaving so its last value doesn't linger in that
  // indicator and flash when we switch back to it — Zen runs this listener only
  // after the switch animation, during which that stale value would be onscreen.
  if (activeTimerEl && activeTimerEl !== timerEl) {
    activeTimerEl.textContent = "";
  }

  // Reset the session stopwatch for the newly-active space and (re)start the
  // shared tick. The session log is untouched — switching never resets it.
  stopInterval();
  totalSeconds = 0;
  isPaused = false;
  autoPaused = false;
  activeTimerEl = timerEl;
  activeToggleBtn = indicator ? ensureButton(indicator) : null;

  renderTime();
  updateButtonVisual();
  startInterval();
  // Zen syncs space switches across windows, so this also runs in windows that
  // aren't in front: those shouldn't start counting until they are.
  autoPauseIfInactive();

  renderBar();
}

function startupFinish(callback) {
  if (document.readyState === "complete") {
    callback();
  } else {
    window.addEventListener("load", callback, { once: true });
  }
}

const onWorkspaceChange = (data) => activate(data.workspace);

// Remove every element this mod adds to the window: the stopwatch label and
// toggle in each space's indicator, and the ratio bar. Class/id-based rather
// than reference-based so it also sweeps leftovers from a run that can no
// longer be reached (see INSTANCE_KEY) — a fresh run must own fresh nodes,
// since the toggle's click handler is bound to the run that created it.
function removeOwnElements() {
  const nodes = document.querySelectorAll(
    `.${TIMER_LABEL_CLASS}, .${TIMER_BUTTON_CLASS}, ` +
      `#${RATIO_CONTAINER_ID}, #${SESSIONS_PANEL_ID}`,
  );
  for (const node of nodes) {
    if (typeof node.hidePopup === "function" && node.state !== "closed") {
      try {
        node.hidePopup();
      } catch {}
    }
    node.remove();
  }
  panelEl = null;
  panelListEl = null;
  panelEmptyEl = null;
  panelPeriodButtonsEl = null;
  activeTimerEl = null;
  activeToggleBtn = null;
  barEl = null;
  legendRowsEl = null;
  legendEmptyEl = null;
  periodButtonsEl = null;
  lastSignature = "";
}

// Undo everything startup wired up. Runs on window unload and when a newer run
// of this script supersedes this one; idempotent, since both can happen.
function teardown() {
  if (tornDown) {
    return;
  }
  tornDown = true;
  try {
    endSession(Date.now());
    flush();
  } catch {}
  window.removeEventListener("activate", onWindowActivate);
  window.removeEventListener("deactivate", onWindowDeactivate);
  for (const type of INTERACTION_EVENTS) {
    window.removeEventListener(type, onWindowInteraction, true);
  }
  try {
    for (const [pref, handler] of PREF_OBSERVERS) {
      Services.prefs.removeObserver(pref, handler);
    }
  } catch {}
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  stopInterval();
  activeUuid = null;
  try {
    gZenWorkspaces.removeChangeListeners(onWorkspaceChange);
  } catch {}
  try {
    removeShortcutKey();
  } catch {}
  document.documentElement.removeAttribute(PLACEMENT_ATTR);
  removeOwnElements();
  if (window[INSTANCE_KEY] && window[INSTANCE_KEY].teardown === teardown) {
    delete window[INSTANCE_KEY];
  }
}

// Defer setup until the browser chrome has finished loading, so `gZenWorkspaces`
// is present for both the listener registration and the initial activate below.
startupFinish(() => {
  // Retire the previous run of this script, if any, before installing this one;
  // then sweep any of our elements it left behind (or that an older build that
  // never published a handle left behind) so nothing is shared between runs.
  const previous = window[INSTANCE_KEY];
  if (previous && typeof previous.teardown === "function") {
    try {
      previous.teardown();
    } catch (e) {
      console.error("[focus-space] previous instance teardown failed:", e);
    }
  }
  removeOwnElements();
  window[INSTANCE_KEY] = { teardown };
  // Sine's own hook for this: it runs the callback before re-importing the
  // script on a rebuild (toggle, update) and on window unload. Registered as
  // well as the handle above, since the handle also covers loaders without it.
  if (typeof window.addUnloadListener === "function") {
    try {
      window.addUnloadListener(teardown);
    } catch {}
  }

  showBar = readShowPref();
  showSeparator = readSeparatorPref();
  applyPlacement();
  pauseOnBlur = readPauseOnBlurPref();
  dayStartHour = readDayStartHour();
  viewPeriod = readViewPref();
  updateWeekStart();
  migrateLegacyData();
  sessions = readSessions();
  currentDayKey = todayKey();

  gZenWorkspaces.addChangeListeners(onWorkspaceChange);

  // Cover the initial active space, in case its onInit change fired before the
  // listener was registered. Safe to call again: activate() resets cleanly.
  const activeWorkspace = gZenWorkspaces.getWorkspaceFromId(
    gZenWorkspaces.activeWorkspace,
  );
  if (activeWorkspace) {
    activate(activeWorkspace);
  }

  mountBar();

  // Register the pref observers before building the (optional) shortcut key, and
  // isolate that build: it touches more of the platform than anything else here,
  // so should it ever fail — a stricter chrome CSP, a XUL change — the time-ratio
  // bar must still wire up its observers and stay reactive.
  for (const [pref, handler] of PREF_OBSERVERS) {
    Services.prefs.addObserver(pref, handler);
  }
  try {
    buildShortcutKey();
  } catch (e) {
    console.error("[focus-space] pause shortcut setup failed:", e);
  }
  flushTimer = setInterval(flush, FLUSH_MS);

  window.addEventListener("activate", onWindowActivate);
  window.addEventListener("deactivate", onWindowDeactivate);
  for (const type of INTERACTION_EVENTS) {
    window.addEventListener(type, onWindowInteraction, true);
  }
  window.addEventListener("unload", teardown, { once: true });
});

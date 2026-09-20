"use strict";

// Focus Space has two cooperating parts:
//   1. A live session stopwatch in the active workspace indicator (resets on
//      every space switch, with a pause/resume toggle — button or shortcut).
//   2. A "today" time-ratio bar at the sidebar foot: a stacked proportion bar
//      showing how today's time splits across spaces.
// Both are driven by the same 1s tick, so pausing freezes both. The stopwatch
// is per-session (resets on switch); the daily buckets persist (per-day,
// per-space seconds in a pref) and only reset at local midnight.

const HTML_NS = "http://www.w3.org/1999/xhtml";

const TIMER_LABEL_CLASS = "zen-focus-space-timer";
const TIMER_BUTTON_CLASS = "zen-focus-space-timer-toggle";
const ICON_RUNNING = 'url("chrome://browser/skin/zen-icons/media-pause.svg")';
const ICON_PAUSED = 'url("chrome://browser/skin/zen-icons/media-play.svg")';

const RATIO_CONTAINER_ID = "zen-focus-space-ratio";
const PREF_SHOW = "extensions.focus-space.show-ratio-bar";
const PREF_DATA = "extensions.focus-space.daily-data";
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
const FLUSH_MS = 10000;
const RETENTION_DAYS = 90;
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

// --- session stopwatch state -------------------------------------------------
let timerInterval = null;
let totalSeconds = 0;
let isPaused = false;
let activeTimerEl = null;
let activeToggleBtn = null;
let showSeparator = true;
let timerPlacement = DEFAULT_PLACEMENT;

// --- pause/resume shortcut state ---------------------------------------------
// Our isolated <keyset>, re-inserted on rebind so Gecko re-registers the key.
let pauseKeysetEl = null;

// --- daily-tracking state ----------------------------------------------------
// dailyData mirrors the shared pref: { "YYYY-MM-DD": { uuid: seconds } }.
// localUnflushed holds seconds accrued in THIS window since the last flush, so
// multiple windows sum (each flushes its own delta) instead of clobbering.
// Trade-off: a space foregrounded in two windows at once is counted twice, so
// absolute legend times can exceed wall-clock — but the cross-space ratios (the
// point of the bar) stay correct, so we accept it rather than coordinate windows.
let dailyData = {};
let localUnflushed = {};
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
function readData() {
  try {
    const raw = Services.prefs.getStringPref(PREF_DATA, "");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeData(data) {
  try {
    Services.prefs.setStringPref(PREF_DATA, JSON.stringify(data));
  } catch {}
}

function prune(data) {
  const cutoff = cutoffKey();
  for (const key of Object.keys(data)) {
    // ISO date strings compare lexicographically, so this drops old days.
    if (key < cutoff) {
      delete data[key];
    }
  }
}

// Re-read the shared store, add this window's pending delta, write it back.
// Infrequent + delta-based, so the rare cross-window write race loses at most
// a few seconds rather than a whole window's tally.
function flush() {
  const uuids = Object.keys(localUnflushed);
  if (!uuids.length) {
    return;
  }
  const fresh = readData();
  const day = fresh[currentDayKey] || (fresh[currentDayKey] = {});
  for (const uuid of uuids) {
    day[uuid] = (day[uuid] || 0) + localUnflushed[uuid];
  }
  prune(fresh);
  // Update our in-memory view and clear the delta first, then persist, so the
  // observer's re-read — ours fires synchronously here — sees the same totals.
  dailyData = fresh;
  localUnflushed = {};
  writeData(fresh);
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

// Per-space seconds across the selected period: every stored day-key from the
// period start through today (ISO keys compare lexicographically), plus this
// window's not-yet-flushed delta, which always belongs to today.
function periodTotals(period) {
  const startKey = periodStartKey(period);
  const totals = {};
  for (const key of Object.keys(dailyData)) {
    if (key >= startKey && key <= currentDayKey) {
      const day = dailyData[key];
      for (const uuid of Object.keys(day)) {
        totals[uuid] = (totals[uuid] || 0) + day[uuid];
      }
    }
  }
  for (const uuid of Object.keys(localUnflushed)) {
    totals[uuid] = (totals[uuid] || 0) + localUnflushed[uuid];
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
    positionEndTimer();
  }
}

// In the "end" placement the timer is taken out of the indicator's flex flow
// (so the space name is laid out exactly as it would be without a timer) and
// pinned just ahead of the trailing action buttons. Those have no fixed width
// — and are only revealed on hover — so the offset is measured and handed to
// the stylesheet as a variable. Cheap enough to run on each tick; it also
// self-heals when the first call lands before the indicator has a layout.
function positionEndTimer() {
  if (timerPlacement !== "end" || !activeTimerEl) {
    return;
  }
  const indicator = activeTimerEl.parentNode;
  if (!indicator) {
    return;
  }
  const trailing =
    activeToggleBtn || indicator.querySelector(".zen-workspaces-actions");
  if (!trailing) {
    return;
  }
  const indicatorRect = indicator.getBoundingClientRect();
  const trailingRect = trailing.getBoundingClientRect();
  if (!indicatorRect.width || !trailingRect.width) {
    return; // not laid out yet; the next tick will catch it
  }
  const right = Math.max(0, Math.round(indicatorRect.right - trailingRect.left));
  const value = `${right}px`;
  if (indicator.style.getPropertyValue("--zen-fs-timer-right") !== value) {
    indicator.style.setProperty("--zen-fs-timer-right", value);
  }
}

function stopInterval() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// If the logical day has turned over (local midnight, or the configured
// day-start hour), persist the closing day's remainder into the day we're
// leaving and start the new one clean. No-op within the same day.
function rolloverIfNeeded() {
  const key = todayKey();
  if (key === currentDayKey) {
    return;
  }
  flush();
  currentDayKey = key;
  localUnflushed = {};
}

// The shared 1s tick: advances the visible stopwatch AND the active space's
// daily bucket, handles day rollover, then repaints the bar.
function startInterval() {
  stopInterval();
  timerInterval = setInterval(() => {
    rolloverIfNeeded();
    totalSeconds++;
    renderTime();
    if (activeUuid) {
      localUnflushed[activeUuid] = (localUnflushed[activeUuid] || 0) + 1;
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
  activeToggleBtn.setAttribute(
    "tooltiptext",
    isPaused ? "Resume timer" : "Pause timer",
  );
}

function togglePause() {
  isPaused = !isPaused;
  if (isPaused) {
    // Pausing stops the shared tick, so it freezes the daily total too; flush
    // what we have so a long break isn't sitting only in volatile memory.
    stopInterval();
    flush();
  } else {
    startInterval();
  }
  updateButtonVisual();
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
  const head = el("div", { class: "zen-fs-legend-head" }, periodButtonsEl);
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

// --- pref observers ----------------------------------------------------------
function onPrefDataChanged() {
  // Fires on any window's flush, including our own synchronous self-write —
  // harmless, since flush() updates dailyData and clears localUnflushed before
  // persisting, so re-reading here yields the same totals.
  dailyData = readData();
  renderBar();
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
  positionEndTimer();
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
  [PREF_DATA, onPrefDataChanged],
  [PREF_SHOW, onPrefShowChanged],
  [PREF_DAY_START, onDayStartChanged],
  [PREF_VIEW, onViewChanged],
  [PREF_WEEK_START, onWeekStartChanged],
  [PREF_SHORTCUT, buildShortcutKey],
  [PREF_SEPARATOR, onSeparatorChanged],
  [PREF_PLACEMENT, applyPlacement],
];

// --- activation + startup ----------------------------------------------------
function activate(workspace) {
  // The focus-space features only make sense in normal (synced) windows; skip
  // unsynced/secondary and private windows entirely.
  if (!gZenWorkspaces.currentWindowIsSyncing) {
    return;
  }

  // Daily time now accrues to this space (until the next switch). This is set
  // before the stopwatch UI so accrual keeps working even if the indicator
  // isn't present for some reason.
  activeUuid = workspace.uuid;

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
  // shared tick. The daily buckets are untouched — switching never resets them.
  stopInterval();
  totalSeconds = 0;
  isPaused = false;
  activeTimerEl = timerEl;
  activeToggleBtn = indicator ? ensureButton(indicator) : null;

  renderTime();
  updateButtonVisual();
  startInterval();

  renderBar();
}

function startupFinish(callback) {
  if (document.readyState === "complete") {
    callback();
  } else {
    window.addEventListener("load", callback, { once: true });
  }
}

// Defer setup until the browser chrome has finished loading, so `gZenWorkspaces`
// is present for both the listener registration and the initial activate below.
startupFinish(() => {
  showBar = readShowPref();
  showSeparator = readSeparatorPref();
  applyPlacement();
  dayStartHour = readDayStartHour();
  viewPeriod = readViewPref();
  updateWeekStart();
  dailyData = readData();
  currentDayKey = todayKey();

  gZenWorkspaces.addChangeListeners((data) => activate(data.workspace));

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

  window.addEventListener(
    "unload",
    () => {
      try {
        flush();
      } catch {}
      try {
        for (const [pref, handler] of PREF_OBSERVERS) {
          Services.prefs.removeObserver(pref, handler);
        }
      } catch {}
      if (flushTimer !== null) {
        clearInterval(flushTimer);
      }
      stopInterval();
      try {
        removeShortcutKey();
      } catch {}
      document.documentElement.removeAttribute(PLACEMENT_ATTR);
    },
    { once: true },
  );
});

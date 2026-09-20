<h1 align="center">Focus Space</h1>
<div align="center">
    <a href="https://zen-browser.app/">
        <img width="240" alt="zen-badge-dark" src="https://raw.githubusercontent.com/heyitszenithyt/zen-browser-badges/fb14dcd72694b7176d141c774629df76af87514e/light/zen-badge-light.png" />
    </a>
</div>

<div align="center">
    <img width="640" alt="Zen Browser with Focus Space: a live 'Work | 37:05' stopwatch in the workspace indicator, and the sidebar-foot time-ratio bar with its Today/Week/Month breakdown open (Work 71%, Learn 9%, Rest 20%)" src="https://raw.githubusercontent.com/01-1/Zen-Focus-Space/main/preview.png" />
</div>

**Focus Space** adds a live stopwatch to the active workspace indicator in Zen Browser, so you can see at a glance how long you've been focused in the current space. The timer starts the moment you switch into a space and resets when you switch away, with a one-click pause/resume toggle beside the label — or a keyboard shortcut (`F9` by default). A second view — a stacked ratio bar at the foot of the sidebar — shows how your time splits across all your spaces, switchable between today, this week, and this month.

## 🌟 Features

- ⏱️ **Live stopwatch**: An `mm:ss` timer ticks away in the active workspace indicator, right next to the space name.
- ⏸️ **Pause & resume**: A one-click toggle — or a keyboard shortcut (`F9` by default, customizable) — pauses the count and picks up exactly where you left off; it freezes today's tally too.
- 🪟 **Auto-pause when you leave**: Switching to another app (or another Zen window) pauses the stopwatch; coming back resumes it. A pause you made yourself stays put. Can be turned off.
- 🔄 **Per-space reset**: The stopwatch resets automatically each time you switch spaces, so it always reflects your current session — not a running daily total.
- 📊 **Time-ratio bar**: A stacked bar at the sidebar foot shows how your time divides across spaces, each segment in that space's own colour. Hover for a breakdown (name, share, and time per space); click a segment to jump to that space.
- 📝 **Session log, editable**: Every running stretch is logged as a session (space, start, end). A **Sessions** button in the breakdown flyout opens a full-page editor in a tab (or a small panel, if you prefer) to review, correct, add, or delete sessions, grouped by day with totals — the bar reflects edits right away. Even the running session's start can be corrected.
- 🌐 **Page log (optional)**: Turn it on and Focus Space also records *which page* you were on — the active tab's URL and name — as visits nested inside each session. A **Pages** view on the sessions page lists them three ways: every visit, **stays** (back-to-back visits to the same page folded together — anything else in between splits them), or **by URL** with the period's total per page. Searchable, paginated, exportable, and deletable. Off by default.
- 📤 **Export**: Save the listed sessions (today, this week, this month, or everything kept — 90 days) as CSV or JSON from the same editor.
- 🗓️ **Today / Week / Month**: A toggle in the breakdown flyout switches the bar between the current day, calendar week, and calendar month. The day rolls over at 4 AM by default (configurable), so late-night sessions stay with the right day.

## ✅ Requirements

- [Zen Browser](https://zen-browser.app/) — Focus Space is Zen-specific: it hooks into Zen's spaces and the workspace indicator.
- The [Sine](https://github.com/CosmoCreeper/Sine) mod manager, used to install and configure it.

## ⚙️ Installation Guide

First, install the latest version of [Sine](https://github.com/CosmoCreeper/Sine) (if you haven't already) and restart Zen. Then add Focus Space using either method below.

### From a GitHub repo

Focus Space is a JavaScript mod, and Sine blocks JS from outside its official store by default — so until it's listed on the marketplace, allow that first (a one-time toggle):

1. Open Zen **Settings → Sine Mods**.
2. Click the **gear (⚙️)** icon to the right of the GitHub-repo **Install** button, tick **“Enable installing JS from unofficial sources”**, then **Close**.
3. In the **“or, add your own locally from a GitHub repo”** field, enter `01-1/Zen-Focus-Space`.
4. Click **Install**.

Sine flags that toggle *“use at your own risk”* because it lets any repo run code in the browser — Focus Space's whole source lives in this repo, so you can review exactly what it does first.

### From the Sine marketplace

Once Focus Space is listed on the marketplace:

1. Open Zen **Settings → Sine Mods**.
2. Search the **Marketplace** for **Focus Space**.
3. Click **Install**.

Either way, click the restart toast when it appears to restart Zen. Then switch between spaces — the stopwatch appears in the active space's indicator automatically.

## 🎨 Customization

Focus Space works out of the box with no setup required. Switch into a space to start the timer, and use the pause/resume button in the indicator — or press the keyboard shortcut (`F9` by default) — to control it.

### Reviewing and exporting sessions

Hover the time-ratio bar and click **Sessions** in the breakdown flyout. By default this opens a page in a new tab (switch it to a panel over the sidebar under **Open sessions in**). It lists each session for the chosen period (Today / Week / Month / All), grouped by day with a total per day, optionally filtered to one space: change a session's space with the dropdown, or retype its start or end as `YYYY-MM-DD HH:MM:SS` (local time) — edits apply when you leave the field, and an invalid or reversed time is outlined red and not saved. **Add** inserts a session for the last half hour to correct in place; **✕** deletes one. The session that's still running is greyed out — only its start can be changed, and the stopwatch follows. **Export CSV** / **Export JSON** save the listed sessions through the usual file dialog.

### The page log

With **Log the pages you visit** turned on (see below), the **Pages** tab on the sessions page (or the **Pages** button in the panel) shows where the time went. A *visit* is one uninterrupted stretch on a URL while the stopwatch was running — changing URL, pausing, switching space, or the day rolling over ends it; a page merely changing its title doesn't. Pick how to see them:

- **Visits** — every visit on its own, newest first, under day headers.
- **Stays** — back-to-back visits to the same page folded into one row (a pause in the middle, say), while a visit anywhere else in between starts a new row.
- **By URL** — one row per URL for the whole period, most time first.

Rows that fold several visits together show a **N visits** count; click it to see each one. Click a title to open the page (or switch to its tab). The filter box matches titles and URLs; the space dropdown and Today/Week/Month/All apply too. Long lists are paged 100 rows at a time. **✕** deletes a row's visits, **Clear listed** deletes everything currently listed, and the exports save the rows as listed, so the grouping decides whether a line is a visit, a stay, or a URL's total.

Options are available in the `Sine` settings tab:

- **Pause / resume stopwatch** — the keyboard shortcut that toggles the timer. Defaults to **F9**; use a function key, or a letter with a modifier like Ctrl, Alt, or Cmd (e.g. `Alt+Shift+P`) — a bare letter won't bind. Leave it blank to disable.
- **The stopwatch shows** — **The current session** (default) resets each time you switch space; **This space's total for today** carries on from where the space's day total stands, so switching back and forth doesn't start from zero.
- **Show a “|” between the space name and the timer** — on by default. Turn it off for a bare `37:05` after the name.
- **Timer placement** — **Beside the space name** (default) pins the name to its own width so the timer follows it directly. **End of the row** leaves the name's alignment to Zen or your theme (some themes centre it) and floats the timer to the right, next to the pause button.
- **Pause while the window is inactive** — on by default. The stopwatch pauses when the Zen window loses focus and resumes when it regains it; a manual pause is never auto-resumed. Turn it off to keep counting in the background.
- **Open sessions in** — **A tab** (default) or **A panel over the sidebar**.
- **Log the pages you visit (URL and tab title)** — off by default. Records the active tab's URL and name as visits inside each session, for the **Pages** view. The page log lives in your profile folder (`focus-space/visits/`, one file per day) and is kept for 90 days.
- **Show the daily time-ratio bar at the sidebar foot** — on by default. Turn it off to keep just the stopwatch.
- **Start a new day at** — the hour the daily totals roll over, in your local time. Defaults to **4:00 AM**, so a late-night session counts toward the day it began on rather than flipping at midnight.
- **Week starts on** — which day the **Week** view begins. Defaults to **Auto** (your system region); override with Monday, Sunday, or Saturday.

Switch between **Today / Week / Month** with the toggle in the breakdown flyout (hover the bar).

## 🔒 Privacy

Focus Space keeps everything on your machine — no servers, no accounts, no telemetry.

- **Local-only storage.** Your sessions live in a Zen preference (`extensions.focus-space.sessions`); the optional page log lives in your profile folder (`focus-space/visits/`). Neither leaves the browser.
- **Page logging is opt-in.** URLs and tab titles are only recorded if you turn **Log the pages you visit** on, and you can delete any of it from the Pages view. Credentials embedded in a URL (`user:password@host`) are stripped before logging.
- **Short retention.** Only the last 90 days of sessions and visits are kept; older days are pruned automatically.
- **Private windows are ignored.** Time in private or secondary windows is never recorded — only your normal synced windows count.

## 🙏 Credits and Acknowledgements

Created by [Zebeqo](https://github.com/Zebeqo); this fork is maintained at [01-1/Zen-Focus-Space](https://github.com/01-1/Zen-Focus-Space) (upstream: [Zebeqo/Zen-Focus-Space](https://github.com/Zebeqo/Zen-Focus-Space)).

Built for [Zen Browser](https://zen-browser.app/) and the [Sine](https://github.com/CosmoCreeper/Sine) mod manager.

## 📜 License

Released under the MIT License. See [LICENSE](./LICENSE) for details.

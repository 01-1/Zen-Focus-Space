<h1 align="center">Focus Space</h1>
<div align="center">
    <a href="https://zen-browser.app/">
        <img width="240" alt="zen-badge-dark" src="https://raw.githubusercontent.com/heyitszenithyt/zen-browser-badges/fb14dcd72694b7176d141c774629df76af87514e/light/zen-badge-light.png" />
    </a>
</div>

<div align="center">
    <img width="640" alt="Zen Browser with Focus Space: a live 'Work | 37:05' stopwatch in the workspace indicator, and the sidebar-foot time-ratio bar with its Today/Week/Month breakdown open (Work 71%, Learn 9%, Rest 20%)" src="https://raw.githubusercontent.com/Zebeqo/Zen-Focus-Space/main/preview.png" />
</div>

**Focus Space** adds a live stopwatch to the active workspace indicator in Zen Browser, so you can see at a glance how long you've been focused in the current space. The timer starts the moment you switch into a space and resets when you switch away, with a one-click pause/resume toggle beside the label — or a keyboard shortcut (`F9` by default). A second view — a stacked ratio bar at the foot of the sidebar — shows how your time splits across all your spaces, switchable between today, this week, and this month.

## 🌟 Features

- ⏱️ **Live stopwatch**: An `mm:ss` timer ticks away in the active workspace indicator, right next to the space name.
- ⏸️ **Pause & resume**: A one-click toggle — or a keyboard shortcut (`F9` by default, customizable) — pauses the count and picks up exactly where you left off; it freezes today's tally too.
- 🪟 **Auto-pause when you leave**: Switching to another app (or another Zen window) pauses the stopwatch; coming back resumes it. A pause you made yourself stays put. Can be turned off.
- 🔄 **Per-space reset**: The stopwatch resets automatically each time you switch spaces, so it always reflects your current session — not a running daily total.
- 📊 **Time-ratio bar**: A stacked bar at the sidebar foot shows how your time divides across spaces, each segment in that space's own colour. Hover for a breakdown (name, share, and time per space); click a segment to jump to that space.
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
3. In the **“or, add your own locally from a GitHub repo”** field, enter `Zebeqo/Zen-Focus-Space`.
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

Options are available in the `Sine` settings tab:

- **Pause / resume stopwatch** — the keyboard shortcut that toggles the timer. Defaults to **F9**; use a function key, or a letter with a modifier like Ctrl, Alt, or Cmd (e.g. `Alt+Shift+P`) — a bare letter won't bind. Leave it blank to disable.
- **Pause while the window is inactive** — on by default. The stopwatch pauses when the Zen window loses focus and resumes when it regains it; a manual pause is never auto-resumed. Turn it off to keep counting in the background.
- **Show the daily time-ratio bar at the sidebar foot** — on by default. Turn it off to keep just the stopwatch.
- **Start a new day at** — the hour the daily totals roll over, in your local time. Defaults to **4:00 AM**, so a late-night session counts toward the day it began on rather than flipping at midnight.
- **Week starts on** — which day the **Week** view begins. Defaults to **Auto** (your system region); override with Monday, Sunday, or Saturday.

Switch between **Today / Week / Month** with the toggle in the breakdown flyout (hover the bar).

## 🔒 Privacy

Focus Space keeps everything on your machine — no servers, no accounts, no telemetry.

- **Local-only storage.** Your per-space time lives in a single Zen preference (`extensions.focus-space.daily-data`) and never leaves the browser.
- **Short retention.** Only the last 90 days of daily totals are kept; older days are pruned automatically.
- **Private windows are ignored.** Time in private or secondary windows is never recorded — only your normal synced windows count.

## 🙏 Credits and Acknowledgements

Created by [Zebeqo](https://github.com/Zebeqo).

Built for [Zen Browser](https://zen-browser.app/) and the [Sine](https://github.com/CosmoCreeper/Sine) mod manager.

## 📜 License

Released under the MIT License. See [LICENSE](./LICENSE) for details.

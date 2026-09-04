# omarchy-singularity

[SingularityApp](https://singularity-app.com/) tasks on the [Omarchy](https://omarchy.org/) desktop.

![ci](https://github.com/IgorKramar/omarchy-singularity/actions/workflows/ci.yml/badge.svg)
![Omarchy](https://img.shields.io/badge/Omarchy-shell%20plugin-7aa2f7)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

> **Status: in development.** The bar pill, the popup and the headless service work; the
> overlay is not built yet, and the popup is read-only — checking off, inline edit and quick
> add are still to come.

## What it will be

One plugin, three surfaces, one source of truth:

| Surface | Kind | What it shows |
| --- | --- | --- |
| Bar pill | `bar-widget` | count of today's and overdue tasks |
| Popup | `bar-widget` | tasks grouped by project, three tabs, full keyboard control, complete / rename / add |
| Overlay | `overlay` | full screen: Overdue / Today / Tomorrow columns, checklists, habits with streaks, time tracking |

All API work — token, polling, cache — lives in a headless `service`. The bar widget and the overlay only render what the service holds, so the two never disagree.

## The popup

Clicking the pill opens the popup: the tasks the number is made of, grouped into collapsible
sections by project. Three ways in — click the pill, press `Esc` or click again to close, or
drive it from the shell:

```bash
omarchy-shell singularity.popup toggle   # also: open, close, show, hide
```

The IPC target is `singularity.popup`, separate from the service's own `singularity`, and it
carries window commands only — never task titles or the cache. On a multi-monitor setup the
popup opens on the focused output.

Three tabs — **Сегодня**, **Все**, **Просрочено** — are three slices of the same cache, so
switching between them never costs a request. "Все" is the whole window, exactly the number
the pill shows. Overdue is recomputed from the current time rather than read off a flag
frozen when the response was parsed, so a popup left open across midnight tells the truth.

Opening asks the service for fresh data when the last sync is more than a minute old, and the
footer says both that an update is running and when the last one landed.

Projects excluded from the count (see below) are not omitted: each appears in its place as a
dimmed, collapsed section, and opens like any other. The footer says how many **tasks** are
hidden. Expanding one does not change any count.

### Acting on a task

Every task row carries a checkbox. Click it, or press `Space` with the row selected, and the
task is completed. Clicking the row itself — or `Enter` — opens it: the note, whichever fields
carry a value, and a link out to the web app. One task is open at a time.

The checkbox does not tick on its own the moment you press it. A round trip to the API takes
about half a second, and a task that vanished before the server confirmed would have to come
back on failure — so the row keeps its place and wears a "sent" mark until the answer lands.
A write that fails says so in the footer and leaves the list alone; it never repaints the
popup as a broken service, because one checkbox that did not save is not an outage.

**A recurring task shows a repeat glyph instead of a checkbox.** Such a task is two objects in
SingularityApp — a generator and the instances it produces — and completing an instance
through this API is not something the API offers. A dimmed checkbox would still read as a
checkbox, so the slot carries a different mark rather than a disabled one.

Renaming happens in place: `e` turns the title into a field with the text selected. A new task
goes in the field at the bottom of the list, which `n` jumps to from anywhere; it lands in
Входящие with today's date. Both fields keep what you typed until the server confirms — a
failed write leaves the text where you can retry it — and `Esc` backs out of either without
sending anything.

### Keyboard

| Key | What it does |
| --- | --- |
| `↑` `↓` `k` `j` | move the selection through rows and section headers |
| `←` `→` `h` `l` | switch tabs |
| `Enter` | unfold a section, or open the selected task |
| `Space` | complete the selected task (fold/unfold on a section header) |
| `e` `у` | rename the selected task in place |
| `n` `т` | jump to the new-task field at the bottom |
| `o` `щ` | open the selected task's project in the web app |
| `Tab` `Shift+Tab` | move to the neighbouring bar panel |
| `Esc` | leave the field, or close the popup |

The letter commands answer to their Cyrillic twins by key position. The tasks here are written
in Russian, so the layout is Russian while reading them — a command bound to the Latin letter
alone goes silent exactly when it is wanted.

Tabs sit on the horizontal keys rather than on `Tab` because the shell's key dispatcher
delivers `h`/`l` and the horizontal arrows as one signal: horizontal carries one meaning, and
`Tab` keeps the meaning it has in every other panel of the shell. Folding therefore moved to
`Enter`.

The selection is held by task, not by row number — a task arriving above it does not shift it.
When the selected task leaves the window, the selection moves to the next task in its own
section, then the previous one, then the section header.

## Requirements

- Omarchy shell (plugin API `schemaVersion: 1`)
- SingularityApp **Pro** or **Elite** plan — the REST API is only available there
- an API token from the SingularityApp web app with access to *Task* (read + write), and optionally *Project*, *Habit*, *Checklist*, *Tag*, *Time statistics*

## Install

```bash
omarchy plugin add https://github.com/IgorKramar/omarchy-singularity.git
omarchy plugin enable io.github.igorkramar.singularity
```

`omarchy plugin enable` puts the bar widget into the bar layout; the shell starts the headless service from that same entry, so nothing else needs editing in `shell.json`.

### Token

The token is never passed on the command line (that is visible to every process on the machine). The service reads it from a file and hands it to `curl` through stdin:

```bash
dir=~/.local/state/omarchy/io.github.igorkramar.singularity
mkdir -p "$dir"
(umask 077; read -rsp 'Token: ' t; echo; printf '{"apiToken":"%s"}\n' "$t" > "$dir/settings.json")
```

`read -s` keeps the token out of your shell history, and `umask 077` creates the file as `600` from the start.

The service watches the file, so a token placed after the shell started is picked up without a restart, and it tightens the file to `600` itself if you forgot. Check the state:

```bash
omarchy-shell singularity status    # {"status":"no-token"|"loading"|"ready"|"error", "errorText":…, "tasks":[…], …}
omarchy-shell singularity refresh   # force a full fetch
```

### Filtering projects out of the count

Some projects are noise in a count: annual birthdays, public holidays, anything that recurs
forever and needs no action today. List them and they stop counting.

The filter is applied by the service, not by the pill, so it holds for every surface of the
plugin — the popup and the overlay will show the same set the count is taken from.

**Omarchy has no built-in settings screen.** There are two ways to set the list, and the first
one always works:

1. **Edit the widget's entry in `shell.json`** (`~/.config/omarchy/shell.json`), under the bar
   section that holds the widget:

   ```json
   { "id": "io.github.igorkramar.singularity",
     "excludedProjects": "Birthdays, Public holidays" }
   ```

   Add the key to the widget's existing entry — the entry is keyed by `id`, and the shell
   resolves bar entries by that field alone. The shell watches the file, so the count
   changes without a restart.

   Every bar entry for this widget feeds one service, so on a multi-monitor setup the last
   entry to load wins. Give them all the same `excludedProjects`.

2. **The settings form**, if you have the third-party
   [`plugin-control-center`](https://github.com/brm-src/omarchy-plugin-control-center) plugin.
   The manifest declares the schema for it; without that plugin nothing renders the form, which
   is why the first way is not optional.

Projects are matched **by name, not by id** — an id like `P-81478cf7-…` is not something you
would type into a file by hand. Comparison ignores case and surrounding spaces. A comma-separated
string and a JSON array are both accepted.

Three consequences worth knowing:

- Renaming a project in SingularityApp silently switches its exclusion off. The count goes up;
  fix the name in the file.
- A name matches **every** project that carries it. SingularityApp does not promise unique names.
- Excluding a parent does **not** exclude its subprojects. List them too.

Check what the service actually has:

```bash
omarchy-shell singularity status                  # visibleCount, overdueCount, excludedProjects, filterApplied
omarchy-shell singularity exclude "Birthdays"     # transient override, for checking the filter
```

`status` reports `tasks` (the filtered view every surface reads) beside `allTasks` (the full
window), so you can see what the filter removed. `exclude` is **not persisted**: the widget
re-pushes its `shell.json` value on the next settings change, so anything you want to keep
goes in the file.

`filterApplied` is `false` when a list is set but the project cache has not arrived yet: names
cannot be resolved, so the count you see is the unfiltered one. The pill says so in its tooltip
rather than passing the larger number off as filtered.

## Development

Clone anywhere and symlink into the plugin directory — the shell hot-reloads on every save (if a change behind the symlink is not picked up, run `omarchy-shell shell rescanPlugins`):

```bash
ln -sfn "$PWD" ~/.config/omarchy/plugins/io.github.igorkramar.singularity
omarchy plugin enable io.github.igorkramar.singularity
```

Validate from the checkout, not through the symlink — the validator treats a symlinked plugin path as a symlink inside the plugin and refuses it:

```bash
omarchy plugin validate "$PWD"
TZ=Asia/Omsk node --test test/api.test.mjs   # the same step CI runs, file named on purpose
```

The test file is named explicitly: `node --test` exits 0 when it discovers no test files, so
a rename would leave the job green at zero checks. `Api.mjs` is a plain ES module shared by
QML and Node. The `qml` on `PATH` is Qt 5 and cannot load it; use `/usr/lib/qt6/bin/qml` for local QML checks.

The API spec is public: <https://api.singularity-app.com/v2/api-json>.

## License

MIT

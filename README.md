# omarchy-singularity

[SingularityApp](https://singularity-app.com/) tasks on the [Omarchy](https://omarchy.org/) desktop.

![ci](https://github.com/IgorKramar/omarchy-singularity/actions/workflows/ci.yml/badge.svg)
![Omarchy](https://img.shields.io/badge/Omarchy-shell%20plugin-7aa2f7)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

> **Status: in development.** The bar pill and the headless service work; the popup and the
> overlay are not built yet.

## What it will be

One plugin, three surfaces, one source of truth:

| Surface | Kind | What it shows |
| --- | --- | --- |
| Bar pill | `bar-widget` | count of today's and overdue tasks |
| Popup | `bar-widget` | tasks grouped by project, check off, inline edit, quick add |
| Overlay | `overlay` | full screen: Overdue / Today / Tomorrow columns, checklists, habits with streaks, time tracking |

All API work — token, polling, cache — lives in a headless `service`. The bar widget and the overlay only render what the service holds, so the two never disagree.

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
   { "module": "io.github.igorkramar.singularity",
     "excludedProjects": "Birthdays, Public holidays" }
   ```

   The shell watches the file, so the count changes without a restart.

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
omarchy-shell singularity status                       # visibleCount, overdueCount, excludedProjects, filterApplied
omarchy-shell singularity exclude "Birthdays"          # set the list without touching shell.json
```

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
node --test                       # Api.mjs unit tests, the same step CI runs
```

`Api.mjs` is a plain ES module shared by QML and Node. The `qml` on `PATH` is Qt 5 and cannot load it; use `/usr/lib/qt6/bin/qml` for local QML checks.

The API spec is public: <https://api.singularity-app.com/v2/api-json>.

## License

MIT

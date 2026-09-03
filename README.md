# omarchy-singularity

[SingularityApp](https://singularity-app.com/) tasks on the [Omarchy](https://omarchy.org/) desktop.

![ci](https://github.com/IgorKramar/omarchy-singularity/actions/workflows/ci.yml/badge.svg)
![Omarchy](https://img.shields.io/badge/Omarchy-shell%20plugin-7aa2f7)
![License](https://img.shields.io/badge/license-MIT-brightgreen)

> **Status: in development.** Nothing to install yet — the plugin is being built surface by surface.

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

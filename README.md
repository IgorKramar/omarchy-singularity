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
omarchy plugin add https://github.com/IgorKramar/omarchy-singularity.git --enable
```

The token is never passed on the command line (that is visible to every process on the machine). It is read from
`~/.local/state/omarchy/io.github.igorkramar.singularity/settings.json` (`chmod 600`) and handed to `curl` through stdin.

## Development

Clone anywhere and symlink into the plugin directory — the shell hot-reloads on every save:

```bash
ln -sfn "$PWD" ~/.config/omarchy/plugins/io.github.igorkramar.singularity
omarchy plugin validate ~/.config/omarchy/plugins/io.github.igorkramar.singularity
```

The API spec is public: <https://api.singularity-app.com/v2/api-json>.

## License

MIT

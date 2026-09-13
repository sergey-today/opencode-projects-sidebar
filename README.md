# OpenCode Projects Sidebar

A projects and sessions sidebar for the [OpenCode](https://opencode.ai/) TUI.

The plugin uses OpenCode's native session sidebar slot, so the standard chat
layout remains intact. It groups sessions by project, shows session status,
and lets you open a session directly from the sidebar.

## Requirements

- OpenCode 1.18.27 or a compatible release with TUI plugin slots
- A terminal with at least 128 columns for automatic first-time opening

The plugin currently renders in the native session sidebar. It is not shown
on the home screen because OpenCode does not expose a home-screen sidebar slot.

## Installation

Add the npm package to your OpenCode configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-projects-sidebar"]
}
```

Restart OpenCode after changing the configuration.

To use custom options, use the tuple form:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "opencode-projects-sidebar",
      {
        "width": 36,
        "limit": 50
      }
    ]
  ]
}
```

## Usage

- The project and session list is always rendered inside OpenCode's standard
  session sidebar below the native LSP section.
- Click a project header to collapse or expand its sessions.
- Click a session to open it.

## Options

| Option | Default | Description |
| --- | ---: | --- |
| `width` | `36` | Maximum text width used for names, clamped to 20-60 columns |
| `limit` | `50` | Maximum number of sessions to request |

## Development

```sh
npm install
npm run typecheck
```

The package intentionally ships the TypeScript/TSX entry point. OpenCode
loads TypeScript plugins directly.

## License

MIT

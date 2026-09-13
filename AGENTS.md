# Agent Instructions

## Project Overview

- The plugin entry point is `projects-sidebar.tsx`.
- The package ships the TypeScript/TSX source directly. There is no build step.
- `npm run typecheck` runs the TypeScript validation.

Keep the repository file as the source of truth. The OpenCode process used for
manual testing may load a separate local copy from:

```text
~/.config/opencode/plugins/projects-sidebar.tsx
```

## Local Testing Without Reinstalling

After changing `projects-sidebar.tsx`:

1. Run the static check:

   ```sh
   npm run typecheck
   git diff --check
   ```

2. Copy the source file to the local plugin location. This does not build,
   publish, or reinstall the package:

   ```sh
   cp ./projects-sidebar.tsx ~/.config/opencode/plugins/projects-sidebar.tsx
   ```

3. Fully exit all OpenCode processes and start OpenCode again. The plugin is
   loaded when the process starts, so opening a new session is not enough.

4. Open the projects sidebar with its configured key binding or `ctrl+s`.
   Check the changed behavior in the TUI.

For status-indicator changes, test these cases:

- A running session shows the orange animated spinner.
- When a response finishes while another session is open, the finished session
  shows the green filled circle.
- Opening that finished session clears the green indicator.
- The title remains separated from the status symbol by one space.

Do not run `npm publish`, rebuild the plugin, or reinstall the package for this
local iteration workflow.

## Change Verification

Before completing a change:

- Run `npm run typecheck`.
- Run `git diff --check`.
- Review `git diff` and keep unrelated worktree changes intact.
- If the active local copy was updated for testing, make the same change in the
  repository source first and confirm both files match.

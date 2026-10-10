# `manager`

This directory contains the code that wires GNOME Shell events to the
rounded-corners effect and manages the lifecycle of that effect for each
window.

## `event_manager.ts`

Responsible **only** for signal wiring: attaches and detaches the GNOME Shell
signals that drive the extension (window-created, resize, focus, destroy,
etc.), and routes each one to the matching handler.

## `event_handlers.ts`

Handler orchestration — implements the callback for each signal and delegates
heavy lifting to the focused modules below.

## `window_state.ts`

Shared runtime state:

- `WindowEffectState` — interface describing the per-window data tracked by the extension.
- `windowStateMap` — WeakMap that associates each managed actor with its state.

## `actor_helpers.ts`

Stateless accessor helpers with no side effects:

- `unwrapActor` — resolves the correct Clutter actor to attach effects to (Wayland vs X11).
- `getRoundedCornersEffect` — fetches the `RoundedCornersEffect` instance for an actor.
- `getRoundedCornersCfg` — resolves the per-window or global rounded-corner settings.

## `geometry.ts`

Pure geometry / math functions with no I/O and no side effects:

- `computeWindowContentsOffset` — delta between buffer rect and frame rect.
- `computeBounds` — outer clipping bounds for the shader, with per-app insets.


## `eligibility.ts`

Decides whether a window should receive the rounded-corners effect:

- `clearAppTypeCache` — clears the app-type cache on disable.
- `isPermanentlyIneligible` — fast synchronous checks (DING, blacklist, window type).
- `shouldEnableEffect` — full check including async toolkit-type detection.
- Private: `getAppTypeAsync`, `_detectFromMapFiles`, `_detectFromMaps` — async
  detection of LibAdwaita / LibHandy / Other via `/proc` filesystem.

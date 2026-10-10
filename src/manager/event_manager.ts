/**
 * @file Wires GNOME Shell signals to the rounded-corners effect lifecycle.
 *
 * This module is a thin orchestration layer: it connects global signals
 * (window-created, minimize, destroy, etc.) and delegates all per-actor
 * bookkeeping to {@link actor_tracker.ts}.
 *
 * See {@link enableEffect} for the entry point.
 */

import type Meta from 'gi://Meta';
import type Shell from 'gi://Shell';
import type {RoundedWindowActor} from '../utils/types.js';

import {logDebug} from '../utils/log.js';
import * as tracker from './actor_tracker.js';
import * as handlers from './event_handlers.js';
import {GlobalSignalManager} from './signal_manager.js';

let globalSignals: GlobalSignalManager | null = null;

/**
 * The rounded corners effect has to perform some actions when different events
 * happen. For example, when a new window is opened, the effect has to detect
 * it and add rounded corners to it.
 *
 * The `enableEffect` method handles this by attaching the necessary signals
 * to matching handlers on each effect.
 */
export async function enableEffect() {
    const {loadRoundedCornersShader} = await import(
        '../effect/rounded_corners_effect.js'
    );
    await Promise.all([loadRoundedCornersShader()]);

    globalSignals = new GlobalSignalManager();
    tracker.init();

    const wm = global.windowManager;

    // Add the effect to all windows when the extension is enabled.
    const windowActors = global.get_window_actors();
    logDebug(`Initial window count: ${windowActors.length}`);
    for (const actor of windowActors) {
        tracker.applyEffectTo(actor as RoundedWindowActor);
    }

    // Add the effect to new windows when they are opened.
    globalSignals.connect(
        global.display,
        'window-created',
        (_: Meta.Display, win: Meta.Window) => {
            tracker.onWindowCreated(win);
        },
    );

    globalSignals.connect(
        wm,
        'minimize',
        (_: Shell.WM, actor: Meta.WindowActor) =>
            handlers.onMinimize(actor as RoundedWindowActor),
    );
    globalSignals.connect(
        wm,
        'unminimize',
        (_: Shell.WM, actor: Meta.WindowActor) =>
            handlers.onUnminimize(actor as RoundedWindowActor),
    );

    globalSignals.connect(
        wm,
        'destroy',
        (_: Shell.WM, actor: Meta.WindowActor) => {
            tracker.onWindowDestroyed(actor);
        },
    );
}

export function disableEffect() {
    tracker.cleanupAllActors();
    tracker.shutdown();

    globalSignals?.disconnectAll();
    globalSignals = null;
}

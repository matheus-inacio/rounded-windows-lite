/**
 * @file Manages the lifecycle of individual window actors within the
 * rounded-corners extension — tracking which actors are alive, initialized,
 * pending, and coordinating effect application/removal.
 *
 * All per-actor WeakMap/WeakSet state lives here, keeping
 * {@link event_manager.ts} focused on pure signal wiring.
 */

import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {logDebug} from '../utils/log.js';
import {getWindowId} from '../utils/window.js';
import {isPermanentlyIneligible} from './eligibility.js';
import * as handlers from './event_handlers.js';
import {ActorSignalManager} from './signal_manager.js';

// ---------------------------------------------------------------------------
// Per-actor tracking state
// ---------------------------------------------------------------------------

let pendingEffectApplications: WeakMap<Meta.WindowActor, number>;
let pendingWmClassListeners: WeakMap<Meta.Window, number>;
let pendingSettleCallbacks: WeakMap<RoundedWindowActor, number>;
let pendingResizeActors: WeakSet<RoundedWindowActor>;
let initializedActors: WeakSet<RoundedWindowActor>;
let destroyedActors: WeakSet<Meta.WindowActor>;

let actorSignals: ActorSignalManager | null = null;

// ---------------------------------------------------------------------------
// Module lifecycle
// ---------------------------------------------------------------------------

/** Initialize all tracking state. Call once from {@link enableEffect}. */
export function init(): void {
    pendingEffectApplications = new WeakMap();
    pendingWmClassListeners = new WeakMap();
    pendingSettleCallbacks = new WeakMap();
    pendingResizeActors = new WeakSet();
    initializedActors = new WeakSet();
    destroyedActors = new WeakSet();
    actorSignals = new ActorSignalManager();
}

/** Tear down all tracking state. Call once from {@link disableEffect}. */
export function shutdown(): void {
    actorSignals = null;
}

// ---------------------------------------------------------------------------
// Window creation / destruction (called from event_manager signal handlers)
// ---------------------------------------------------------------------------

/**
 * Handle a newly created window: schedule the effect application, waiting
 * for the WM class to resolve if necessary.
 */
export function onWindowCreated(win: Meta.Window): void {
    const actor = win.get_compositor_private() as Meta.WindowActor;

    // If there's already a pending application for this actor, don't pile on.
    if (pendingEffectApplications.has(actor)) return;

    const scheduleApply = () => {
        // Bail out immediately if the actor is already in the process of being destroyed
        if (!isAlive(actor)) return;
        if (pendingEffectApplications.has(actor)) return;

        const idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pendingEffectApplications.delete(actor);

            // Double-check inside the idle loop
            if (!isAlive(actor)) return GLib.SOURCE_REMOVE;

            applyEffectTo(actor as RoundedWindowActor);
            return GLib.SOURCE_REMOVE;
        });
        pendingEffectApplications.set(actor, idleId);
    };

    // If wm_class_instance of Meta.Window is null, wait for it to be
    // set before applying the effect.
    if (getWindowId(win) == null) {
        const notifyId = win.connect('notify::wm-class', () => {
            win.disconnect(notifyId);
            pendingWmClassListeners.delete(win);
            scheduleApply();
        });
        pendingWmClassListeners.set(win, notifyId);
    } else {
        scheduleApply();
    }
}

/**
 * Handle a window being destroyed by the window manager: cancel any pending
 * idle callbacks and mark the actor as dead.
 */
export function onWindowDestroyed(actor: Meta.WindowActor): void {
    // Mark the actor as dead immediately so any pending idle
    // callbacks can bail out via the fast-path in isAlive()
    // without touching the disposed GObject.
    destroyedActors.add(actor);

    const win = actor.metaWindow;

    // Clean up the wm-class listener if the window is destroyed before the class resolves
    if (win) {
        const notifyId = pendingWmClassListeners.get(win);
        if (notifyId) {
            win.disconnect(notifyId);
            pendingWmClassListeners.delete(win);
        }
    }

    const idleId = pendingEffectApplications.get(actor);
    if (idleId) {
        GLib.source_remove(idleId);
        pendingEffectApplications.delete(actor);
    }
}

// ---------------------------------------------------------------------------
// Effect application / removal
// ---------------------------------------------------------------------------

export function applyEffectTo(actor: RoundedWindowActor): void {
    // Bail out immediately if the actor has been destroyed
    if (!isAlive(actor)) {
        return;
    }

    // Prevent double-initialization of signals
    if (initializedActors.has(actor)) {
        return;
    }

    if (!actor.firstChild) {
        const signalId = actorSignals!.connect(
            actor,
            actor,
            'notify::first-child',
            () => {
                actorSignals!.disconnect(actor, signalId);
                applyEffectTo(actor);
            },
        );
        return;
    }

    const texture = actor.get_texture();
    const metaWindow = actor.metaWindow;

    if (!(texture && metaWindow)) {
        return;
    }

    if (isPermanentlyIneligible(metaWindow)) {
        logDebug('Skipping window (Permanently Ineligible on Initialization)');
        return;
    }

    // Flag as initialized before binding the massive signal list
    initializedActors.add(actor);

    // --- FIX: Prevent GC Sweep Crashes on MetaShapedTexture ---
    // If the texture is replaced or destroyed, we must proactively disconnect
    // its signals before the garbage collector sweeps it.
    actorSignals!.connect(actor, actor, 'notify::first-child', () => {
        if (actor.get_texture() !== texture) {
            removeEffectFrom(actor);
            applyEffectTo(actor);
        }
    });

    // Window resized.
    //
    // Both signals are required because they track different compositor layers:
    // 1. actor 'notify::size' (ClutterActor): Tracks layout allocation on the stage.
    //    Essential during window mapping/launching (e.g. Dash to Dock animations)
    //    where the actor starts at 0x0 and allocates after the buffer is already attached;
    //    missing this leaves shader bounds at 0x0, rendering windows invisible.
    // 2. texture 'size-changed' (MetaShapedTexture): Tracks client GPU buffer commits.
    //    Essential for XWayland clients (where the window actor is sized before the
    //    backing Wayland surface attaches its first buffer) and viewport/buffer scale changes.
    //
    // On Wayland, both fire in the same commit frame. handleResized() debounces them
    // via a microtask so geometry lookups and shader uniform updates run only once.
    actorSignals!.connect(actor, actor, 'notify::size', () =>
        handleResized(actor, 'actor:notify::size'),
    );
    actorSignals!.connect(actor, texture, 'size-changed', () =>
        handleResized(actor, 'texture:size-changed'),
    );

    // Get notified about fullscreen explicitly, since a window must not change in
    // size to go fullscreen
    actorSignals!.connect(actor, metaWindow, 'notify::fullscreen', () =>
        handleResized(actor, 'window:notify::fullscreen'),
    );

    // Focus / Workspace changes
    actorSignals!.connect(actor, metaWindow, 'notify::appears-focused', () =>
        handleFocusChanged(actor),
    );

    // Workspace or monitor of the window changed.
    actorSignals!.connect(actor, metaWindow, 'workspace-changed', () =>
        handleFocusChanged(actor),
    );

    // Parent actor destruction covers normal window closing
    actorSignals!.connect(actor, actor, 'destroy', () => {
        destroyedActors.add(actor);
        removeEffectFrom(actor);
    });

    handlers.onAddEffect(actor);
}

export function removeEffectFrom(actor: RoundedWindowActor): void {
    initializedActors.delete(actor);
    pendingResizeActors.delete(actor);

    cancelSettle(actor);

    actorSignals?.disconnectAll(actor);
    handlers.onRemoveEffect(actor);
}

// ---------------------------------------------------------------------------
// Synchronous event handlers
// ---------------------------------------------------------------------------

/**
 * Handles resize events with a dual microtask-coalesced + deferred settle strategy.
 *
 * 1. **Coalesced update** — debounces back-to-back resize signals within the same
 *    frame (e.g. `texture:size-changed` and `actor:notify::size` firing in the same
 *    Wayland buffer commit) via a microtask, ensuring geometry lookups run only once
 *    after both the texture and actor dimensions are in sync.
 * 2. **Deferred "settle" update** — schedule a `BEFORE_REDRAW` callback that
 *    re-reads all geometry one final time. During rapid resizing,
 *    `actor.width`/`actor.height` (Clutter layer) and
 *    `win.get_frame_rect()`/`win.get_buffer_rect()` (Mutter layer) can be
 *    momentarily out of sync. The settle callback fires after the compositor
 *    has reconciled everything, guaranteeing the shader ends up with the
 *    correct final bounds.
 *
 * Each new resize cancels the previous pending settle callback, so only the
 * last one in a burst actually executes.
 */
function handleResized(actor: RoundedWindowActor, source = 'resize'): void {
    if (!isAlive(actor)) return;

    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(
            'Optimization skip triggered: Detaching signals and removing effect from window',
        );
        removeEffectFrom(actor);
        return;
    }

    if (pendingResizeActors.has(actor)) {
        logDebug(
            () =>
                `[Resize] Coalesced duplicate ${source} signal for "${actor.metaWindow?.title ?? 'window'}"`,
        );
        return;
    }
    pendingResizeActors.add(actor);

    Promise.resolve().then(() => {
        pendingResizeActors.delete(actor);

        if (!isAlive(actor)) return;
        if (!initializedActors.has(actor)) return;

        logDebug(
            () =>
                `[Resize] Executing resize update triggered by ${source} for "${actor.metaWindow?.title ?? 'window'}"`,
        );

        // Synchronous: keep the shader close to correct during the resize.
        handlers.onSizeChanged(actor);

        // Deferred: schedule a final re-sync once the compositor has settled.
        scheduleSettle(actor);
    });
}

function handleFocusChanged(actor: RoundedWindowActor): void {
    if (!isAlive(actor)) return;

    if (actor.metaWindow && isPermanentlyIneligible(actor.metaWindow)) {
        logDebug(
            'Optimization skip triggered: Detaching signals and removing effect from window',
        );
        removeEffectFrom(actor);
        return;
    }
    handlers.onFocusChanged(actor);
}

// ---------------------------------------------------------------------------
// Bulk cleanup (called from disableEffect)
// ---------------------------------------------------------------------------

/**
 * Cancel all pending callbacks and remove the effect from every tracked actor.
 */
export function cleanupAllActors(): void {
    for (const actor of global.get_window_actors()) {
        const id = pendingEffectApplications.get(actor as Meta.WindowActor);
        if (id) {
            GLib.source_remove(id);
            pendingEffectApplications.delete(actor as Meta.WindowActor);
        }

        cancelSettle(actor as RoundedWindowActor);

        // Guard: the actor may have been disposed by Mutter's C code
        // (e.g. X11 reparenting) without our 'destroy' handler firing,
        // so accessing .metaWindow would trigger a "already disposed" warning.
        if (isAlive(actor)) {
            const win = (actor as Meta.WindowActor).metaWindow;
            if (win) {
                const notifyId = pendingWmClassListeners.get(win);
                if (notifyId) {
                    if (isAlive(win)) {
                        win.disconnect(notifyId);
                    }
                    pendingWmClassListeners.delete(win);
                }
            }
        }

        removeEffectFrom(actor as RoundedWindowActor);
    }
}

// ---------------------------------------------------------------------------
// Settle callback helpers
// ---------------------------------------------------------------------------

/**
 * Schedule a `BEFORE_REDRAW` callback that re-reads geometry for `actor`.
 * Any previously pending settle for the same actor is cancelled first.
 */
function scheduleSettle(actor: RoundedWindowActor): void {
    cancelSettle(actor);

    const laters = global.compositor.get_laters();
    const laterId = laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
        pendingSettleCallbacks.delete(actor);

        if (!isAlive(actor)) return false;

        handlers.onSizeChanged(actor);
        return false; // GLib.SOURCE_REMOVE — run only once
    });
    pendingSettleCallbacks.set(actor, laterId);
}

/**
 * Cancel any pending settle callback for `actor`, if one exists.
 */
function cancelSettle(actor: RoundedWindowActor): void {
    const existingId = pendingSettleCallbacks.get(actor);
    if (existingId) {
        global.compositor.get_laters().remove(existingId);
        pendingSettleCallbacks.delete(actor);
    }
}

// ---------------------------------------------------------------------------
// GObject liveness check
// ---------------------------------------------------------------------------

function isAlive(obj: any): boolean {
    // Fast-path: if we already know this object has been destroyed via our
    // own bookkeeping, avoid touching the GObject at all.  This prevents GJS
    // from logging a noisy "Object … has been already disposed" warning to
    // the system journal even though the exception would be caught below.
    if (destroyedActors.has(obj)) {
        return false;
    }
    try {
        return !obj?.is_destroyed?.();
    } catch {
        // GJS throws when accessing any property on a disposed GObject.
        // Optional chaining cannot prevent this because the proxy trap
        // fires before `?.` can short-circuit. The thrown error itself
        // confirms the object is dead.
        return false;
    }
}

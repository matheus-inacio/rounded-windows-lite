/**
 * @file Implements the event handler callbacks that are wired to GNOME Shell
 * signals by {@link event_manager.ts}.
 *
 * This file intentionally owns only handler *orchestration* — the decision of
 * what to do when a specific event fires.  Heavy lifting is delegated to the
 * focused modules:
 *
 *  - {@link actor_helpers.ts} — stateless actor/effect lookups
 *  - {@link geometry.ts}      — bounds and offset maths
 *  - {@link eligibility.ts}   — window eligibility checks
 *  - {@link shadow.ts}        — shadow actor lifecycle
 *  - {@link window_state.ts}  — shared runtime state
 */

import type Clutter from 'gi://Clutter';
import type Meta from 'gi://Meta';
import type Mtk from '@girs/mtk-18';
import type {RoundedWindowActor} from '../utils/types.js';

import GLib from 'gi://GLib';

import {RoundedCornersEffect} from '../effect/rounded_corners_effect.js';
import {ROUNDED_CORNERS_EFFECT} from '../utils/constants.js';
import {logDebug, logTime, logTimeEnd} from '../utils/log.js';
import {getRoundedCornersEffect, unwrapActor} from './actor_helpers.js';
import {shouldEnableEffect} from './eligibility.js';
import {
    computeBounds,
    computeShadowInsets,
    computeWindowContentsOffset,
} from './geometry.js';
import {type WindowEffectState, windowStateMap} from './window_state.js';
// ---------------------------------------------------------------------------
// Public event handlers
// ---------------------------------------------------------------------------

export function onAddEffect(actor: RoundedWindowActor): void {
    const win = actor?.metaWindow;
    if (!win) {
        logDebug('Skipping effect addition: actor has no metaWindow');
        return;
    }

    logTime('onAddEffect');

    logDebug('Adding effect to window');

    // 1. Guard against 0x0 or invalid Wine/Proton windows
    const frameRect = win.get_frame_rect();
    const actorWidth = actor.width;
    const actorHeight = actor.height;
    if (
        frameRect.width <= 0 ||
        frameRect.height <= 0 ||
        actorWidth <= 0 ||
        actorHeight <= 0
    ) {
        logDebug('Skipping window: Invalid geometry (0x0)');
        logTimeEnd('onAddEffect');
        return;
    }

    const windowState = {
        maximized: win.maximizedHorizontally || win.maximizedVertically,
        fullscreen: win.fullscreen,
    };

    // 2. Guard against windows that shouldn't have the effect
    if (!shouldEnableEffect(win, windowState)) {
        logDebug('Skipping window');
        logTimeEnd('onAddEffect');
        return;
    }

    // 3. Guard against duplicate effect applications or leaked shadows
    if (windowStateMap.has(actor) || getRoundedCornersEffect(actor)) {
        logDebug('Skipping window: Effect already applied');
        logTimeEnd('onAddEffect');
        return;
    }

    _applyEffectInternal(
        actor,
        win,
        actorWidth,
        actorHeight,
        frameRect,
        win.get_buffer_rect(),
        windowState,
        win.appears_focused,
    );

    logTimeEnd('onAddEffect');
}

function _applyEffectInternal(
    actor: RoundedWindowActor,
    win: Meta.Window,
    actorWidth: number,
    actorHeight: number,
    frameRect: Mtk.Rectangle,
    bufferRect: Mtk.Rectangle,
    windowState: {maximized: boolean; fullscreen: boolean},
    appearsFocused: boolean,
): void {
    unwrapActor(actor)?.add_effect_with_name(
        ROUNDED_CORNERS_EFFECT,
        new RoundedCornersEffect(),
    );

    // Compute & cache Wayland shadow insets once per window instead of on every resize.
    const cachedShadowInsets = computeShadowInsets(win);
    const state = {
        unminimizedTimeoutId: 0,
        cachedShadowInsets,
    };

    windowStateMap.set(actor, state);

    const effect = getRoundedCornersEffect(actor);
    if (effect) {
        updateEffectUniforms(
            actorWidth,
            actorHeight,
            win,
            effect,
            state,
            frameRect,
            bufferRect,
            windowState,
            appearsFocused,
        );
    }
}

export function onRemoveEffect(actor: RoundedWindowActor): void {
    const state = windowStateMap.get(actor);

    try {
        unwrapActor(actor)?.remove_effect_by_name(ROUNDED_CORNERS_EFFECT);
    } catch (err) {
        logDebug(`Ignored error during effect removal: ${err}`);
    }

    if (!state) {
        return;
    }

    if (state.unminimizedTimeoutId) {
        GLib.source_remove(state.unminimizedTimeoutId);
    }

    windowStateMap.delete(actor);
}

export function onMinimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Disable the shader during the minimize animation so the lamp effect works.
    const magicLampEffect = actor.get_effect('minimize-magic-lamp-effect');
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && roundedCornersEffect) {
        roundedCornersEffect.enabled = false;
    }
}

export function onUnminimize(actor: RoundedWindowActor): void {
    // Compatibility with "Compiz alike magic lamp effect":
    // Wait until the unminimize animation is 98% done before re-showing the effect.
    const magicLampEffect = actor.get_effect('unminimize-magic-lamp-effect');
    const roundedCornersEffect = getRoundedCornersEffect(actor);

    if (magicLampEffect && roundedCornersEffect) {
        type Effect = Clutter.Effect & {timerId: Clutter.Timeline};
        const timer = (magicLampEffect as Effect).timerId;

        let disconnected = false;
        const id = timer.connect('new-frame', source => {
            if (source.get_progress() > 0.98 && !disconnected) {
                roundedCornersEffect.enabled = true;
                source.disconnect(id);
                disconnected = true;
            }
        });
    }
}

/** Alias so event_manager.ts can use a descriptive name. */
export const onSizeChanged = refreshRoundedCorners;

import {DEBUG_MODE, FOCUSED_SHADOW, UNFOCUSED_SHADOW} from '../utils/config.js';

export function onFocusChanged(actor: RoundedWindowActor): void {
    refreshRoundedCorners(actor);
}

/**
 * Re-evaluate whether the effect should be active for `actor` and update the
 * shader uniforms and shadow `BindConstraint` offsets to match the current
 * window geometry.
 */
function refreshRoundedCorners(
    actor: RoundedWindowActor,
    prefetchedFrameRect?: Mtk.Rectangle,
): void {
    const win = actor.metaWindow;
    if (!win) return;

    let tStart = 0,
        tAfterProps = 0,
        tAfterEligibility = 0;
    if (DEBUG_MODE) {
        tStart = GLib.get_monotonic_time();
    }

    // Read actor dimensions once — these cross the JS→C bridge, so avoid
    // re-reading them in computeBounds / updateUniforms.
    const actorWidth = actor.width;
    const actorHeight = actor.height;

    if (actorWidth <= 0 || actorHeight <= 0) {
        logDebug('Skipping window: Invalid geometry (0x0)');
        return;
    }

    const state = windowStateMap.get(actor);
    const effect = getRoundedCornersEffect(actor);
    const appearsFocused = win.appears_focused;

    // Fast-path: if dimensions and focus haven't changed since the last refresh,
    // we can check if geometry matches before querying bufferRect and full states.
    if (
        state?.lastRefreshArgs &&
        effect &&
        state.lastRefreshArgs.actorWidth === actorWidth &&
        state.lastRefreshArgs.actorHeight === actorHeight &&
        state.lastRefreshArgs.appearsFocused === appearsFocused &&
        !prefetchedFrameRect
    ) {
        const frameRect = win.get_frame_rect();
        if (
            state.lastRefreshArgs.frameRectX === frameRect.x &&
            state.lastRefreshArgs.frameRectY === frameRect.y &&
            state.lastRefreshArgs.frameRectWidth === frameRect.width &&
            state.lastRefreshArgs.frameRectHeight === frameRect.height
        ) {
            const bufferRect = win.get_buffer_rect();
            if (
                state.lastRefreshArgs.bufferRectX === bufferRect.x &&
                state.lastRefreshArgs.bufferRectY === bufferRect.y &&
                state.lastRefreshArgs.bufferRectWidth === bufferRect.width &&
                state.lastRefreshArgs.bufferRectHeight === bufferRect.height
            ) {
                logDebug(
                    'Skipping window: Redundant update (cached state matched)',
                );
                return;
            }
        }
    }

    const frameRect = prefetchedFrameRect ?? win.get_frame_rect();
    const bufferRect = win.get_buffer_rect();

    if (frameRect.width <= 0 || frameRect.height <= 0) {
        logDebug('Skipping window: Invalid frame geometry (0x0)');
        return;
    }

    // Read these once here to minimize bridge transitions
    const maximized = win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = win.fullscreen;

    if (DEBUG_MODE) {
        tAfterProps = GLib.get_monotonic_time();
    }

    const windowState = {maximized, fullscreen};

    const shouldHaveEffect = shouldEnableEffect(win, windowState);

    if (DEBUG_MODE) {
        tAfterEligibility = GLib.get_monotonic_time();
    }

    if (!shouldHaveEffect) {
        onRemoveEffect(actor);
        return;
    }

    const hasEffect = effect && state;

    if (!hasEffect) {
        // If the state is partially applied (e.g. effect stripped but state remains),
        // cleanly remove everything before reapplying to prevent leaks.
        if (state || effect) {
            onRemoveEffect(actor);
        }
        _applyEffectInternal(
            actor,
            win,
            actorWidth,
            actorHeight,
            frameRect,
            bufferRect,
            windowState,
            appearsFocused,
        );
        return;
    }

    updateEffectUniforms(
        actorWidth,
        actorHeight,
        win,
        effect,
        state,
        frameRect,
        bufferRect,
        windowState,
        appearsFocused,
    );

    if (DEBUG_MODE) {
        const tEnd = GLib.get_monotonic_time();
        const bridgeTime = (tAfterProps - tStart) / 1000;
        const eligTime = (tAfterEligibility - tAfterProps) / 1000;
        const uniformTime = (tEnd - tAfterEligibility) / 1000;
        const total = (tEnd - tStart) / 1000;

        console.log(
            `[Rounded Window Corners] [PERF] refreshRoundedCorners breakdown:\n  JS/C bridge reads: ${bridgeTime.toFixed(3)}ms\n  Eligibility check: ${eligTime.toFixed(3)}ms\n  Update uniforms:   ${uniformTime.toFixed(3)}ms\n  Total:             ${total.toFixed(3)}ms`,
        );
    }
}

function updateEffectUniforms(
    actorWidth: number,
    actorHeight: number,
    _win: Meta.Window,
    effect: InstanceType<typeof RoundedCornersEffect>,
    state: WindowEffectState,
    frameRect: Mtk.Rectangle,
    bufferRect: Mtk.Rectangle,
    windowState: {maximized: boolean; fullscreen: boolean},
    appearsFocused: boolean,
): void {
    if (!effect.enabled) {
        effect.enabled = true;
    }

    const windowContentOffset = computeWindowContentsOffset(
        frameRect,
        bufferRect,
    );
    const maximized = windowState.maximized;
    const fullscreen = windowState.fullscreen;
    const showBorder = !(maximized || fullscreen);

    let shadowSettings = appearsFocused ? FOCUSED_SHADOW : UNFOCUSED_SHADOW;

    // If a Wayland window has no native padding (buffer == frame) and no CSD insets,
    // we cannot draw shadows because the shader cannot draw outside the buffer.
    // Instead of complex vertex expansion, we just disable the shadow by zeroing opacity.
    if (
        showBorder &&
        !state.cachedShadowInsets &&
        bufferRect.width === frameRect.width
    ) {
        shadowSettings = shadowSettings.map(s => ({
            ...s,
            opacity: 0,
        })) as typeof shadowSettings;
    }

    effect.updateUniforms(
        computeBounds(
            actorWidth,
            actorHeight,
            windowContentOffset,
            state.cachedShadowInsets,
        ),
        actorWidth,
        actorHeight,
        showBorder,
        shadowSettings,
    );

    state.lastRefreshArgs = {
        actorWidth,
        actorHeight,
        frameRectX: frameRect.x,
        frameRectY: frameRect.y,
        frameRectWidth: frameRect.width,
        frameRectHeight: frameRect.height,
        bufferRectX: bufferRect.x,
        bufferRectY: bufferRect.y,
        bufferRectWidth: bufferRect.width,
        bufferRectHeight: bufferRect.height,
        maximized,
        fullscreen,
        appearsFocused,
    };
}

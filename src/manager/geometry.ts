/**
 * @file Pure geometry helpers for computing window and shadow bounds.
 *
 * All functions here are stateless mathematical transformations — they accept
 * window/actor data and return plain numeric values, with no side effects or
 * I/O.
 */

import type Mtk from '@girs/mtk-18';
import type {Bounds} from '../utils/types.js';

import Meta from 'gi://Meta';
import {getWindowId} from '../utils/window.js';

/**
 * Compute the shadow insets for a Wayland window that embeds its own
 * client-side shadows (e.g. Kitty, JetBrains IDEs).
 *
 * This is designed to be called **once** per window and cached in the
 * window state, so we avoid calling `getWindowId()` +
 * `toLowerCase()` on every resize event.
 *
 * @param win - The window to inspect.
 * @returns `[x1, y1, x2, y2]` insets, or `null` if no special insets apply.
 */
export function computeShadowInsets(
    win: Meta.Window,
): readonly number[] | null {
    if (win.get_client_type() !== Meta.WindowClientType.WAYLAND) {
        return null;
    }

    const wmClass = getWindowId(win)?.toLowerCase() ?? '';

    if (wmClass === 'kitty') {
        return [11, 35, 11, 11] as const;
    }
    if (wmClass.startsWith('jetbrains-')) {
        return [19, 18, 19, 18] as const;
    }

    return null;
}

/**
 * Compute the outer bounds that the rounded-corner shader should clip to.
 *
 * For Wayland windows that embed their own client-side shadows (e.g. Kitty,
 * JetBrains IDEs), additional insets are applied to exclude those shadows from
 * the clipping region.
 *
 * @param actor - The window actor.
 * @param [x, y, width, height] - Content offsets returned by
 *        {@link computeWindowContentsOffset}.
 * @param shadowInsets - Pre-computed insets from {@link computeShadowInsets},
 *        or `null`/`undefined` if none apply.
 */
export function computeBounds(
    actorWidth: number,
    actorHeight: number,
    [x, y, width, height]: [number, number, number, number],
    shadowInsets?: readonly number[] | null,
): Bounds {
    const bounds = {
        x1: x + 1,
        y1: y + 1,
        x2: x + actorWidth + width,
        y2: y + actorHeight + height,
    };

    if (shadowInsets) {
        bounds.x1 += shadowInsets[0];
        bounds.y1 += shadowInsets[1];
        bounds.x2 -= shadowInsets[2];
        bounds.y2 -= shadowInsets[3];
    }

    return bounds;
}

/**
 * Compute the offset of the actual window contents from the full window
 * buffer rectangle.
 *
 * GNOME windows have a buffer rect that may be larger than the visible frame
 * (e.g. due to server-side decorations or client-side shadows). This function
 * returns the delta so callers can work in frame coordinates.
 *
 * @param frameRect - The frame rectangle of the window.
 * @param bufferRect - The buffer rectangle of the window.
 * @returns `[x, y, width, height]` offsets from buffer to frame.
 */
export function computeWindowContentsOffset(
    frameRect: Mtk.Rectangle,
    bufferRect: Mtk.Rectangle,
): [number, number, number, number] {
    return [
        frameRect.x - bufferRect.x,
        frameRect.y - bufferRect.y,
        frameRect.width - bufferRect.width,
        frameRect.height - bufferRect.height,
    ];
}

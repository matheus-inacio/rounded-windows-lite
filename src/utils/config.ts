/**
 * @file Hardcoded extension configuration (former GSettings defaults).
 */

import type {BoxShadow, RoundedCornerSettings} from './types.js';

/** Former `global-rounded-corner-settings` default. */
export const GLOBAL_ROUNDED_CORNER_SETTINGS: RoundedCornerSettings = {
    keepRoundedCorners: {
        maximized: false,
        fullscreen: false,
    },
    borderRadius: 15,
    smoothing: 0.2,
    padding: {
        left: 1,
        right: 1,
        top: 1,
        bottom: 1,
    },
    enabled: true,
};

export const FOCUSED_SHADOW: [BoxShadow, BoxShadow, BoxShadow] = [
    {
        horizontalOffset: 0,
        verticalOffset: 2,
        blurOffset: 8,
        spreadRadius: 2,
        opacity: 18,
    },
    {
        horizontalOffset: 0,
        verticalOffset: 3,
        blurOffset: 10,
        spreadRadius: 1,
        opacity: 5,
    },
    {
        horizontalOffset: 0,
        verticalOffset: 0,
        blurOffset: 0,
        spreadRadius: 1,
        opacity: 10,
    },
];

export const UNFOCUSED_SHADOW: [BoxShadow, BoxShadow, BoxShadow] = [
    {
        horizontalOffset: 0,
        verticalOffset: 2,
        blurOffset: 8,
        spreadRadius: 2,
        opacity: 9,
    },
    {
        horizontalOffset: 0,
        verticalOffset: 3,
        blurOffset: 10,
        spreadRadius: 1,
        opacity: 0,
    },
    {
        horizontalOffset: 0,
        verticalOffset: 0,
        blurOffset: 0,
        spreadRadius: 1,
        opacity: 5,
    },
];

export const BLACKLIST: Set<string> = new Set();
/** When false, blacklist entries are excluded from rounding. */
export const WHITELIST_MODE = false;
export const BORDER_WIDTH = 0.6;
export const DEBUG_MODE = false;

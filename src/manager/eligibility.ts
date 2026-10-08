/**
 * @file Determines whether a window is eligible to receive rounded corners and
 * a custom shadow.
 *
 * This module owns the entire "should we apply the effect?" decision tree,
 * including synchronous detection of application toolkit type
 * (LibAdwaita / LibHandy / Other) via `/proc/<pid>/maps`.
 */

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {getWindowId} from '../utils/window.js';
import {
    BLACKLIST,
    GLOBAL_ROUNDED_CORNER_SETTINGS,
    WHITELIST_MODE,
} from '../utils/config.js';
import {logDebug, logTime, logTimeEnd} from '../utils/log.js';

/** The toolkit type of a running application. */
export type AppType = 'LibAdwaita' | 'LibHandy' | 'Other';

// ---------------------------------------------------------------------------
// App-type cache
// ---------------------------------------------------------------------------

/**
 * Caches previously resolved {@link AppType} values keyed by
 * `wm_class_instance` to avoid repeated `/proc` I/O for the same application.
 */
const appTypeCache = new Map<string, AppType>();

/**
 * Clear the app-type cache.  Should be called when the extension is disabled
 * so that stale entries do not carry over to the next enable cycle.
 */
export function clearAppTypeCache() {
    appTypeCache.clear();
}

// ---------------------------------------------------------------------------
// Public eligibility predicates
// ---------------------------------------------------------------------------

/**
 * Return `true` if the window can never receive rounded corners, regardless of
 * its current state or toolkit type.
 *
 * Checks performed (in order):
 * 1. DING (Desktop Icons NG) extension windows are always excluded.
 * 2. Windows whose `wm_class_instance` appears in the blacklist (or does *not*
 *    appear when whitelist mode is active) are excluded.
 * 3. Only `NORMAL`, `DIALOG`, and `MODAL_DIALOG` window types are eligible.
 * 4. If the app type is already known, LibAdwaita/LibHandy windows are
 *    excluded according to config.
 *
 * @param win - The window to evaluate.
 */
export function isPermanentlyIneligible(
    win: Meta.Window & {
        _appType?: AppType;
        _cachedWmClass?: string | null;
        _cachedWinType?: Meta.WindowType;
    },
): boolean {
    if (!win._cachedWmClass) {
        const wmClassInstance = getWindowId(win);
        if (wmClassInstance) {
            win._cachedWmClass = wmClassInstance;
        }
    }
    const wmClass = win._cachedWmClass;
    if (wmClass == null) {
        logDebug('Warning: wm_class_instance of window is null');
        return true;
    }

    // Handles blacklist / whitelist logic.
    const isException = BLACKLIST.has(wmClass);
    if (isException !== WHITELIST_MODE) {
        return true;
    }

    if (win._cachedWinType === undefined) {
        win._cachedWinType = win.windowType;
    }
    const winType = win._cachedWinType;
    // Only apply the effect to normal windows (skip menus, tooltips, etc.)
    if (
        winType !== Meta.WindowType.NORMAL &&
        winType !== Meta.WindowType.DIALOG &&
        winType !== Meta.WindowType.MODAL_DIALOG
    ) {
        return true;
    }

    if (win._appType === undefined) {
        win._appType = getAppType(win);
    }

    if (_skipForLibToolkit(win._appType, isException)) {
        logDebug(
            `[Performance] Instantly skipped ineligible ${win._appType} window during initialization (${wmClass})`,
        );
        return true;
    }

    return false;
}

/**
 * Return `true` if the rounded-corners effect should be active for `win` right
 * now (taking into account its maximised/fullscreen state and toolkit type).
 *
 * When the app type is not yet known, an async detection task is started and
 * `true` is returned optimistically — the effect will be re-evaluated once the
 * type resolves.
 *
 * @param win - The window to evaluate.
 */
export function shouldEnableEffect(
    win: Meta.Window & {
        _appType?: AppType;
        _cachedWmClass?: string | null;
        _cachedWinType?: Meta.WindowType;
    },
    windowState?: {maximized: boolean; fullscreen: boolean},
): boolean {
    logTime('shouldEnableEffect');

    if (isPermanentlyIneligible(win)) {
        logTimeEnd('shouldEnableEffect');
        return false;
    }

    logDebug(() => `Check Type of window => ${win._appType}`);

    const res = _roundedCornersAllowedForWindowState(win, windowState);
    logTimeEnd('shouldEnableEffect');
    return res;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _skipForLibToolkit(appType: AppType, isException: boolean): boolean {
    if (isException) {
        return false;
    }

    return appType === 'LibAdwaita' || appType === 'LibHandy';
}

function _roundedCornersAllowedForWindowState(
    win: Meta.Window,
    windowState?: {maximized: boolean; fullscreen: boolean},
): boolean {
    const maximized = windowState
        ? windowState.maximized
        : win.maximizedHorizontally || win.maximizedVertically;
    const fullscreen = windowState ? windowState.fullscreen : win.fullscreen;
    const cfg = GLOBAL_ROUNDED_CORNER_SETTINGS;
    return (
        !(maximized || fullscreen) ||
        (maximized && !fullscreen && cfg.keepRoundedCorners.maximized) ||
        (fullscreen && cfg.keepRoundedCorners.fullscreen)
    );
}

// ---------------------------------------------------------------------------
// App-type detection (synchronous)
// ---------------------------------------------------------------------------

const KNOWN_LIBADWAITA_APPS = new Set([
    'org.gnome.Settings',
    'org.gnome.Nautilus',
    'org.gnome.Software',
    'org.gnome.Calculator',
    'org.gnome.Calendar',
    'org.gnome.Characters',
    'org.gnome.Contacts',
    'org.gnome.Weather',
    'org.gnome.clocks',
    'org.gnome.Extensions',
    'org.gnome.TextEditor',
    'org.gnome.Console',
    'com.mitchellh.ghostty',
]);

/**
 * Synchronously resolve the toolkit type for the application that owns `win`.
 *
 * Reads `/proc/<pid>/maps` in a single synchronous call. This is safe because
 * procfs is a virtual filesystem backed entirely by kernel memory — there is no
 * disk I/O involved, and the read typically completes in <1ms.
 *
 * The previous async approach (enumerating `/proc/<pid>/map_files` with GLib
 * callbacks) introduced ~65ms of latency per window due to main-loop
 * round-trips between batches, which is far worse than a sub-millisecond
 * synchronous read.
 */
function getAppType(
    win: Meta.Window & {_cachedWmClass?: string | null},
): AppType {
    if (!win._cachedWmClass) {
        const wmClassInstance = getWindowId(win);
        if (wmClassInstance) { win._cachedWmClass = wmClassInstance; }
    }
    const wmClass = win._cachedWmClass;
    logTime(`getAppType [${wmClass || 'unknown'}]`);

    if (wmClass && appTypeCache.has(wmClass)) {
        logDebug(
            `AppType cache hit for "${wmClass}": ${appTypeCache.get(wmClass)}`,
        );
        logTimeEnd(`getAppType [${wmClass || 'unknown'}]`);
        return appTypeCache.get(wmClass)!;
    }

    if (wmClass && KNOWN_LIBADWAITA_APPS.has(wmClass)) {
        logDebug(`AppType fast-path for "${wmClass}": LibAdwaita`);
        appTypeCache.set(wmClass, 'LibAdwaita');
        logTimeEnd(`getAppType [${wmClass || 'unknown'}]`);
        return 'LibAdwaita';
    }

    if (wmClass?.toLowerCase().endsWith('.exe')) {
        logDebug(`AppType fast-path for "${wmClass}": .exe → Other`);
        appTypeCache.set(wmClass, 'Other');
        logTimeEnd(`getAppType [${wmClass || 'unknown'}]`);
        return 'Other';
    }

    const pid = win.get_pid();
    const appType = _detectFromMapsSync(pid);

    logDebug(`AppType resolved for "${wmClass}" (pid ${pid}): ${appType}`);
    if (wmClass) {
        appTypeCache.set(wmClass, appType);
    }

    logTimeEnd(`getAppType [${wmClass || 'unknown'}]`);
    return appType;
}

/**
 * Read `/proc/<pid>/maps` synchronously and search for toolkit library names.
 *
 * procfs files are virtual — backed by kernel memory with no disk I/O — so a
 * synchronous read completes in well under 1ms even for large maps files.
 */
function _detectFromMapsSync(pid: number): AppType {
    try {
        // procfs is a RAM-backed virtual filesystem. Sync I/O here is <1ms.
        // Async GLib main-loop overhead takes ~38ms and delays window rendering.
        const [ok, contents] = GLib.file_get_contents(`/proc/${pid}/maps`);
        if (!(ok && contents)) return 'Other';

        const text = new TextDecoder().decode(
            contents as unknown as Uint8Array,
        );
        if (text.includes('libadwaita-1.so')) return 'LibAdwaita';
        if (text.includes('libhandy-1.so')) return 'LibHandy';
        return 'Other';
    } catch (e) {
        logDebug(`Failed to read /proc/${pid}/maps: ${e}`);
        return 'Other';
    }
}

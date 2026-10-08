import type Meta from 'gi://Meta';

/**
 * Gets a stable window identifier by attempting to use the window class instance,
 * window class, or sandboxed app ID.
 */
export function getWindowId(win: Meta.Window): string | null {
    return win.get_wm_class_instance() ?? win.get_wm_class?.() ?? win.get_sandboxed_app_id?.();
}

/**
 * @file Type augmentations for GNOME 51 APIs that are not yet in the
 * `@girs` typings (which still target GNOME 50).
 *
 * GNOME 51 removed `Shell.GLSLEffect`; `Clutter.ShaderEffect` was ported to
 * `CoglSnippet` and replaces it.
 */

import type Cogl from '@girs/cogl-18';

declare module '@girs/clutter-18/clutter-18' {
    namespace Clutter {
        interface ShaderEffect {
            /**
             * Returns the snippet used by every instance of the subclass.
             * Called only once per subclass.
             */
            vfunc_get_static_snippet(): Cogl.Snippet;

            /**
             * Sets a float (or vecN) uniform by name. Uniform arrays are not
             * supported: the whole `value` is uploaded as a single vecN.
             */
            set_uniform_float(
                name: string,
                n_components: number,
                value: number[],
            ): void;
        }
    }
}

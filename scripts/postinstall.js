#!/usr/bin/env node
/**
 * Postinstall intentionally does not modify user-home agent configuration.
 * Users can install or update integrations explicitly with:
 *
 *   gmax plugin add
 *   gmax plugin update
 */

if (process.env.GMAX_POSTINSTALL_QUIET !== "1") {
  console.log(
    "gmax installed. To install or update editor plugins, run: gmax plugin update",
  );
}

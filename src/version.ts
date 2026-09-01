/**
 * Build identity, stamped in by the Dockerfile from CI.
 *
 * Without this, telling a running container apart from a newer image meant
 * comparing image digests by hand — which is exactly what an out-of-date
 * container looks like from the outside: everything works, one fix is missing.
 */
export const BUILD = {
  version: process.env.APP_VERSION || "dev",
  /** Short git SHA of the commit the image was built from. */
  commit: process.env.GIT_SHA || "",
  /** ISO timestamp of the build. */
  builtAt: process.env.BUILD_TIME || "",
};

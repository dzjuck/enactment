/**
 * The fixed contract a runtime-verified step executes under.
 *
 * DESIGN.md §6 and the M6 plan: none of this is task input. The plan owns *what* starts and
 * what is checked; the harness owns where it listens, how readiness is decided, how long it
 * may take and what the containers can reach. These constants are hashed into `policy_hash`,
 * so changing one invalidates an existing approval.
 *
 * The probe's own source text is not hashed separately — it is harness code, covered by
 * `harness_version`.
 */

/** The application must listen on every interface: the checker reaches it over Docker DNS. */
export const RUNTIME_HOST = '0.0.0.0';

/**
 * How long readiness may take, in total, across the whole poll loop.
 *
 * An application that exits immediately fails on this deadline rather than on process exit;
 * V1 accepts the wait, and `application.log` carries the reason.
 */
export const RUNTIME_READINESS_TIMEOUT_SECONDS = 60;

/** Budget for one behavioral command. */
export const RUNTIME_COMMAND_TIMEOUT_SECONDS = 600;

/** Readiness is an HTTP GET requiring status 200. Nothing else is configurable in V1. */
export const RUNTIME_PROBE = 'http-get-200';

/** The only environment the harness sets for the application and the behavioral checkers. */
export const RUNTIME_ENVIRONMENT: readonly string[] = ['HOST', 'PORT', 'HARNESS_APP_URL'];

/** The runtime network is internal: neither container reaches the proxy or the internet. */
export const RUNTIME_NETWORK = 'internal';

/** Name of the variable carrying the application's URL into every behavioral checker. */
export const RUNTIME_URL_VARIABLE = 'HARNESS_APP_URL';

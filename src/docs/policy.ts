/**
 * DESIGN.md §18: fixed documentation policy. These constants are part of the policy hash, so
 * changing any of them invalidates existing approvals — which is the point.
 */
export const DOCUMENTATION_TIMEOUT_SECONDS = 600;

/** The cap is on the complete bundle, not per source. */
export const DOCUMENTATION_MAX_MB = 50;
export const DOCUMENTATION_MAX_BYTES = DOCUMENTATION_MAX_MB * 1024 * 1024;

/** Where agent containers — and only agent containers — read the approved bundle. */
export const DOCUMENTATION_MOUNT = '/context';

export const DOCUMENTATION_CONTRACT = {
  transport: 'connect-proxy',
  timeout_seconds: DOCUMENTATION_TIMEOUT_SECONDS,
  maximum_download_mb: DOCUMENTATION_MAX_MB,
  redirects: 'rejected',
  content: 'utf8-text-no-html',
  mount: DOCUMENTATION_MOUNT,
  mount_mode: 'read-only',
  consumers: ['agent'],
} as const;

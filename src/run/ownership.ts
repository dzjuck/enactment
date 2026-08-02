/**
 * Raised when a scope failed *and* releasing its resource failed too.
 *
 * Both causes are kept: the primary failure is what the run is about, but a resource that
 * could not be released is a leak, and reporting only one of the two guarantees the other is
 * discovered later by whoever runs `docker ps -a`.
 */
export class OwnershipError extends Error {
  override readonly cause: unknown;
  readonly cleanupCause: unknown;

  constructor(resource: string, cause: unknown, cleanupCause: unknown) {
    super(
      `${describe(cause)} (while owning ${resource}); ` +
        `releasing it also failed: ${describe(cleanupCause)}`,
    );
    this.name = 'OwnershipError';
    this.cause = cause;
    this.cleanupCause = cleanupCause;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Own a resource from the moment it exists until ownership is handed to the caller.
 *
 * The function that creates a resource owns it: every step between creation and the point
 * where the caller can take over is inside this scope, so a failure in any of them releases
 * the resource before the error escapes. On success the resource is deliberately *not*
 * released — the caller now owns it, and releasing it here would destroy what was just built.
 *
 * A cleanup failure is never converted into success: if the scope failed and the release
 * failed too, both causes are reported together.
 */
export async function withOwnedResource<T>(
  resource: string,
  release: (resource: string) => Promise<void>,
  use: () => Promise<T>,
): Promise<T> {
  try {
    return await use();
  } catch (failure) {
    try {
      await release(resource);
    } catch (cleanupFailure) {
      throw new OwnershipError(resource, failure, cleanupFailure);
    }

    throw failure;
  }
}

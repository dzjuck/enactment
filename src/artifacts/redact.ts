export const REDACTED = '[redacted]';

/** Short values are not secrets worth masking, and masking them would corrupt output. */
const MIN_SECRET_LENGTH = 8;

const SECRET_KEYS = /token|secret|key|password|authorization/i;

function walk(value: unknown, found: Set<string>, keyed: boolean): void {
  if (typeof value === 'string') {
    if (keyed && value.length >= MIN_SECRET_LENGTH) found.add(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, found, keyed);
    return;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      walk(entry, found, keyed || SECRET_KEYS.test(key));
    }
  }
}

/** Pull the values worth masking out of an `auth.json`, without knowing its exact shape. */
export function collectSecrets(authJson: string): string[] {
  const found = new Set<string>();

  try {
    walk(JSON.parse(authJson), found, false);
  } catch {
    return [];
  }

  return [...found];
}

/**
 * Redaction happens at the artifact boundary: anything the harness writes out passes through
 * here, so a credential cannot reach a log, an event stream, an error message or the manifest.
 */
export function createRedactor(secrets: readonly string[]): (text: string) => string {
  // Longest first, so a token that contains another is not partially replaced.
  const ordered = [...secrets].filter((secret) => secret.length >= MIN_SECRET_LENGTH).sort(
    (left, right) => right.length - left.length,
  );

  return (text) => ordered.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
}

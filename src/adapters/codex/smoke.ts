import { IMAGE_PINS } from '../../config/pins.js';
import { runContainer } from '../../docker/run.js';
import { PhaseFailure } from '../../run/failure.js';

export interface SmokeOptions {
  /** Reached through the proxy: the smoke test never bypasses the allowlist. */
  url: string;
  network: string;
  env: Record<string, string>;
  timeoutSeconds: number;
  image?: string;
}

export interface SmokeResult {
  ok: true;
  durationMs: number;
  output: string;
}

/**
 * Confirm the provider is reachable before the agent budget is spent.
 *
 * Codex retries and reconnects rather than failing when it cannot reach the provider, so a
 * misconfigured network produces a 20-minute hang instead of an error. This check bounds that
 * to `connectivity_smoke_seconds`.
 */
export async function providerSmokeTest(options: SmokeOptions): Promise<SmokeResult> {
  const started = Date.now();

  const result = await runContainer(
    {
      image: options.image ?? IMAGE_PINS.agent.tag,
      argv: [
        'curl',
        '-sS',
        '--proxytunnel',
        '--max-time',
        String(options.timeoutSeconds),
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        options.url,
      ],
      network: options.network,
      env: options.env,
    },
    { timeoutSeconds: options.timeoutSeconds + 5, graceSeconds: 2 },
  );

  if (result.exitCode !== 0) {
    throw new PhaseFailure(
      'connectivity',
      'provider_connectivity_timeout',
      `provider unreachable at ${options.url} within ${String(options.timeoutSeconds)}s: ` +
        `${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
    );
  }

  return { ok: true, durationMs: Date.now() - started, output: result.stdout };
}

/** Gate the agent phase on connectivity: a network fault must not cost the agent budget. */
export async function withProviderSmokeTest<T>(
  options: SmokeOptions,
  agentPhase: () => Promise<T>,
): Promise<T> {
  await providerSmokeTest(options);
  return agentPhase();
}

import { execa } from 'execa';

export interface DetachedContainer {
  name: string;
  ip: string;
  stop: () => Promise<void>;
}

/**
 * Start a long-lived container so a test can probe reachability against something that is
 * genuinely listening. Test-only: it makes no hardening claims.
 */
export async function startDetached(options: {
  image: string;
  argv: string[];
  network: string;
  name: string;
}): Promise<DetachedContainer> {
  await execa('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    options.name,
    '--user',
    '1001:1001',
    '--read-only',
    '--network',
    options.network,
    options.image,
    ...options.argv,
  ]);

  const { stdout } = await execa('docker', [
    'inspect',
    '--format',
    '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
    options.name,
  ]);

  return {
    name: options.name,
    ip: stdout.trim(),
    stop: async () => {
      await execa('docker', ['rm', '--force', options.name], { reject: false });
    },
  };
}

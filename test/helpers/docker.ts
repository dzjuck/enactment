import { execa } from 'execa';

export interface ContainerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Plain `docker run` for image-level assertions. The hardened runner is Step 4's
 * responsibility; this helper deliberately applies no policy of its own.
 */
export async function listContainers(labelFilter: string): Promise<string[]> {
  const { stdout } = await execa('docker', ['ps', '-a', '--filter', `label=${labelFilter}`, '-q']);
  return stdout.split('\n').filter((line) => line !== '');
}

export async function imageEnvNames(image: string): Promise<string[]> {
  const { stdout } = await execa('docker', [
    'image',
    'inspect',
    '--format',
    '{{json .Config.Env}}',
    image,
  ]);
  return (JSON.parse(stdout) as string[]).map((entry) => entry.split('=')[0] ?? '');
}

export async function runInImage(image: string, argv: string[]): Promise<ContainerResult> {
  const result = await execa('docker', ['run', '--rm', '--network', 'none', image, ...argv], {
    reject: false,
  });

  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

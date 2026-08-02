import { createHash } from 'node:crypto';

import { execa, ExecaError } from 'execa';

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

export type LifecycleScriptPolicy = 'denied' | 'allowed';

/** DESIGN.md §12: the four inputs, and nothing else. */
export interface DependencyCacheInputs {
  setupImageId: string;
  lockfileHash: string;
  installCommand: readonly string[];
  lifecycleScripts: LifecycleScriptPolicy;
}

export const LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
];

export function dependencyCacheKey(inputs: DependencyCacheInputs): string {
  const canonical = JSON.stringify({
    setupImageId: inputs.setupImageId,
    lockfileHash: inputs.lockfileHash,
    installCommand: inputs.installCommand,
    lifecycleScripts: inputs.lifecycleScripts,
  });

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export function installCommand(policy: LifecycleScriptPolicy): string[] {
  return policy === 'denied'
    ? ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['npm', 'ci', '--no-audit', '--no-fund'];
}

/**
 * Hash the committed lockfile. Read from the commit rather than the working tree, so the key
 * describes what will actually be installed, and so unrelated source edits cannot move it.
 */
export async function lockfileHash(repoPath: string, commit: string): Promise<string> {
  for (const name of LOCKFILES) {
    try {
      const { stdout } = await execa('git', ['-C', repoPath, 'show', `${commit}:${name}`], {
        encoding: 'buffer',
      });
      return `sha256:${createHash('sha256').update(Buffer.from(stdout)).digest('hex')}`;
    } catch (error) {
      if (!(error instanceof ExecaError)) throw error;
    }
  }

  throw new DependencyError(
    `no lockfile at ${commit} in ${repoPath} (looked for ${LOCKFILES.join(', ')})`,
  );
}

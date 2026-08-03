import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { execa } from 'execa';
import { stringify, parse } from 'yaml';
import { z } from 'zod';

import {
  CODEX_VERSION,
  HARNESS_VERSION,
  IMAGE_ROLES,
  PROVIDER_ALLOWLIST,
} from '../config/pins.js';
import { installCommand, type LifecycleScriptPolicy } from '../deps/cache-key.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import { loadPlan } from './load.js';
import type { Plan } from './schema.js';

/** The manifest file itself is malformed: bad YAML, unknown field, unknown version. */
export class ManifestConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestConfigError';
  }
}

export type ApprovalReason =
  | 'plan_changed'
  | 'policy_changed'
  | 'runtime_changed'
  | 'base_unresolvable';

/**
 * Something the user approved no longer describes what would run.
 *
 * Raised before any container starts: an approval that has drifted is not a thing to repair
 * automatically, because the point of the manifest is that a human agreed to these exact
 * inputs.
 */
export class ApprovalError extends Error {
  readonly reason: ApprovalReason;

  constructor(reason: ApprovalReason, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.reason = reason;
  }
}

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256:<hex> digest');

const manifestSchema = z.strictObject({
  execution_manifest: z.strictObject({
    version: z.literal(1, 'unsupported execution manifest version'),
    /** Relative to the manifest, so a prepared directory can be moved as a unit. */
    plan_file: z.string().min(1),
    repository: z.strictObject({
      base_branch: z.string().min(1),
      base_commit: z.string().regex(/^[0-9a-f]{40}$/, 'must be a full commit SHA'),
    }),
    inputs: z.strictObject({
      plan_hash: sha256,
      policy_hash: sha256,
    }),
    runtime: z.strictObject({
      harness_version: z.string().min(1),
      agent_image_id: sha256,
      verifier_image_id: sha256,
      setup_image_id: sha256,
      proxy_image_id: sha256,
    }),
  }),
});

export type ExecutionManifest = z.infer<typeof manifestSchema>['execution_manifest'];

/**
 * The fixed policies M3 executes under, hashed as one value.
 *
 * They are constants in source rather than task input, so the hash exists to detect that the
 * harness changed under an approval, not to carry a user choice.
 */
export interface Policy {
  network: { allowed_hosts: string[]; codex_version: string };
  dependencies: { lifecycle_scripts: LifecycleScriptPolicy; install_command: string[] };
}

export function activePolicy(): Policy {
  const lifecycle: LifecycleScriptPolicy = 'denied';

  return {
    network: { allowed_hosts: [...PROVIDER_ALLOWLIST], codex_version: CODEX_VERSION },
    dependencies: { lifecycle_scripts: lifecycle, install_command: installCommand(lifecycle) },
  };
}

export function policyHash(policy: Policy): string {
  const canonical = JSON.stringify({
    network: {
      allowed_hosts: policy.network.allowed_hosts,
      codex_version: policy.network.codex_version,
    },
    dependencies: {
      lifecycle_scripts: policy.dependencies.lifecycle_scripts,
      install_command: policy.dependencies.install_command,
    },
  });

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', ['-C', repoPath, ...args]);
  return stdout;
}

export interface ResolvedBase {
  branch: string;
  commit: string;
}

export interface BuildManifestOptions {
  planFile: string;
  /** Where the manifest will be written; `plan_file` is recorded relative to it. */
  manifestPath: string;
  repoPath: string;
  /** Injectable so hash behavior is testable without a Docker daemon. */
  resolveImages?: () => Promise<RuntimeImages>;
  /** Injectable so hash behavior is testable without a repository. */
  resolveBase?: (repoPath: string) => Promise<ResolvedBase>;
}

async function headOf(repoPath: string): Promise<ResolvedBase> {
  return {
    commit: await git(repoPath, ['rev-parse', 'HEAD']),
    branch: await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
  };
}

/**
 * Resolve everything an approval covers into one candidate manifest.
 *
 * Read-only: it resolves the repository's current head and the local image IDs, and writes
 * nothing but the manifest the caller then saves.
 */
export async function buildManifest(options: BuildManifestOptions): Promise<ExecutionManifest> {
  const { hash: planHash } = await loadPlan(options.planFile);
  const base = await (options.resolveBase ?? headOf)(options.repoPath);
  const images = await (options.resolveImages ?? (() => resolveRuntimeImages()))();

  return {
    version: 1,
    plan_file: relative(dirname(resolve(options.manifestPath)), resolve(options.planFile)),
    repository: { base_branch: base.branch, base_commit: base.commit },
    inputs: { plan_hash: planHash, policy_hash: policyHash(activePolicy()) },
    runtime: {
      harness_version: HARNESS_VERSION,
      agent_image_id: images.agent.id,
      verifier_image_id: images.verifier.id,
      setup_image_id: images.setup.id,
      proxy_image_id: images.proxy.id,
    },
  };
}

export async function writeManifest(path: string, manifest: ExecutionManifest): Promise<void> {
  await writeFile(path, stringify({ execution_manifest: manifest }));
}

export interface LoadedManifest {
  manifest: ExecutionManifest;
  /** Absolute, resolved against the manifest's own directory. */
  planFile: string;
  plan: Plan;
  /** The plan's byte hash, already checked against the approved one. */
  hash: string;
}

export async function loadManifest(path: string): Promise<LoadedManifest> {
  let document: unknown;
  try {
    document = parse(await readFile(path, 'utf8'), { uniqueKeys: true });
  } catch (error) {
    throw new ManifestConfigError(
      `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = manifestSchema.safeParse(document);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new ManifestConfigError(`Invalid execution manifest ${path}:\n${details}`);
  }

  const manifest = result.data.execution_manifest;
  const planFile = resolve(dirname(resolve(path)), manifest.plan_file);
  const { plan, hash } = await loadPlan(planFile);

  if (hash !== manifest.inputs.plan_hash) {
    throw new ApprovalError(
      'plan_changed',
      `${planFile} is ${hash}, but ${path} approved ${manifest.inputs.plan_hash}; re-run prepare and approve the new plan`,
    );
  }

  return { manifest, planFile, plan, hash };
}

export interface ApprovedInputs {
  plan: Plan;
  planHash: string;
  planFile: string;
  repoPath: string;
  baseBranch: string;
  baseCommit: string;
  images: RuntimeImages;
}

export interface ValidateManifestOptions {
  repoPath: string;
  resolveImages?: () => Promise<RuntimeImages>;
}

/**
 * Prove the approval still describes what would run, then hand back exactly those inputs.
 *
 * The plan is already checked by `loadManifest`; what is left is the repository base, the
 * fixed policies, and the runtime identity. Everything downstream takes its inputs from the
 * returned value rather than resolving them again, so nothing can execute against something
 * other than what was approved.
 */
export async function validateManifest(
  loaded: LoadedManifest,
  options: ValidateManifestOptions,
): Promise<ApprovedInputs> {
  const { manifest } = loaded;

  const activeHash = policyHash(activePolicy());
  if (activeHash !== manifest.inputs.policy_hash) {
    throw new ApprovalError(
      'policy_changed',
      `the active network/dependency policy is ${activeHash}, but ${manifest.inputs.policy_hash} was approved`,
    );
  }

  if (manifest.runtime.harness_version !== HARNESS_VERSION) {
    throw new ApprovalError(
      'runtime_changed',
      `runtime.harness_version is ${HARNESS_VERSION}, but ${manifest.runtime.harness_version} was approved`,
    );
  }

  const images = await (options.resolveImages ?? (() => resolveRuntimeImages()))();
  for (const role of IMAGE_ROLES) {
    const field = `${role}_image_id` as const;
    const approvedId = manifest.runtime[field];
    if (images[role].id !== approvedId) {
      throw new ApprovalError(
        'runtime_changed',
        `runtime.${field} is ${images[role].id}, but ${approvedId} was approved`,
      );
    }
  }

  try {
    await git(options.repoPath, ['cat-file', '-e', `${manifest.repository.base_commit}^{commit}`]);
  } catch {
    throw new ApprovalError(
      'base_unresolvable',
      `approved base commit ${manifest.repository.base_commit} does not exist in ${options.repoPath}`,
    );
  }

  return {
    plan: loaded.plan,
    planHash: loaded.hash,
    planFile: loaded.planFile,
    repoPath: options.repoPath,
    baseBranch: manifest.repository.base_branch,
    baseCommit: manifest.repository.base_commit,
    images,
  };
}

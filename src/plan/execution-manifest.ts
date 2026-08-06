import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';

import { execa } from 'execa';
import { stringify, parse } from 'yaml';
import { z } from 'zod';

import {
  CLAUDE_BASE_ARGS,
  CLAUDE_CODING_PERMISSION_ARGS,
  CLAUDE_CODING_TOOLS,
  CLAUDE_DIAGNOSIS_TOOLS,
  CLAUDE_LAUNCHER,
  CLAUDE_PRINT_FLAG,
} from '../adapters/claude/policy.js';
import { compileCodexPolicy } from '../adapters/codex/policy.js';
import {
  CLAUDE_PROVIDER_ALLOWLIST,
  CLAUDE_VERSION,
  CODEX_PROVIDER_ALLOWLIST,
  CODEX_VERSION,
  HARNESS_VERSION,
  IMAGE_ROLES,
  SEMGREP_IMAGE,
  SEMGREP_VERSION,
} from '../config/pins.js';
import { installCommand, type LifecycleScriptPolicy } from '../deps/cache-key.js';
import {
  DocumentationError,
  bundleRootFor,
  contextDirFor,
  verifyBundle,
  type ApprovedDocumentation,
} from '../docs/bundle.js';
import { DOCUMENTATION_CONTRACT } from '../docs/policy.js';
import { resolveRuntimeImages, type RuntimeImages } from '../docker/images.js';
import { acceptedStepIds, type AcceptedStep } from '../git/idempotency.js';
import {
  REVIEW_AFTER_ROOT,
  REVIEW_ARGS,
  REVIEW_BEFORE_ROOT,
  REVIEW_SEVERITY_MAP,
  REVIEW_TIMEOUT_SECONDS,
  type ReviewSeverity,
} from '../review/policy.js';
import {
  RUNTIME_COMMAND_TIMEOUT_SECONDS,
  RUNTIME_ENVIRONMENT,
  RUNTIME_HOST,
  RUNTIME_NETWORK,
  RUNTIME_PROBE,
  RUNTIME_READINESS_TIMEOUT_SECONDS,
} from '../verify/runtime-policy.js';
import {
  NORMAL_ROUTES,
  PROFILE_IDS,
  PROFILES,
  STRONGER_PROFILE_ID,
  type AgentProfile,
  type ProfileId,
} from '../routing/profiles.js';
import { loadPlan } from './load.js';
import type { Plan, StepComplexity } from './schema.js';

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
  | 'documentation_changed'
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
      /** Present exactly when the plan declares documentation (DESIGN.md §18). */
      documentation_hash: sha256.optional(),
    }),
    runtime: z.strictObject({
      harness_version: z.string().min(1),
      codex_image_id: sha256,
      claude_image_id: sha256,
      verifier_image_id: sha256,
      reviewer_image_id: sha256,
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
interface ProviderContract {
  version: string;
  allowed_hosts: string[];
  authentication_mode: string;
  policy: unknown;
}

/** DESIGN.md §29: what the offline reviewer runs, approved as policy rather than task input. */
export interface ReviewContract {
  scanner: 'semgrep';
  version: string;
  image: string;
  args: string[];
  roots: { before: string; after: string };
  severity_map: Record<string, ReviewSeverity>;
  timeout_seconds: number;
  network: 'none';
}

/** DESIGN.md §6 / §21: what the harness owns about a runtime-verified step, not the plan. */
export interface RuntimeContract {
  host: string;
  readiness_timeout_seconds: number;
  command_timeout_seconds: number;
  probe: string;
  environment: string[];
  network: string;
}

/** DESIGN.md §18: how documentation is fetched, what it may contain, and who may read it. */
export interface DocumentationContract {
  transport: string;
  timeout_seconds: number;
  maximum_download_mb: number;
  redirects: string;
  content: string;
  mount: string;
  mount_mode: string;
  consumers: string[];
}

export interface Policy {
  providers: { codex: ProviderContract; claude: ProviderContract };
  review: ReviewContract;
  runtime: RuntimeContract;
  documentation: DocumentationContract;
  routing: {
    profiles: AgentProfile[];
    normal_routes: Record<StepComplexity, ProfileId>;
    stronger_profile: ProfileId;
  };
  dependencies: { lifecycle_scripts: LifecycleScriptPolicy; install_command: string[] };
}

export function activePolicy(): Policy {
  const lifecycle: LifecycleScriptPolicy = 'denied';
  const codex = compileCodexPolicy({
    prompt: '<prompt>',
    workdir: '/workspace',
    model: '<profile-model>',
    reasoningEffort: '<profile-effort>',
  });

  return {
    providers: {
      codex: {
        version: CODEX_VERSION,
        allowed_hosts: [...CODEX_PROVIDER_ALLOWLIST],
        authentication_mode: 'rotating_subscription_json',
        policy: { files: codex.files, args: codex.args, env: codex.env, stdin: codex.stdin },
      },
      claude: {
        version: CLAUDE_VERSION,
        allowed_hosts: [...CLAUDE_PROVIDER_ALLOWLIST],
        authentication_mode: 'static_subscription_token',
        policy: {
          launcher: CLAUDE_LAUNCHER,
          print_flag: CLAUDE_PRINT_FLAG,
          base_args: [...CLAUDE_BASE_ARGS],
          coding_tools: [...CLAUDE_CODING_TOOLS],
          coding_permission_args: [...CLAUDE_CODING_PERMISSION_ARGS],
          diagnosis_tools: CLAUDE_DIAGNOSIS_TOOLS,
        },
      },
    },
    review: {
      scanner: 'semgrep',
      version: SEMGREP_VERSION,
      image: SEMGREP_IMAGE,
      args: [...REVIEW_ARGS],
      roots: { before: REVIEW_BEFORE_ROOT, after: REVIEW_AFTER_ROOT },
      severity_map: { ...REVIEW_SEVERITY_MAP },
      timeout_seconds: REVIEW_TIMEOUT_SECONDS,
      network: 'none',
    },
    runtime: {
      host: RUNTIME_HOST,
      readiness_timeout_seconds: RUNTIME_READINESS_TIMEOUT_SECONDS,
      command_timeout_seconds: RUNTIME_COMMAND_TIMEOUT_SECONDS,
      probe: RUNTIME_PROBE,
      environment: [...RUNTIME_ENVIRONMENT],
      network: RUNTIME_NETWORK,
    },
    documentation: {
      ...DOCUMENTATION_CONTRACT,
      consumers: [...DOCUMENTATION_CONTRACT.consumers],
    },
    routing: {
      profiles: PROFILE_IDS.map((id) => ({ ...PROFILES[id] })),
      normal_routes: { ...NORMAL_ROUTES },
      stronger_profile: STRONGER_PROFILE_ID,
    },
    dependencies: { lifecycle_scripts: lifecycle, install_command: installCommand(lifecycle) },
  };
}

export function policyHash(policy: Policy): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(policy)).digest('hex')}`;
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
  /**
   * DESIGN.md §30: the commit-ish an amended plan builds on, or the repository head.
   *
   * Resolved here rather than carried as a ref, so the approval names one exact commit.
   */
  base?: string;
  /** Injectable so hash behavior is testable without a Docker daemon. */
  resolveImages?: () => Promise<RuntimeImages>;
  /** Injectable so hash behavior is testable without a repository. */
  resolveBase?: (repoPath: string, base?: string) => Promise<ResolvedBase>;
}

/**
 * Resolve the base an approval covers: a named commit-ish, or the repository head.
 *
 * The named case is dereferenced through `^{commit}` to a full SHA at prepare time, which is
 * what lets an amendment name the previous revision's plan branch: the branch itself is read,
 * not `plans.head_commit`, which lags it when a process died between a commit and its database
 * write. The given string is recorded as the base ref — evidence of what was asked for, since
 * `base_branch` was never strictly a branch name.
 */
async function resolveBaseCommit(repoPath: string, base?: string): Promise<ResolvedBase> {
  if (base === undefined) {
    return {
      commit: await git(repoPath, ['rev-parse', 'HEAD']),
      branch: await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    };
  }

  let commit: string;
  try {
    commit = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    throw new ApprovalError(
      'base_unresolvable',
      `--base ${base} does not resolve to a commit in ${repoPath}`,
    );
  }

  return { commit, branch: base };
}

export interface PreparedManifest {
  manifest: ExecutionManifest;
  /**
   * Declared steps the approved base already carries (DESIGN.md §30).
   *
   * Reported rather than refused: a missed warning costs one agent run that then fails loudly,
   * while a false refusal — step IDs stay reachable forever once a revision branch is merged —
   * would stop legitimate work and demand a meaningless rename.
   */
  alreadyAccepted: AcceptedStep[];
}

/**
 * Resolve everything an approval covers into one candidate manifest.
 *
 * Read-only: it resolves the approved base — a named commit-ish or the repository head — and
 * the local image IDs, and writes nothing but the manifest the caller then saves.
 */
export async function buildManifest(options: BuildManifestOptions): Promise<PreparedManifest> {
  const { plan, hash: planHash } = await loadPlan(options.planFile);
  const base = await (options.resolveBase ?? resolveBaseCommit)(options.repoPath, options.base);
  const images = await (options.resolveImages ?? (() => resolveRuntimeImages()))();

  // The bundle is a separate approval input, so there is nothing to approve until it exists.
  let documentationHash: string | undefined;
  if (plan.documentation !== undefined) {
    const bundle = await verifyBundle(bundleRootFor(options.planFile), plan.documentation);
    if (!bundle.present) {
      throw new ApprovalError(
        'documentation_changed',
        `${options.planFile} declares documentation but ${bundleRootFor(options.planFile)} does not exist; run "harness docs ${options.planFile}" first`,
      );
    }
    documentationHash = bundle.hash;
  }

  // Newest first, so a step ID carried by several commits is reported against the last one to
  // accept it — the one an operator would look at.
  const carriers = new Map<string, string>();
  for (const accepted of await acceptedStepIds(options.repoPath, base.commit)) {
    if (!carriers.has(accepted.stepId)) carriers.set(accepted.stepId, accepted.commit);
  }

  return {
    manifest: {
      version: 1,
      plan_file: relative(dirname(resolve(options.manifestPath)), resolve(options.planFile)),
      repository: { base_branch: base.branch, base_commit: base.commit },
      inputs: {
        plan_hash: planHash,
        policy_hash: policyHash(activePolicy()),
        ...(documentationHash === undefined ? {} : { documentation_hash: documentationHash }),
      },
      runtime: {
        harness_version: HARNESS_VERSION,
        codex_image_id: images.codex.id,
        claude_image_id: images.claude.id,
        verifier_image_id: images.verifier.id,
        reviewer_image_id: images.reviewer.id,
        setup_image_id: images.setup.id,
        proxy_image_id: images.proxy.id,
      },
    },
    alreadyAccepted: plan.steps.flatMap((step) => {
      const commit = carriers.get(step.id);
      return commit === undefined ? [] : [{ stepId: step.id, commit }];
    }),
  };
}

/**
 * The approved manifest's own identity.
 *
 * Hashed from its content rather than its file bytes, so that reformatting or moving the file
 * is not mistaken for a different approval, while any approved value changing is.
 */
export function manifestHash(manifest: ExecutionManifest): string {
  const canonical = JSON.stringify({
    version: manifest.version,
    plan_file: manifest.plan_file,
    repository: manifest.repository,
    inputs: manifest.inputs,
    runtime: manifest.runtime,
  });

  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export async function writeManifest(path: string, manifest: ExecutionManifest): Promise<void> {
  await writeFile(path, stringify({ execution_manifest: manifest }));
}

export interface LoadedManifest {
  manifest: ExecutionManifest;
  /** Canonical identity of the approved manifest; what the state store keys a plan on. */
  manifestHash: string;
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

  return { manifest, manifestHash: manifestHash(manifest), planFile, plan, hash };
}

export interface ApprovedInputs {
  plan: Plan;
  /** Identity of the approved manifest; the state store keys the plan on it. */
  manifestHash: string;
  planHash: string;
  planFile: string;
  repoPath: string;
  baseBranch: string;
  baseCommit: string;
  images: RuntimeImages;
  /** Present exactly when the plan declares documentation; mounted read-only at `/context`. */
  documentation?: ApprovedDocumentation;
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

  // Before images, the base commit and any container work: an approval whose documentation
  // drifted must stop while the only cost is a message.
  const documentation = await approveDocumentation(loaded);

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
    manifestHash: loaded.manifestHash,
    planHash: loaded.hash,
    planFile: loaded.planFile,
    repoPath: options.repoPath,
    baseBranch: manifest.repository.base_branch,
    baseCommit: manifest.repository.base_commit,
    images,
    ...(documentation === undefined ? {} : { documentation }),
  };
}

/**
 * Prove the bundle on disk is the one that was approved, and say where it is.
 *
 * The plan and the approval have to agree that documentation exists at all: a hash without a
 * declaration, or a declaration without a hash, means the approval no longer describes the
 * plan. A stray `documentation/` directory beside a plan that declares none is not the
 * harness's business and is ignored.
 */
async function approveDocumentation(
  loaded: LoadedManifest,
): Promise<ApprovedDocumentation | undefined> {
  const approvedHash = loaded.manifest.inputs.documentation_hash;
  const declared = loaded.plan.documentation;

  if (declared === undefined) {
    if (approvedHash !== undefined) {
      throw new ApprovalError(
        'documentation_changed',
        `the approval carries a documentation hash, but ${loaded.planFile} declares no documentation; re-run prepare`,
      );
    }
    return undefined;
  }

  if (approvedHash === undefined) {
    throw new ApprovalError(
      'documentation_changed',
      `${loaded.planFile} declares documentation, but the approval carries no documentation hash; run "harness docs" and re-run prepare`,
    );
  }

  const bundleRoot = bundleRootFor(loaded.planFile);
  let bundle;
  try {
    bundle = await verifyBundle(bundleRoot, declared);
  } catch (error) {
    if (error instanceof DocumentationError) {
      throw new ApprovalError('documentation_changed', error.message);
    }
    throw error;
  }

  if (!bundle.present) {
    throw new ApprovalError(
      'documentation_changed',
      `${bundleRoot} is missing; run "harness docs ${loaded.planFile}" to download the approved documentation again`,
    );
  }

  if (bundle.hash !== approvedHash) {
    throw new ApprovalError(
      'documentation_changed',
      `${bundleRoot} is ${bundle.hash}, but ${approvedHash} was approved; delete the whole documentation directory, run "harness docs", then re-run prepare and approve the new manifest`,
    );
  }

  return { contextDir: contextDirFor(bundleRoot), hash: bundle.hash };
}

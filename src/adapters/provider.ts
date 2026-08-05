import type { Mount } from '../docker/args.js';
import type { RuntimeImage, RuntimeImages } from '../docker/images.js';
import type { AgentProfile } from '../routing/profiles.js';
import {
  CLAUDE_PROVIDER_ALLOWLIST,
  CLAUDE_VERSION,
  CODEX_PROVIDER_ALLOWLIST,
  CODEX_VERSION,
} from '../config/pins.js';
import type { FailureCategory } from '../run/failure.js';
import type { CompiledAgentPolicy, ProviderName, UsageMetadata } from './types.js';
import { compileClaudePolicy } from './claude/policy.js';
import { runClaudeAgent } from './claude/run.js';
import { compileCodexPolicy } from './codex/policy.js';
import { runCodexAgent } from './codex/run.js';

export interface ProviderRunOptions {
  prompt: string;
  /**
   * The policy this attempt compiled, seeded and recorded as `inputs.policy_hash`.
   *
   * Codex reads it because `AgentRunOptions` carries prompt and workdir only — model and
   * effort exist nowhere else in that call. A runner that already receives model, effort and
   * mode recompiles the identical policy from them instead, which is why Claude does not read
   * this field; `provider-descriptor.test.ts` pins that the two agree.
   */
  policy: CompiledAgentPolicy;
  network: string;
  env: Record<string, string>;
  mounts: Mount[];
  timeoutSeconds: number;
  graceSeconds: number;
  artifactDir: string;
  images: RuntimeImages;
  labels?: Record<string, string>;
  secrets: readonly string[];
}

export interface ProviderRunResult {
  status: 'completed' | 'failed' | 'timeout';
  exitCode: number;
  usage: UsageMetadata;
  reportedModel: string | null;
  stdout: string;
  stderr: string;
  failureCategory?: FailureCategory;
}

export interface ProviderDescriptor {
  profile: AgentProfile;
  provider: ProviderName;
  cliVersion: string;
  allowlist: readonly string[];
  authProvider: ProviderName;
  copyBackAuth: boolean;
  image(images: RuntimeImages): RuntimeImage;
  compile(prompt: string): CompiledAgentPolicy;
  run(options: ProviderRunOptions): Promise<ProviderRunResult>;
}

/** One fixed switch is the whole provider boundary for V1. */
export function providerDescriptor(profile: AgentProfile): ProviderDescriptor {
  if (profile.provider === 'codex') {
    return {
      profile,
      provider: 'codex',
      cliVersion: CODEX_VERSION,
      allowlist: CODEX_PROVIDER_ALLOWLIST,
      authProvider: 'codex',
      copyBackAuth: true,
      image: (images) => images.codex,
      compile: (prompt) =>
        compileCodexPolicy({
          prompt,
          workdir: '/workspace',
          model: profile.model,
          reasoningEffort: profile.effort,
        }),
      run: async (options) => {
        const result = await runCodexAgent(options);
        return {
          status: result.status,
          exitCode: result.exitCode,
          usage: result.usage,
          reportedModel: result.usage.model ?? null,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    };
  }

  return {
    profile,
    provider: 'claude',
    cliVersion: CLAUDE_VERSION,
    allowlist: CLAUDE_PROVIDER_ALLOWLIST,
    authProvider: 'claude',
    copyBackAuth: false,
    image: (images) => images.claude,
    compile: (prompt) =>
      compileClaudePolicy({
        mode: 'coding',
        prompt,
        model: profile.model,
        effort: profile.effort,
      }),
    run: async (options) => {
      const result = await runClaudeAgent({
        mode: 'coding',
        prompt: options.prompt,
        model: profile.model,
        effort: profile.effort,
        network: options.network,
        env: options.env,
        mounts: options.mounts,
        timeoutSeconds: options.timeoutSeconds,
        graceSeconds: options.graceSeconds,
        artifactDir: options.artifactDir,
        images: options.images,
        labels: options.labels,
        secrets: options.secrets,
      });
      return {
        status: result.status,
        exitCode: result.exitCode,
        usage: {
          model: result.reported_model ?? undefined,
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cached_input_tokens:
            result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens,
        },
        reportedModel: result.reported_model,
        stdout: result.stdout,
        stderr: result.stderr,
        ...(result.status === 'failed' && result.failure_category !== undefined
          ? { failureCategory: result.failure_category }
          : {}),
      };
    },
  };
}

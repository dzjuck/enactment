import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';
import {
  DIAGNOSIS_TIMEOUT_SECONDS,
  diagnoseFailure,
  diagnosisTimeoutSeconds,
} from '../../src/run/diagnosis.js';
import type { AttemptRecord } from '../../src/state/store.js';
import { CONTRACT_TIMEOUTS } from '../../src/run/timeout.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'b'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'c'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'d'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'e'.repeat(64)}` },
};

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'harness-diagnosis-'));
  dirs.push(root);
  const artifactPath = join(root, 'run-1');
  await mkdir(join(artifactPath, 'baseline'), { recursive: true });
  await mkdir(join(artifactPath, 'logs'), { recursive: true });

  const token = 'claude-secret-token';
  await writeFile(join(artifactPath, 'source-diff.json'), `{"path":"src/bad.js","secret":"${token}"}`);
  await writeFile(join(artifactPath, 'verification.json'), '{"status":"fail"}');
  await writeFile(join(artifactPath, 'baseline', 'baseline.json'), '{"status":"pass"}');
  await writeFile(join(artifactPath, 'logs', 'agent.log'), 'agent wrote an invalid change');

  const tokenDir = join(root, 'auth', 'claude');
  const tokenFile = join(tokenDir, 'token');
  await mkdir(tokenDir, { recursive: true, mode: 0o700 });
  await chmod(tokenDir, 0o700);
  await writeFile(tokenFile, token, { mode: 0o600 });
  await chmod(tokenFile, 0o600);

  const attempt: AttemptRecord = {
    row: 7,
    stepRow: 3,
    attemptId: 'normal-attempt',
    ordinal: 1,
    profileId: 'codex-fast',
    kind: 'normal',
    state: 'failed',
    phase: 'implementation',
    parentCommit: 'a'.repeat(40),
    artifactPath,
    runs: 1,
    failure: 'invalid_change: wrote outside scope',
  };

  return { attempt, token, tokenFile, artifactPath };
}

describe('failure diagnosis', () => {
  it('sends bounded redacted evidence to a tool-less Claude invocation with no source mount', async () => {
    const { attempt, token, tokenFile, artifactPath } = await fixture();
    const invoke = vi.fn(async (invocation) => {
      expect(invocation.mode).toBe('diagnosis');
      expect(invocation.profile.id).toBe('claude-deep');
      expect(invocation.mounts).toEqual([]);
      expect(invocation.prompt).toContain('Behavior: Implement slugify');
      expect(invocation.prompt).toContain('Phase: implementation');
      expect(invocation.prompt).toContain('Category: invalid_change');
      expect(invocation.prompt).toContain('source-diff.json');
      expect(invocation.prompt).toContain('verification.json');
      expect(invocation.prompt).toContain('baseline.json');
      expect(invocation.prompt).toContain('agent.log');
      expect(invocation.prompt).not.toContain(token);
      expect(invocation.prompt).not.toContain('implementation_paths');
      expect(invocation.prompt.length).toBeLessThan(12_000);
      return { status: 'completed' as const, text: 'The change exceeded its allowed scope.' };
    });

    const result = await diagnoseFailure(
      {
        attempt,
        behavior: 'Implement slugify',
        category: 'invalid_change',
        message: 'wrote outside scope',
        images: IMAGES,
        claudeTokenFile: tokenFile,
        timeoutSeconds: 30,
        graceSeconds: 2,
      },
      { invoke },
    );

    expect(result).toMatchObject({
      status: 'completed',
      text: 'The change exceeded its allowed scope.',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await readFile(join(artifactPath, 'diagnosis', 'diagnosis.json'), 'utf8')).not.toContain(
      token,
    );

    await diagnoseFailure(
      {
        attempt,
        behavior: 'Implement slugify',
        category: 'invalid_change',
        message: 'wrote outside scope',
        images: IMAGES,
        claudeTokenFile: tokenFile,
        timeoutSeconds: 30,
        graceSeconds: 2,
      },
      { invoke },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // A text-only call with no workspace, tools or dependencies needs a fraction of the agent
  // budget, and whatever it spends is spent in front of the stronger retry. DESIGN §5 lets a
  // phase lower a timeout and never raise one, so a task that asked for less still gets less.
  it('bounds the diagnosis budget below the agent budget', () => {
    expect(DIAGNOSIS_TIMEOUT_SECONDS).toBeLessThan(CONTRACT_TIMEOUTS.agent_seconds);
  });

  it.each([
    [CONTRACT_TIMEOUTS.agent_seconds, DIAGNOSIS_TIMEOUT_SECONDS],
    [DIAGNOSIS_TIMEOUT_SECONDS + 1, DIAGNOSIS_TIMEOUT_SECONDS],
    [60, 60],
  ])('caps a %d-second agent budget at %d for diagnosis', (agentSeconds, expected) => {
    expect(diagnosisTimeoutSeconds(agentSeconds)).toBe(expected);
  });
});

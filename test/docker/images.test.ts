import { beforeAll, describe, expect, it } from 'vitest';

import { CLAUDE_AUTH_PATH, CLAUDE_LAUNCHER } from '../../src/adapters/claude/policy.js';
import { CODEX_HOME_PATH } from '../../src/adapters/codex/policy.js';
import { CLAUDE_VERSION, CODEX_VERSION, IMAGE_PINS, IMAGE_ROLES } from '../../src/config/pins.js';
import { buildImage, resolveImageId } from '../../src/docker/images.js';
import { runContainer } from '../../src/docker/run.js';
import { imageEnvNames, runInImage } from '../helpers/docker.js';

beforeAll(async () => {
  for (const role of IMAGE_ROLES) {
    await buildImage(role);
  }
});

describe('runtime images', () => {
  it('builds the Codex image with the pinned Codex version', async () => {
    const result = await runInImage(IMAGE_PINS.codex.tag, ['codex', '--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(CODEX_VERSION);
  });

  it('builds the Claude image with the pinned native CLI and curl', async () => {
    const version = await runInImage(IMAGE_PINS.claude.tag, ['claude', '--version']);
    const curl = await runInImage(IMAGE_PINS.claude.tag, ['curl', '--version']);

    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain(CLAUDE_VERSION);
    expect(curl.exitCode).toBe(0);
  });

  it('owns both provider auth mount points as 1001:1001 mode 0700', async () => {
    for (const [role, path] of [
      ['codex', CODEX_HOME_PATH],
      ['claude', CLAUDE_AUTH_PATH],
    ] as const) {
      const result = await runInImage(IMAGE_PINS[role].tag, [
        'stat',
        '-c',
        '%u:%g %a',
        path,
      ]);
      expect(result.stdout.trim()).toBe('1001:1001 700');
    }
  });

  it('installs the fixed Claude launcher and traffic controls', async () => {
    const launcher = await runInImage(IMAGE_PINS.claude.tag, [
      'sh',
      '-c',
      `command -v ${CLAUDE_LAUNCHER}`,
    ]);
    const env = await imageEnvNames(IMAGE_PINS.claude.tag);

    expect(launcher.exitCode).toBe(0);
    expect(env).toEqual(
      expect.arrayContaining([
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'DISABLE_AUTOUPDATER',
        'DISABLE_TELEMETRY',
        'DISABLE_ERROR_REPORTING',
        'DISABLE_BUG_COMMAND',
        'CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY',
        'CLAUDE_CODE_DISABLE_TERMINAL_TITLE',
        'CLAUDE_CODE_DISABLE_COMMAND_INJECTION_CHECK',
        'NPM_CONFIG_UPDATE_NOTIFIER',
        'CI',
      ]),
    );
  });

  it('runs Claude with the production filesystem and capability hardening', async () => {
    const result = await runContainer({
      image: IMAGE_PINS.claude.tag,
      argv: [
        'sh',
        '-c',
        [
          'test "$(id -u):$(id -g)" = "1001:1001"',
          'touch /tmp/probe',
          'touch /home/agent/probe',
          '! touch /etc/rootfs-probe 2>/dev/null',
          'test "$(awk \'/^CapEff:/ { print $2 }\' /proc/self/status)" = "0000000000000000"',
          'test "$(awk \'/^NoNewPrivs:/ { print $2 }\' /proc/self/status)" = "1"',
        ].join(' && '),
      ],
      network: 'none',
      workdir: '/home/agent',
    });

    expect(result.exitCode).toBe(0);
  });

  it('builds a verifier image with no provider binary and no provider auth path', async () => {
    const codex = await runInImage(IMAGE_PINS.verifier.tag, ['sh', '-c', 'command -v codex']);
    const claude = await runInImage(IMAGE_PINS.verifier.tag, ['sh', '-c', 'command -v claude']);
    expect(codex.exitCode).not.toBe(0);
    expect(claude.exitCode).not.toBe(0);

    const authPaths = await runInImage(IMAGE_PINS.verifier.tag, [
      'sh',
      '-c',
      'ls -d /home/agent/.codex /run/agent-auth /run/claude-auth 2>/dev/null',
    ]);
    expect(authPaths.stdout).toBe('');

    const authEnv = await runInImage(IMAGE_PINS.verifier.tag, [
      'sh',
      '-c',
      'env | grep -iE "codex|openai|api_key" || true',
    ]);
    expect(authEnv.stdout).toBe('');
  });

  it('builds a setup image containing the package manager', async () => {
    const result = await runInImage(IMAGE_PINS.setup.tag, ['npm', '--version']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each(IMAGE_ROLES)('runs %s as uid 1001 and gid 1001', async (role) => {
    const uid = await runInImage(IMAGE_PINS[role].tag, ['id', '-u']);
    const gid = await runInImage(IMAGE_PINS[role].tag, ['id', '-g']);

    expect(uid.stdout.trim()).toBe('1001');
    expect(gid.stdout.trim()).toBe('1001');
  });

  it.each(IMAGE_ROLES)('resolves an image ID for %s', async (role) => {
    await expect(resolveImageId(IMAGE_PINS[role].tag)).resolves.toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

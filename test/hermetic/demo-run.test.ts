import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import type { RuntimeImages } from '../../src/docker/images.js';

const IMAGES: RuntimeImages = {
  codex: { role: 'codex', id: `sha256:${'a'.repeat(64)}` },
  claude: { role: 'claude', id: `sha256:${'b'.repeat(64)}` },
  verifier: { role: 'verifier', id: `sha256:${'c'.repeat(64)}` },
  reviewer: { role: 'reviewer', id: `sha256:${'d'.repeat(64)}` },
  setup: { role: 'setup', id: `sha256:${'e'.repeat(64)}` },
  proxy: { role: 'proxy', id: `sha256:${'f'.repeat(64)}` },
};

describe('demo modes', () => {
  it('publishes explicit replay and live package commands without nested npm output', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['demo:replay']).toBe('node demo/run.mjs replay');
    expect(packageJson.scripts.demo).toBe('node demo/run.mjs live');
  });

  it('accepts only replay and live before resolving images', async () => {
    const { parseDemoMode } = await import('../../demo/run.mjs');
    const resolveImages = vi.fn<() => Promise<RuntimeImages>>();

    expect(parseDemoMode('replay')).toBe('replay');
    expect(parseDemoMode('live')).toBe('live');
    expect(() => parseDemoMode(undefined)).toThrow(
      'usage: node demo/run.mjs <replay|live>',
    );
    expect(() => parseDemoMode('unknown')).toThrow(
      'usage: node demo/run.mjs <replay|live>',
    );
    expect(resolveImages).not.toHaveBeenCalled();
  });

  it('selects replay images, injection and placeholder credentials', async () => {
    const { resolveDemoMode } = await import('../../demo/run.mjs');
    const demoImageId = `sha256:${'1'.repeat(64)}`;
    const buildReplayImage = vi.fn(() => Promise.resolve(demoImageId));
    const resolveImages = vi.fn(() => Promise.resolve(IMAGES));

    const selected = await resolveDemoMode('replay', { buildReplayImage, resolveImages });

    expect(buildReplayImage).toHaveBeenCalledOnce();
    expect(resolveImages).toHaveBeenCalledOnce();
    expect(selected.images).toEqual({
      ...IMAGES,
      codex: { role: 'codex', id: demoImageId },
      claude: { role: 'claude', id: demoImageId },
    });
    expect(selected.injection).toEqual({
      codex: { role: 'codex', id: demoImageId },
      claude: { role: 'claude', id: demoImageId },
    });
    expect(selected.credentials).toBe('placeholder');
    expect(selected.demoImageId).toBe(demoImageId);
  });

  it('keeps production images and credential defaults in live mode', async () => {
    const { resolveDemoMode } = await import('../../demo/run.mjs');
    const buildReplayImage = vi.fn<() => Promise<string>>();
    const resolveImages = vi.fn(() => Promise.resolve(IMAGES));

    const selected = await resolveDemoMode('live', { buildReplayImage, resolveImages });

    expect(buildReplayImage).not.toHaveBeenCalled();
    expect(resolveImages).toHaveBeenCalledOnce();
    expect(selected.images).toEqual(IMAGES);
    expect(selected.injection).toBeUndefined();
    expect(selected.credentials).toBe('production');
    expect(selected.demoImageId).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import { OwnershipError, withOwnedResource } from '../../src/run/ownership.js';

describe('resource ownership', () => {
  it('hands ownership to the caller when the scope succeeds', async () => {
    const released: string[] = [];

    const value = await withOwnedResource(
      'ai-harness-proxy-1',
      async (name) => void released.push(name),
      () => Promise.resolve('handle'),
    );

    expect(value).toBe('handle');
    expect(released).toEqual([]);
  });

  it('releases the resource before the failure escapes', async () => {
    const released: string[] = [];
    const order: string[] = [];

    const failure = await withOwnedResource(
      'ai-harness-proxy-1',
      async (name) => {
        released.push(name);
        order.push('released');
      },
      () => Promise.reject(new Error('readiness never arrived')),
    ).catch((cause: unknown) => {
      order.push('reported');
      return cause;
    });

    expect(released).toEqual(['ai-harness-proxy-1']);
    expect(order).toEqual(['released', 'reported']);
    expect((failure as Error).message).toBe('readiness never arrived');
  });

  it('rethrows the original error untouched when cleanup succeeds', async () => {
    const original = new Error('connect failed');

    const failure = await withOwnedResource(
      'ai-harness-proxy-1',
      async () => {},
      () => Promise.reject(original),
    ).catch((cause: unknown) => cause);

    expect(failure).toBe(original);
  });

  it('retains both causes when the scope and its cleanup both fail', async () => {
    const primary = new Error('outward network connect failed');
    const secondary = new Error('container removal failed');

    const failure = await withOwnedResource(
      'ai-harness-proxy-1',
      () => Promise.reject(secondary),
      () => Promise.reject(primary),
    ).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(OwnershipError);
    expect((failure as OwnershipError).cause).toBe(primary);
    expect((failure as OwnershipError).cleanupCause).toBe(secondary);

    // Neither cause may be lost to the other: the message names both.
    expect((failure as Error).message).toContain('outward network connect failed');
    expect((failure as Error).message).toContain('container removal failed');
    expect((failure as Error).message).toContain('ai-harness-proxy-1');
  });

  it('never converts a cleanup failure into success', async () => {
    await expect(
      withOwnedResource(
        'ai-harness-proxy-1',
        () => Promise.reject(new Error('removal failed')),
        () => Promise.resolve('handle'),
      ),
    ).resolves.toBe('handle');

    // A cleanup that runs only on the failure path cannot mask a successful scope, but a
    // failing scope must never be reported as anything other than a failure.
    await expect(
      withOwnedResource(
        'ai-harness-proxy-1',
        () => Promise.reject(new Error('removal failed')),
        () => Promise.reject(new Error('scope failed')),
      ),
    ).rejects.toThrow(OwnershipError);
  });
});

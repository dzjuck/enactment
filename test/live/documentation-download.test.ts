import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { runDocumentationDownload } from '../../src/docs/download.js';
import { newAttemptId } from '../../src/volume/naming.js';
import { runtimeImages } from '../helpers/images.js';

const SOURCE = {
  url: 'https://petstore3.swagger.io/api/v3/openapi.json',
  path: 'petstore/openapi.json',
};

/**
 * The positive control the hermetic and Docker suites cannot give: a declared source really is
 * downloadable through the CONNECT proxy. Needs the internet; needs no provider credential and
 * spends no tokens.
 */
describe('real documentation download', () => {
  it('downloads a declared source through the proxy and hashes what it stored', async () => {
    const images = await runtimeImages();
    const attempt = newAttemptId();

    const result = await runDocumentationDownload({ attempt, sources: [SOURCE], images });

    const [downloaded] = result.sources;
    expect(downloaded?.path).toBe(SOURCE.path);
    expect(downloaded?.bytes.byteLength).toBeGreaterThan(0);
    expect(downloaded?.hash).toBe(
      `sha256:${createHash('sha256').update(downloaded?.bytes ?? Buffer.alloc(0)).digest('hex')}`,
    );
    expect(downloaded?.bytes.toString('utf8')).toContain('openapi');

    expect(
      result.proxyRecords.some(
        (record) => record.hostname === 'petstore3.swagger.io' && record.allowed,
      ),
    ).toBe(true);
  }, 600_000);
});

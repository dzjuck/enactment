import type { Writable } from 'node:stream';

export type ConnectionResult = 'tunneled' | 'denied' | 'error';

/**
 * The DESIGN.md §7 field set, and nothing more. The proxy is permanently L4, so it has no
 * request path, method, body or response status to record — claiming any of that would be a
 * lie about what was observed.
 */
export interface ProxyRecord {
  hostname: string;
  port: number;
  allowed: boolean;
  result: ConnectionResult;
  bytesToOrigin: number;
  bytesFromOrigin: number;
  durationMs: number;
}

export type RecordWriter = (record: ProxyRecord) => void;

export function jsonlWriter(stream: Writable): RecordWriter {
  return (record) => {
    stream.write(`${JSON.stringify(record)}\n`);
  };
}

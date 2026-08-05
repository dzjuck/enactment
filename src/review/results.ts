import { createHash } from 'node:crypto';
import { posix } from 'node:path';

import { z } from 'zod';

import {
  REVIEW_AFTER_ROOT,
  REVIEW_BEFORE_ROOT,
  REVIEW_SEVERITY_MAP,
  type ReviewSeverity,
} from './policy.js';
import type { ReviewTarget, ReviewTargets } from './targets.js';

const positionSchema = z.object({
  line: z.number().int().positive(),
  col: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});

const findingSchema = z.object({
  check_id: z.string().min(1),
  path: z.string().min(1),
  start: positionSchema,
  end: positionSchema,
  extra: z.object({ severity: z.string().min(1) }),
});

const outputSchema = z.object({
  version: z.string().min(1),
  results: z.array(findingSchema),
  errors: z.array(z.unknown()),
  paths: z.object({ scanned: z.array(z.string()) }),
});

export interface ReviewPosition {
  readonly line: number;
  readonly column: number;
}

export interface ReviewLocation {
  readonly start: ReviewPosition;
  readonly end: ReviewPosition;
}

export interface ReviewFinding {
  readonly ruleId: string;
  readonly path: string;
  readonly location: ReviewLocation;
  readonly severity: ReviewSeverity;
}

export interface ReviewResult {
  readonly findings: readonly ReviewFinding[];
}

export class ReviewResultsError extends Error {
  readonly category = 'review_failed' as const;

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ReviewResultsError';
  }
}

type Side = keyof ReviewTargets;

interface NormalizedFinding extends ReviewFinding {
  readonly side: Side;
  readonly matchedTextHash: string;
}

function parseOutput(document: string): z.infer<typeof outputSchema> {
  let json: unknown;
  try {
    json = JSON.parse(document);
  } catch (cause) {
    throw new ReviewResultsError('Invalid JSON in reviewer output', cause);
  }

  const parsed = outputSchema.safeParse(json);
  if (!parsed.success) {
    throw new ReviewResultsError(
      `Invalid reviewer result, including required locations: ${parsed.error.message}`,
    );
  }
  if (parsed.data.errors.length > 0) {
    throw new ReviewResultsError('Reviewer output contains scanner errors');
  }

  return parsed.data;
}

function targetMap(targets: readonly ReviewTarget[]): ReadonlyMap<string, Buffer> {
  return new Map(targets.map((target) => [target.path, target.content]));
}

function scanPath(path: string): { side: Side; path: string } {
  if (!posix.isAbsolute(path)) {
    throw new ReviewResultsError(`Reviewer result path is not absolute: ${path}`);
  }

  let side: Side;
  let relative: string;
  if (path.startsWith(`${REVIEW_BEFORE_ROOT}/`)) {
    side = 'before';
    relative = path.slice(REVIEW_BEFORE_ROOT.length + 1);
  } else if (path.startsWith(`${REVIEW_AFTER_ROOT}/`)) {
    side = 'after';
    relative = path.slice(REVIEW_AFTER_ROOT.length + 1);
  } else {
    throw new ReviewResultsError(`Reviewer result has an absolute path outside review roots: ${path}`);
  }

  if (posix.isAbsolute(relative)) {
    throw new ReviewResultsError(`Reviewer result resolves to an absolute repository path: ${path}`);
  }
  if (
    relative === '' ||
    relative.split('/').some((part) => part === '..' || part === '.') ||
    posix.normalize(relative) !== relative
  ) {
    throw new ReviewResultsError(`Reviewer result path contains traversal: ${path}`);
  }

  return { side, path: relative };
}

function severity(value: string): ReviewSeverity {
  const mapped = REVIEW_SEVERITY_MAP[value];
  if (mapped === undefined) {
    throw new ReviewResultsError(`Unsupported reviewer severity: ${value}`);
  }
  return mapped;
}

function validateLocation(
  start: z.infer<typeof positionSchema>,
  end: z.infer<typeof positionSchema>,
  content: Buffer,
): void {
  const positionsIncrease =
    end.line > start.line || (end.line === start.line && end.col > start.col);
  if (!positionsIncrease || end.offset <= start.offset || end.offset > content.length) {
    throw new ReviewResultsError('Reviewer result contains an invalid location');
  }
}

function normalize(
  output: z.infer<typeof outputSchema>,
  targets: ReviewTargets,
): NormalizedFinding[] {
  const contentBySide = {
    before: targetMap(targets.before),
    after: targetMap(targets.after),
  } satisfies Record<Side, ReadonlyMap<string, Buffer>>;

  return output.results.map((finding) => {
    const parsedPath = scanPath(finding.path);
    const content = contentBySide[parsedPath.side].get(parsedPath.path);
    if (content === undefined) {
      throw new ReviewResultsError(`Reviewer result does not match a review target: ${finding.path}`);
    }

    validateLocation(finding.start, finding.end, content);

    return {
      ruleId: finding.check_id,
      path: parsedPath.path,
      severity: severity(finding.extra.severity),
      location: {
        start: { line: finding.start.line, column: finding.start.col },
        end: { line: finding.end.line, column: finding.end.col },
      },
      side: parsedPath.side,
      matchedTextHash: createHash('sha256')
        .update(content.subarray(finding.start.offset, finding.end.offset))
        .digest('hex'),
    };
  });
}

function identity(finding: NormalizedFinding): string {
  return JSON.stringify([finding.ruleId, finding.path, finding.matchedTextHash]);
}

function compare(left: ReviewFinding, right: ReviewFinding): number {
  const severityOrder = { critical: 0, warning: 1 } satisfies Record<ReviewSeverity, number>;

  return (
    severityOrder[left.severity] - severityOrder[right.severity] ||
    left.path.localeCompare(right.path) ||
    left.location.start.line - right.location.start.line ||
    left.location.start.column - right.location.start.column ||
    left.location.end.line - right.location.end.line ||
    left.location.end.column - right.location.end.column ||
    left.ruleId.localeCompare(right.ruleId)
  );
}

/** Parse one pinned Semgrep document and return only findings introduced after the change. */
export function parseReviewResults(document: string, targets: ReviewTargets): ReviewResult {
  const normalized = normalize(parseOutput(document), targets);
  const baselineCounts = new Map<string, number>();

  for (const finding of normalized) {
    if (finding.side !== 'before') continue;
    const key = identity(finding);
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }

  const findings: ReviewFinding[] = [];
  for (const finding of normalized.filter((item) => item.side === 'after').sort(compare)) {
    const key = identity(finding);
    const baselineCount = baselineCounts.get(key) ?? 0;
    if (baselineCount > 0) {
      baselineCounts.set(key, baselineCount - 1);
      continue;
    }

    findings.push({
      ruleId: finding.ruleId,
      path: finding.path,
      severity: finding.severity,
      location: finding.location,
    });
  }

  return { findings };
}

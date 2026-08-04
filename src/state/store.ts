import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ProfileId } from '../routing/profiles.js';

export class StateStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateStoreError';
  }
}

/** One version, no migration framework: an unknown version is an error, not an upgrade. */
export const SCHEMA_VERSION = 2;

export type PlanState = 'approved' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Only the states recovery has to distinguish. `failed` is terminal for that attempt. */
export type AttemptState = 'running' | 'accepting' | 'completed' | 'failed';
export type AttemptKind = 'normal' | 'stronger';

/** Diagnostic only — the latest phase reached, not a second state machine. */
export type AttemptPhase =
  | 'preparing'
  | 'baseline'
  | 'tests'
  | 'red'
  | 'implementation'
  | 'green'
  | 'verify';

export interface PlanRecord {
  row: number;
  planId: string;
  manifestHash: string;
  planHash: string;
  repoPath: string;
  branch: string;
  baseCommit: string;
  headCommit?: string;
  state: PlanState;
}

export interface StepRecord {
  row: number;
  planRow: number;
  position: number;
  stepId: string;
  status: 'pending' | 'completed';
  commit?: string;
}

export interface AttemptRecord {
  row: number;
  stepRow: number;
  attemptId: string;
  ordinal: number;
  profileId: ProfileId;
  retryOfAttemptRow?: number;
  /** Derived from `retryOfAttemptRow`; never stored separately. */
  kind: AttemptKind;
  state: AttemptState;
  phase?: AttemptPhase;
  parentCommit: string;
  artifactPath: string;
  runs: number;
  candidateSnapshot?: string;
  idempotencyKey?: string;
  commit?: string;
  failure?: string;
}

export interface RegisterPlanInput {
  planId: string;
  manifestHash: string;
  planHash: string;
  repoPath: string;
  branch: string;
  baseCommit: string;
  stepIds: string[];
}

export interface StartAttemptInput {
  stepRow: number;
  attemptId: string;
  profileId: ProfileId;
  retryOfAttemptRow?: number;
  parentCommit: string;
  artifactPath: string;
}

export interface CompleteAcceptanceInput {
  planRow: number;
  stepRow: number;
  attemptRow: number;
  commit: string;
}

export interface FailPlanInput {
  planRow: number;
  attemptRow: number;
  failure: string;
}

const SCHEMA = `
CREATE TABLE schema_version (version INTEGER NOT NULL);

CREATE TABLE plans (
  row_id        INTEGER PRIMARY KEY,
  plan_id       TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  plan_hash     TEXT NOT NULL,
  repo_path     TEXT NOT NULL,
  branch        TEXT NOT NULL,
  base_commit   TEXT NOT NULL,
  head_commit   TEXT CHECK (head_commit IS NULL OR head_commit GLOB '[0-9a-f]*'),
  state         TEXT NOT NULL
                CHECK (state IN ('approved','running','completed','failed','cancelled'))
);

-- DESIGN §31 ownership: one live plan per canonical repository path. Not a process lock —
-- concurrent production runs stay unsupported because the startup sweep is global.
CREATE UNIQUE INDEX plans_one_active_repo
  ON plans(repo_path) WHERE state NOT IN ('completed','cancelled');

CREATE TABLE steps (
  row_id    INTEGER PRIMARY KEY,
  plan_row  INTEGER NOT NULL REFERENCES plans(row_id),
  position  INTEGER NOT NULL,
  step_id   TEXT NOT NULL,
  status    TEXT NOT NULL CHECK (status IN ('pending','completed')),
  commit_sha TEXT,
  UNIQUE(plan_row, position),
  UNIQUE(plan_row, step_id)
);

CREATE TABLE attempts (
  row_id             INTEGER PRIMARY KEY,
  step_row           INTEGER NOT NULL REFERENCES steps(row_id),
  attempt_id         TEXT NOT NULL,
  ordinal            INTEGER NOT NULL,
  profile_id         TEXT NOT NULL
                     CHECK (profile_id IN ('codex-fast','codex-deep','claude-balanced','claude-deep')),
  retry_of_attempt_row INTEGER REFERENCES attempts(row_id),
  state              TEXT NOT NULL
                     CHECK (state IN ('running','accepting','completed','failed')),
  phase              TEXT,
  parent_commit      TEXT NOT NULL,
  artifact_path      TEXT NOT NULL,
  runs               INTEGER NOT NULL DEFAULT 1,
  candidate_snapshot TEXT,
  idempotency_key    TEXT,
  commit_sha         TEXT,
  failure            TEXT,
  UNIQUE(step_row, ordinal),
  UNIQUE(step_row, attempt_id)
);
`;

type Row = Record<string, unknown>;

function text(row: Row, column: string): string {
  return String(row[column]);
}

function optionalText(row: Row, column: string): string | undefined {
  const value = row[column];
  return value === null || value === undefined ? undefined : String(value);
}

function number(row: Row, column: string): number {
  return Number(row[column]);
}

function planRecord(row: Row): PlanRecord {
  return {
    row: number(row, 'row_id'),
    planId: text(row, 'plan_id'),
    manifestHash: text(row, 'manifest_hash'),
    planHash: text(row, 'plan_hash'),
    repoPath: text(row, 'repo_path'),
    branch: text(row, 'branch'),
    baseCommit: text(row, 'base_commit'),
    headCommit: optionalText(row, 'head_commit'),
    state: text(row, 'state') as PlanState,
  };
}

function stepRecord(row: Row): StepRecord {
  return {
    row: number(row, 'row_id'),
    planRow: number(row, 'plan_row'),
    position: number(row, 'position'),
    stepId: text(row, 'step_id'),
    status: text(row, 'status') as StepRecord['status'],
    commit: optionalText(row, 'commit_sha'),
  };
}

function attemptRecord(row: Row): AttemptRecord {
  const retryOfAttemptRow =
    row.retry_of_attempt_row === null || row.retry_of_attempt_row === undefined
      ? undefined
      : number(row, 'retry_of_attempt_row');
  return {
    row: number(row, 'row_id'),
    stepRow: number(row, 'step_row'),
    attemptId: text(row, 'attempt_id'),
    ordinal: number(row, 'ordinal'),
    profileId: text(row, 'profile_id') as ProfileId,
    retryOfAttemptRow,
    kind: retryOfAttemptRow === undefined ? 'normal' : 'stronger',
    state: text(row, 'state') as AttemptState,
    phase: optionalText(row, 'phase') as AttemptPhase | undefined,
    parentCommit: text(row, 'parent_commit'),
    artifactPath: text(row, 'artifact_path'),
    runs: number(row, 'runs'),
    candidateSnapshot: optionalText(row, 'candidate_snapshot'),
    idempotencyKey: optionalText(row, 'idempotency_key'),
    commit: optionalText(row, 'commit_sha'),
    failure: optionalText(row, 'failure'),
  };
}

/**
 * A repository path is an identity here, so it is canonicalized before it is compared.
 * `/tmp` and `/private/tmp` are the same repository on macOS, and two plans owning it under
 * different spellings would defeat the ownership index entirely.
 */
function canonical(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return resolve(repoPath);
  }
}

/**
 * The harness's persistent progress record (DESIGN.md §31).
 *
 * Explicit SQL, one schema version, no ORM: what needs to survive a restart is a plan, its
 * ordered steps, and their attempts. Every method is synchronous because `node:sqlite` is.
 */
export class StateStore {
  private readonly db: DatabaseSync;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(path: string): StateStore {
    mkdirSync(dirname(resolve(path)), { recursive: true });
    const db = new DatabaseSync(path);

    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA journal_mode = WAL');

    let version: number | undefined;
    try {
      const rows = db.prepare('SELECT version FROM schema_version').all() as Row[];
      version = rows[0] === undefined ? undefined : number(rows[0], 'version');
    } catch {
      // No `schema_version` table: a database this harness has not created yet.
      version = undefined;
    }

    if (version === undefined) {
      db.exec(SCHEMA);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    } else if (version !== SCHEMA_VERSION) {
      db.close();
      throw new StateStoreError(
        `${path} has schema version ${String(version)}, but this harness expects ${String(SCHEMA_VERSION)}; ` +
          'there is no migration path in V1 — move the file aside to start a fresh state database',
      );
    }

    return new StateStore(db);
  }

  /** Idempotent: teardown paths close what they own without first proving nobody else did. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  foreignKeysEnabled(): boolean {
    const rows = this.db.prepare('PRAGMA foreign_keys').all() as Row[];
    return rows[0] !== undefined && number(rows[0], 'foreign_keys') === 1;
  }

  /**
   * Register an approved manifest, or return the plan it already created.
   *
   * Idempotent by manifest hash so a rerun resumes rather than duplicating, and exclusive by
   * repository so a second, different plan cannot start work in a tree another plan owns.
   */
  registerPlan(input: RegisterPlanInput): PlanRecord {
    const repoPath = canonical(input.repoPath);

    const existing = this.db
      .prepare(
        `SELECT * FROM plans WHERE repo_path = ? AND state NOT IN ('completed','cancelled')`,
      )
      .all(repoPath) as Row[];
    const active = existing[0];

    if (active !== undefined) {
      const plan = planRecord(active);
      if (plan.manifestHash === input.manifestHash) return plan;

      throw new StateStoreError(
        `${repoPath} is owned by plan "${plan.planId}" (${plan.state}, manifest ${plan.manifestHash}); ` +
          'cancel it before registering a different manifest',
      );
    }

    // Also idempotent for a finished plan: rerunning a completed manifest must find its own
    // record rather than starting a second copy of the same work.
    const finished = this.db
      .prepare(`SELECT * FROM plans WHERE repo_path = ? AND manifest_hash = ?`)
      .all(repoPath, input.manifestHash) as Row[];
    if (finished[0] !== undefined) return planRecord(finished[0]);

    this.db.exec('BEGIN');
    try {
      const planRow = Number(
        this.db
          .prepare(
            `INSERT INTO plans (plan_id, manifest_hash, plan_hash, repo_path, branch, base_commit, state)
             VALUES (?, ?, ?, ?, ?, ?, 'approved')`,
          )
          .run(
            input.planId,
            input.manifestHash,
            input.planHash,
            repoPath,
            input.branch,
            input.baseCommit,
          ).lastInsertRowid,
      );

      const insertStep = this.db.prepare(
        `INSERT INTO steps (plan_row, position, step_id, status) VALUES (?, ?, ?, 'pending')`,
      );
      for (const [position, stepId] of input.stepIds.entries()) {
        insertStep.run(planRow, position, stepId);
      }

      this.db.exec('COMMIT');
      return this.planByRow(planRow) as PlanRecord;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  planByRow(row: number): PlanRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM plans WHERE row_id = ?').all(row) as Row[];
    return rows[0] === undefined ? undefined : planRecord(rows[0]);
  }

  /** The plan a manifest created, whatever state it has since reached. */
  planForManifest(repoPath: string, manifestHash: string): PlanRecord | undefined {
    const rows = this.db
      .prepare('SELECT * FROM plans WHERE repo_path = ? AND manifest_hash = ?')
      .all(canonical(repoPath), manifestHash) as Row[];
    return rows[0] === undefined ? undefined : planRecord(rows[0]);
  }

  activePlanForRepo(repoPath: string): PlanRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM plans WHERE repo_path = ? AND state NOT IN ('completed','cancelled')`,
      )
      .all(canonical(repoPath)) as Row[];
    return rows[0] === undefined ? undefined : planRecord(rows[0]);
  }

  setPlanState(row: number, state: PlanState): void {
    this.db.prepare('UPDATE plans SET state = ? WHERE row_id = ?').run(state, row);
  }

  /** Releases the repository without deleting the branch, commits, steps or attempts. */
  cancelPlan(repoPath: string, manifestHash: string): void {
    const plan = this.activePlanForRepo(repoPath);

    if (plan === undefined) {
      throw new StateStoreError(`no active plan owns ${canonical(repoPath)}`);
    }
    if (plan.manifestHash !== manifestHash) {
      throw new StateStoreError(
        `${canonical(repoPath)} is owned by manifest ${plan.manifestHash}, not ${manifestHash}`,
      );
    }

    this.setPlanState(plan.row, 'cancelled');
  }

  steps(planRow: number): StepRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM steps WHERE plan_row = ? ORDER BY position')
      .all(planRow) as Row[];
    return rows.map(stepRecord);
  }

  nextPendingStep(planRow: number): StepRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM steps WHERE plan_row = ? AND status = 'pending' ORDER BY position LIMIT 1`,
      )
      .all(planRow) as Row[];
    return rows[0] === undefined ? undefined : stepRecord(rows[0]);
  }

  startAttempt(input: StartAttemptInput): AttemptRecord {
    const rows = this.db
      .prepare('SELECT COALESCE(MAX(ordinal), 0) AS highest FROM attempts WHERE step_row = ?')
      .all(input.stepRow) as Row[];
    const ordinal = (rows[0] === undefined ? 0 : number(rows[0], 'highest')) + 1;

    const row = Number(
      this.db
        .prepare(
          `INSERT INTO attempts
             (step_row, attempt_id, ordinal, profile_id, retry_of_attempt_row, state, phase,
              parent_commit, artifact_path)
           VALUES (?, ?, ?, ?, ?, 'running', 'preparing', ?, ?)`,
        )
        .run(
          input.stepRow,
          input.attemptId,
          ordinal,
          input.profileId,
          input.retryOfAttemptRow ?? null,
          input.parentCommit,
          input.artifactPath,
        )
        .lastInsertRowid,
    );

    return this.attemptByRow(row) as AttemptRecord;
  }

  attemptByRow(row: number): AttemptRecord | undefined {
    const rows = this.db.prepare('SELECT * FROM attempts WHERE row_id = ?').all(row) as Row[];
    return rows[0] === undefined ? undefined : attemptRecord(rows[0]);
  }

  attempts(stepRow: number): AttemptRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM attempts WHERE step_row = ? ORDER BY ordinal')
      .all(stepRow) as Row[];
    return rows.map(attemptRecord);
  }

  setAttemptPhase(row: number, phase: AttemptPhase): void {
    this.db.prepare('UPDATE attempts SET phase = ? WHERE row_id = ?').run(phase, row);
  }

  setAttemptState(row: number, state: AttemptState): void {
    this.db.prepare('UPDATE attempts SET state = ? WHERE row_id = ?').run(state, row);
  }

  /** Recorded before `accepting`, so recovery never needs new model output to finish. */
  setAttemptCandidate(row: number, snapshotHash: string, idempotencyKey: string): void {
    this.db
      .prepare('UPDATE attempts SET candidate_snapshot = ?, idempotency_key = ? WHERE row_id = ?')
      .run(snapshotHash, idempotencyKey, row);
  }

  /** A recovery run of the same attempt; the ordinal and ID stay put. */
  recordRecoveryRun(row: number, artifactPath: string): number {
    this.db
      .prepare('UPDATE attempts SET runs = runs + 1, artifact_path = ? WHERE row_id = ?')
      .run(artifactPath, row);
    return this.attemptByRow(row)?.runs ?? 1;
  }

  /** Atomically stops an attempt and its plan, so recovery cannot observe half a failure. */
  failPlan(input: FailPlanInput): void {
    this.db.exec('BEGIN');
    try {
      const attempt = this.db
        .prepare(`UPDATE attempts SET state = 'failed', failure = ? WHERE row_id = ?`)
        .run(input.failure, input.attemptRow);
      if (attempt.changes !== 1) {
        throw new StateStoreError(`attempt row ${String(input.attemptRow)} does not exist`);
      }

      const plan = this.db
        .prepare(`UPDATE plans SET state = 'failed' WHERE row_id = ?`)
        .run(input.planRow);
      if (plan.changes !== 1) {
        throw new StateStoreError(`plan row ${String(input.planRow)} does not exist`);
      }

      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * The one write that makes an acceptance durable: attempt, step and plan head together.
   *
   * A partial version of this is what recovery cannot repair — a completed step whose head
   * never moved would start the next step from the wrong parent — so it is one transaction.
   */
  completeAcceptance(input: CompleteAcceptanceInput): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`UPDATE attempts SET state = 'completed', commit_sha = ? WHERE row_id = ?`)
        .run(input.commit, input.attemptRow);
      this.db
        .prepare(`UPDATE steps SET status = 'completed', commit_sha = ? WHERE row_id = ?`)
        .run(input.commit, input.stepRow);
      this.db
        .prepare('UPDATE plans SET head_commit = ? WHERE row_id = ?')
        .run(input.commit, input.planRow);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

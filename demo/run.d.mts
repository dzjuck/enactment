import type { RuntimeImages } from '../src/docker/images.js';
import type { PlanReport } from '../src/run/coordinator.js';

export type DemoMode = 'replay' | 'live';

export interface DemoResult {
  exitCode: number;
  report: PlanReport;
  root: string;
  repoPath: string;
  stateDirectory: string;
  artifactDir: string;
  manifestPath: string;
  baseCommit: string;
  demoImageId?: string;
  productionImages: RuntimeImages;
}

export interface DemoModeRuntime {
  images: RuntimeImages;
  injection?: Pick<RuntimeImages, 'codex' | 'claude'>;
  credentials: 'placeholder' | 'production';
  demoImageId?: string;
  productionImages: RuntimeImages;
}

export function parseDemoMode(value: string | undefined): DemoMode;

export function resolveDemoMode(
  mode: DemoMode,
  dependencies?: {
    buildReplayImage?: () => Promise<string>;
    resolveImages?: () => Promise<RuntimeImages>;
  },
): Promise<DemoModeRuntime>;

export function runDemo(options: {
  mode: DemoMode;
  write: (text: string) => void;
}): Promise<DemoResult>;

export function runDemoMain(options: {
  mode: string | undefined;
  write: (text: string) => void;
  run?: (options: {
    mode: DemoMode;
    write: (text: string) => void;
  }) => Promise<DemoResult>;
}): Promise<DemoResult | { exitCode: 1 }>;

export type DemoProvider = 'codex' | 'claude';

export function findMissingLiveCredentials(): Promise<DemoProvider[]>;

export function runDemoCommand(options: {
  mode: string | undefined;
  write: (text: string) => void;
  checkCredentials?: () => Promise<DemoProvider[]>;
  build?: () => Promise<void>;
  main?: (options: {
    mode: DemoMode;
    write: (text: string) => void;
  }) => Promise<DemoResult | { exitCode: 1 }>;
}): Promise<DemoResult | { exitCode: 1 }>;

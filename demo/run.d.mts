import type { RuntimeImages } from '../src/docker/images.js';
import type { PlanReport } from '../src/run/coordinator.js';

export interface DemoResult {
  exitCode: number;
  report: PlanReport;
  root: string;
  repoPath: string;
  stateDirectory: string;
  artifactDir: string;
  manifestPath: string;
  baseCommit: string;
  demoImageId: string;
  productionImages: RuntimeImages;
}

export function runDemo(options: {
  write: (text: string) => void;
}): Promise<DemoResult>;

// Build time only: measures the repository this site is built from, for the code tape.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Pkg { path: string; lines: number; tests: number }

/** The packages a block passes through, in order, then the ones around them. */
export const PATH = ['packages/chain-config', 'packages/providers', 'apps/indexer', 'packages/db', 'packages/explorer-core', 'apps/explorer'];
export const AROUND = ['apps/admin', 'apps/status', 'apps/altscan-site', 'packages/settings-schema', 'packages/types'];

const SOURCE = /\.(ts|tsx|astro)$/;
const TEST = /\.test\.|\/test\//;

/** Lines of tracked TypeScript per package, and how many of them are tests. */
export function measure(paths: string[]): Pkg[] {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fileURLToPath(new URL('.', import.meta.url)) }).toString().trim();
  return paths.map((path) => {
    const files = execFileSync('git', ['ls-files', path], { cwd: root }).toString().split('\n').filter((f) => SOURCE.test(f));
    let lines = 0, tests = 0;
    for (const f of files) {
      const n = readFileSync(`${root}/${f}`, 'utf8').split('\n').length;
      lines += n;
      if (TEST.test(f)) tests += n;
    }
    return { path, lines, tests };
  });
}

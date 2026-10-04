// Build time only: measures the repository this site is built from, for the code tape.
// Not cached by Turbo (turbo.json): the counts depend on every workspace, not just this one.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Pkg { path: string; lines: number; tests: number }

/** The packages a block passes through, in order. */
export const PATH = ['packages/chain-config', 'packages/providers', 'apps/indexer', 'packages/db', 'packages/explorer-core', 'apps/explorer'];

const SOURCE = /\.tsx?$/;
const TEST = /\.test\.|\/test\//;

/** Lines of tracked TypeScript per workspace, and how many are tests: the PATH packages, then
 *  every other app and package, so a new workspace can't drop out of the total. */
export function measure(): { path: Pkg[]; around: Pkg[] } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: fileURLToPath(new URL('.', import.meta.url)) }).toString().trim();
  const files = execFileSync('git', ['ls-files', 'apps', 'packages'], { cwd: root }).toString().split('\n').filter((f) => SOURCE.test(f));
  const count = (path: string): Pkg => {
    let lines = 0, tests = 0;
    for (const f of files.filter((f) => f.startsWith(`${path}/`))) {
      const n = readFileSync(`${root}/${f}`, 'utf8').split('\n').length - 1; // as wc -l counts
      lines += n;
      if (TEST.test(f)) tests += n;
    }
    return { path, lines, tests };
  };
  const all = [...new Set(files.map((f) => f.split('/').slice(0, 2).join('/')))];
  return { path: PATH.map(count), around: all.filter((p) => !PATH.includes(p)).sort().map(count) };
}

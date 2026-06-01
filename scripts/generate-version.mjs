import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const runGit = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const packageVersion = '0.1.0';
const tag = runGit(['describe', '--tags', '--abbrev=0']);
const commit = runGit(['rev-parse', '--short=12', 'HEAD']) || 'unknown';
const dirty = runGit(['status', '--porcelain']) ? '.dirty' : '';
const version = `${tag || `v${packageVersion}`}-${commit}${dirty}`;
const output = resolve('src/generated/version.ts');

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `export const APP_VERSION = ${JSON.stringify(version)};\n`);
console.log(`Generated ${output}: ${version}`);

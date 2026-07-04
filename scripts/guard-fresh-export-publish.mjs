#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Paths the OSS export manifest excludes. Their presence marks this tree as the
// private development repository regardless of what git metadata says, so the
// guard must not trust commit counts (a shallow clone shows one commit) or the
// absence of .git (an unpacked copy of the private tree has none).
const PRIVATE_ONLY_PATHS = ['docs/plans', 'docs/decisions'];

function refuse(lines) {
  console.error(['Refusing to publish from this tree.', ...lines].join('\n'));
  process.exit(1);
}

const privateMarkers = PRIVATE_ONLY_PATHS.filter((path) => existsSync(join(REPO_ROOT, path)));
if (privateMarkers.length > 0) {
  refuse([
    'It contains private development content that the OSS export manifest excludes:',
    ...privateMarkers.map((path) => `  - ${path}/`),
    'Publish only from a fresh squashed export prepared per the OSS publish gate decision.',
  ]);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

if (!existsSync(join(REPO_ROOT, '.git'))) {
  console.log('No git metadata and no private-only paths; assuming a prepared export tree.');
  process.exit(0);
}

try {
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    console.log('Not inside a git work tree and no private-only paths; assuming a prepared export tree.');
    process.exit(0);
  }

  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    refuse([
      'This checkout is shallow, so its visible commit count cannot prove a fresh single-commit export.',
      'Publish only from a fresh squashed export with a single initial commit and full history.',
    ]);
  }

  const sampledCommits = git(['rev-list', '--max-count=2', 'HEAD'])
    .split('\n')
    .filter(Boolean);
  if (sampledCommits.length < 1) {
    throw new Error('could not determine commit count');
  }

  if (sampledCommits.length > 1) {
    const commitCount = Number(git(['rev-list', '--count', 'HEAD']));
    refuse([
      'Publish only from a fresh squashed export with a single initial commit.',
      `Detected ${commitCount} commits in this checkout.`,
    ]);
  }

  console.log('Fresh single-commit export publish guard passed.');
} catch (error) {
  console.error(
    `Unable to verify fresh-export publish guard: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

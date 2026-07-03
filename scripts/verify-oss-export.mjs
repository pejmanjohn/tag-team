#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'slack-flue-export-'));

const denyPatterns = [
  ['private source project', new RegExp(['ski', 'llet'].join(''), 'i')],
  ['deleted source path', new RegExp(['docs', '\\/', 'source'].join(''), 'i')],
  ['local package-manager path', new RegExp(['\\/', 'opt', '\\/', 'home', 'brew'].join(''), 'i')],
  ['internal product name', new RegExp(['claude', '[- ]?', 'tag'].join(''), 'i')],
  ['private workspace name', new RegExp(['paper', 'plane'].join(''), 'i')],
  ['private company name', new RegExp(['mag', 'oosh'].join(''), 'i')],
  ['private channel name', new RegExp(['all-', 'paper', 'plane-', 'labs'].join(''), 'i')],
  ['local user path', new RegExp(['\\/', 'Users', '\\/'].join(''), 'i')],
  ['live rehearsal marker', new RegExp(['can', 'ary'].join(''), 'i')],
];

const forbiddenBinaryExtensions = new Set([
  '.avif',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    input: options.input,
    stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    encoding: options.encoding,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function runCapture(command, args) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: null,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result.stdout;
}

function assertMissing(path) {
  if (existsSync(join(scratch, path))) {
    fail(`Export still contains excluded path: ${path}`);
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function scanExportTree() {
  const findings = [];
  for (const file of walk(scratch)) {
    const rel = relative(scratch, file);
    const extension = extname(file).toLowerCase();
    if (forbiddenBinaryExtensions.has(extension)) {
      findings.push(`${rel}: forbidden binary/image extension ${extension}`);
      continue;
    }

    const size = statSync(file).size;
    if (size > 5_000_000) {
      findings.push(`${rel}: file is too large for text leak scanning (${size} bytes)`);
      continue;
    }

    const buffer = readFileSync(file);
    if (buffer.includes(0)) {
      findings.push(`${rel}: binary content is not allowed in the OSS export`);
      continue;
    }

    const text = buffer.toString('utf8');
    for (const [label, pattern] of denyPatterns) {
      if (pattern.test(text)) {
        findings.push(`${rel}: matched denied term ${label}`);
      }
    }
  }

  if (findings.length > 0) {
    fail(`OSS export leak scan failed:\n${findings.join('\n')}`);
  }
}

console.log(`SCRATCH=${scratch}`);
const archive = runCapture('git', ['archive', '--format=tar', 'HEAD']);
run('tar', ['-x', '-C', scratch], { input: archive });

rmSync(join(scratch, 'docs', 'plans'), { recursive: true, force: true });
rmSync(join(scratch, 'docs', 'decisions'), { recursive: true, force: true });

if (!existsSync(join(scratch, 'LICENSE'))) {
  fail('Export is missing LICENSE');
}

assertMissing(['docs', 'source'].join('/'));
assertMissing('docs/START_HERE.md');
assertMissing(['docs', ['slack-assistant-ux-', 'can', 'ary-2026-06-29.png'].join('')].join('/'));
assertMissing(
  ['docs', ['slack-assistant-ux-ephemeral-', 'can', 'ary-2026-06-29.png'].join('')].join('/'),
);

const packageJson = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
if (packageJson.private || !packageJson.description || packageJson.license !== 'MIT' || !packageJson.repository) {
  fail('Export package.json is missing publish metadata or still has private:true');
}

scanExportTree();

run('npm', ['ci'], { cwd: scratch });
run('npm', ['test'], { cwd: scratch });
run('node', ['scripts/verify-flue-offline-turn.mjs'], { cwd: scratch });
run('node', ['scripts/verify-durability.mjs'], { cwd: scratch });
run('node', ['scripts/verify-tool-policy.mjs'], { cwd: scratch });
run('node', ['scripts/verify-providers.mjs'], { cwd: scratch });

console.log('OSS export verification passed');

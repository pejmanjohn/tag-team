#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'chickpea-export-'));

const term = (...parts) => parts.join('');
const exportPath = (...parts) => posix.join(...parts);
const sourceDocsPath = exportPath('docs', term('sou', 'rce'));
const rehearsalScreenshotPath = (prefix) =>
  exportPath('docs', term(prefix, 'can', 'ary-2026-06-29.png'));

const denyPatterns = [
  ['private source project', new RegExp(term('ski', 'llet'), 'i')],
  ['deleted source path', new RegExp(term('docs', '\\/', 'sou', 'rce'), 'i')],
  ['local package-manager path', new RegExp(term('\\/', 'opt', '\\/', 'home', 'brew'), 'i')],
  ['internal product name', new RegExp(term('claude', '[- ]?', 'tag'), 'i')],
  ['private workspace name', new RegExp(term('paper', 'plane'), 'i')],
  ['private company name', new RegExp(term('mag', 'oosh'), 'i')],
  ['private channel name', new RegExp(term('all-', 'paper', 'plane-', 'labs'), 'i')],
  ['local user path', new RegExp(term('\\/', 'Users', '\\/'), 'i')],
  ['live rehearsal marker', new RegExp(term('can', 'ary'), 'i')],
];

const excludedPaths = [
  sourceDocsPath,
  exportPath('docs', 'START_HERE.md'),
  rehearsalScreenshotPath('slack-assistant-ux-'),
  rehearsalScreenshotPath('slack-assistant-ux-ephemeral-'),
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

const allowedBinaryFiles = new Map([
  [
    exportPath('assets', 'bot-avatar.png'),
    '3cee85ef83c9132393b57ef52ce73dcd3f2b1724a71f1fa8ef37dafd6f5ecdb4',
  ],
  [
    exportPath('assets', 'admin-page.png'),
    '68c94f054f6492300e77c62304f896735ef2fc3c81a37225c9539f179c073098',
  ],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function extractHeadArchive() {
  run('sh', [
    '-c',
    'git archive --format=tar HEAD | tar -x -C "$1"',
    'verify-oss-export',
    scratch,
  ]);
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

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function scanExportTree() {
  const findings = [];
  for (const file of walk(scratch)) {
    const rel = relative(scratch, file);
    const extension = extname(file).toLowerCase();
    const size = statSync(file).size;
    if (forbiddenBinaryExtensions.has(extension)) {
      const expectedHash = allowedBinaryFiles.get(rel);
      if (!expectedHash) {
        findings.push(`${rel}: forbidden binary/image extension ${extension}`);
        continue;
      }

      const actualHash = sha256(file);
      if (actualHash !== expectedHash) {
        findings.push(`${rel}: allowed binary hash mismatch (${actualHash})`);
      }
      continue;
    }

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

function verifyNpmPackManifest() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`npm pack manifest failed:\n${result.stderr || result.stdout}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    fail(`npm pack returned invalid JSON:\n${result.stdout}`);
  }
  const files = new Set((manifest[0]?.files ?? []).map((entry) => entry.path));
  const required = [
    '.dev.vars.example',
    '.env.example',
    'LICENSE',
    'README.md',
    'assets/admin-page.png',
    'assets/bot-avatar.png',
    'scripts/deploy-with-epilogue.mjs',
    'slack-app-manifest.json',
    'src/app.ts',
    'wrangler.jsonc',
  ];
  const missing = required.filter((path) => !files.has(path));
  const forbidden = [...files].filter(
    (path) =>
      path === '.worktreeinclude' ||
      path.startsWith('.claude/') ||
      path.startsWith('.github/') ||
      path.startsWith('design/') ||
      path.startsWith('docs/') ||
      path.startsWith('tmp/'),
  );
  if (missing.length > 0 || forbidden.length > 0) {
    fail(
      [
        'npm package manifest is not release-clean:',
        ...missing.map((path) => `missing required file: ${path}`),
        ...forbidden.map((path) => `forbidden packaged file: ${path}`),
      ].join('\n'),
    );
  }
}

let passed = false;
try {
  console.log(`SCRATCH=${scratch}`);
  extractHeadArchive();

  rmSync(join(scratch, 'docs', 'plans'), { recursive: true, force: true });
  rmSync(join(scratch, 'docs', 'decisions'), { recursive: true, force: true });

  if (!existsSync(join(scratch, 'LICENSE'))) {
    fail('Export is missing LICENSE');
  }

  for (const path of excludedPaths) {
    assertMissing(path);
  }

  const packageJson = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  if (packageJson.private || !packageJson.description || packageJson.license !== 'MIT' || !packageJson.repository) {
    fail('Export package.json is missing publish metadata or still has private:true');
  }

  scanExportTree();
  verifyNpmPackManifest();

  run('npm', ['ci'], { cwd: scratch });
  run('npm', ['run', 'test:ci'], { cwd: scratch });
  run('node', ['scripts/verify-flue-offline-turn.mjs'], { cwd: scratch });
  run('npm', ['run', 'verify:durability'], { cwd: scratch });
  run('npm', ['run', 'verify:providers'], { cwd: scratch });

  console.log('OSS export verification passed');
  passed = true;
} finally {
  if (passed && process.env.KEEP_EXPORT_SCRATCH !== '1') {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`Cleaned SCRATCH=${scratch}`);
  } else {
    console.log(`Export scratch preserved at ${scratch}`);
  }
}

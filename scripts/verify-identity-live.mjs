#!/usr/bin/env node
import { WebClient } from '@slack/web-api';

import { defaultBotIdentity, IdentityStore } from '../src/config/identity.ts';
import { checkIdentity, readManifestIdentity } from '../src/slack/identity-check.ts';

const results = [];

function record(status, name, detail) {
  results.push({ status, name });
  console.log(`${status.padEnd(7)} ${name}${detail ? ` - ${detail}` : ''}`);
}

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  record('FAIL', 'env', 'SLACK_BOT_TOKEN is required');
  process.exit(1);
}

const client = new WebClient(token, {
  retryConfig: { retries: 0 },
  ...(process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {}),
});

const identity = new IdentityStore().get();
const manifest = readManifestIdentity();

try {
  const result = await checkIdentity(client, identity);

  record(
    result.name === 'match' ? 'PASS' : 'FAIL',
    'name',
    result.name === 'match'
      ? `live display name "${result.details.liveName}" matches slack-app-manifest.json`
      : `expected "${result.details.expectedName}", live "${result.details.liveName || '(empty)'}"`,
  );

  if (result.icon === 'custom') {
    record('PASS', 'icon', `custom Slack-hosted avatar detected at ${result.details.iconUrl}`);
  } else if (result.icon === 'default') {
    record('FAIL', 'icon', `Slack stock avatar detected at ${result.details.iconUrl}`);
  } else {
    record('UNKNOWN', 'icon', `could not classify avatar URL ${result.details.iconUrl ?? '(empty)'}`);
  }

  console.log('');
  console.log(`Slack app console: ${result.details.consoleUrl}`);
  console.log(`App name: ${manifest.name}`);
  console.log(`Bot user display name: ${manifest.botDisplayName}`);
  console.log(`Description: ${manifest.description}`);
  console.log(`Avatar file: ${defaultBotIdentity.avatarPath}`);
} catch (error) {
  record('FAIL', 'identity-check', error instanceof Error ? error.message : String(error));
}

const failed = results.filter((result) => result.status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} blocking checks passed`);
process.exit(failed.length === 0 ? 0 : 1);

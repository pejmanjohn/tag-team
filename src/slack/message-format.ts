export const slackMarkdownBlockTextLimit = 12_000;
export const slackFallbackTextLimit = 4_000;

export type SlackReplyFormat = 'plain_text' | 'mrkdwn' | 'markdown';

export interface SlackMarkdownBlock {
  type: 'markdown';
  text: string;
}

export interface SlackMrkdwnTextElement {
  type: 'mrkdwn';
  text: string;
}

export interface SlackContextBlock {
  type: 'context';
  elements: SlackMrkdwnTextElement[];
}

export interface SlackPlainTextObject {
  type: 'plain_text';
  text: string;
  emoji: false;
}

export interface SlackSectionBlock {
  type: 'section';
  text: SlackPlainTextObject;
}

export type SlackMessageBlock = SlackMarkdownBlock | SlackSectionBlock | SlackContextBlock;

export interface RenderedSlackMessage {
  text: string;
  blocks?: SlackMessageBlock[];
  mrkdwn?: boolean;
}

export interface SlackAdminUrlParams {
  agentId?: string;
  channelId?: string;
}

export interface SlackReplyFooter {
  profileName: string;
  // Omitted when the model cannot be resolved — the footer drops the segment
  // rather than leaking a diagnostic placeholder into user-facing chrome.
  modelLabel?: string | undefined;
  agentId: string;
  publicUrl?: string | undefined;
}

export function renderSlackMessage(text: string, format: SlackReplyFormat): RenderedSlackMessage {
  const normalized = normalizeMessageText(text);

  if (format === 'markdown') {
    return {
      text: markdownFallbackText(normalized),
      blocks: [
        {
          type: 'markdown',
          text: truncateText(normalized, slackMarkdownBlockTextLimit),
        },
      ],
    };
  }

  if (format === 'plain_text') {
    return {
      text: truncateText(escapeSlackControlCharacters(normalized), slackFallbackTextLimit),
      mrkdwn: false,
    };
  }

  return {
    text: truncateText(normalized, slackFallbackTextLimit),
  };
}

export function appendSlackReplyFooter(
  rendered: RenderedSlackMessage,
  footer: SlackReplyFooter,
): RenderedSlackMessage {
  const contentBlocks =
    rendered.blocks && rendered.blocks.length > 0 ? rendered.blocks : [contentBlockFor(rendered)];

  return {
    text: rendered.text,
    blocks: [...contentBlocks, renderSlackReplyFooterBlock(footer)],
  };
}

// Wrap a block-less rendered message so the footer can be attached. A plain_text
// final (mrkdwn:false) must stay literal — a markdown block would parse it, so
// it becomes a plain_text section block; markdown/mrkdwn content keeps parsing.
function contentBlockFor(rendered: RenderedSlackMessage): SlackMessageBlock {
  const text = truncateText(rendered.text, slackMarkdownBlockTextLimit);
  if (rendered.mrkdwn === false) {
    return { type: 'section', text: { type: 'plain_text', text, emoji: false } };
  }
  return { type: 'markdown', text };
}

export function renderSlackReplyFooterBlock(footer: SlackReplyFooter): SlackContextBlock {
  const segments = [escapeSlackControlCharacters(footer.profileName)];
  if (footer.modelLabel) {
    segments.push(escapeSlackControlCharacters(footer.modelLabel));
  }
  segments.push(renderSlackConfigureLink(footer.publicUrl, { agentId: footer.agentId }));
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: segments.join(' | ') }],
  };
}

// The one place that turns a public URL into the Slack-visible "Configure" link
// (an mrkdwn <url|label>, or plain "Configure" when no URL is configured). Both
// the reply footer and the channel onboarding message render through this so the
// link syntax and copy never drift between them.
export function renderSlackConfigureLink(
  publicUrl: string | undefined,
  params: SlackAdminUrlParams = {},
): string {
  const adminUrl = buildSlackAdminUrl(publicUrl, params);
  return adminUrl ? `<${adminUrl}|Configure>` : 'Configure';
}

// The channel onboarding disclosure posted when the bot itself joins a channel.
// Rendered here (the presentation layer) so all Slack-visible chrome — footer,
// configure link, onboarding — lives in one place and stays unit-testable.
export function renderChannelOnboarding(params: {
  botUserId: string;
  channelId: string;
  publicUrl: string | undefined;
}): string {
  const configure = renderSlackConfigureLink(params.publicUrl, { channelId: params.channelId });
  return [
    `Mention <@${params.botUserId}> to start a thread.`,
    'Flue Assistant reads the thread and bounded recent context only when asked.',
    'There is no passive monitoring.',
    `${configure} this channel's profile in /admin.`,
  ].join(' ');
}

export function buildSlackAdminUrl(
  publicUrl: string | undefined,
  params: SlackAdminUrlParams = {},
): string | undefined {
  const trimmed = publicUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  let url: URL;
  try {
    // '/admin' is root-absolute, so it replaces any path on the base — the
    // base's own path and trailing slash are irrelevant.
    url = new URL('/admin', trimmed);
  } catch {
    return undefined;
  }

  // Only http(s) may become a clickable Configure link. A misconfigured
  // publicUrl with another scheme (ftp:, javascript:) or embedded userinfo
  // (https://evil@real-host) falls back to the plain "Configure" label rather
  // than presenting a misleading link under a trusted affordance.
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return undefined;
  }

  if (params.agentId) {
    url.searchParams.set('agent', params.agentId);
  }
  if (params.channelId) {
    url.searchParams.set('channel', params.channelId);
  }
  return url.toString();
}

export function markdownFallbackText(markdown: string): string {
  const withoutCodeFences = markdown.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1');
  const fallback = withoutCodeFences
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^\s{0,3}[-*+]\s+/gm, '- ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return truncateText(escapeSlackControlCharacters(fallback || '(empty reply)'), slackFallbackTextLimit);
}

function normalizeMessageText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim() || '(empty reply)';
}

function escapeSlackControlCharacters(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const suffix = '\n\n[truncated]';
  return `${text.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

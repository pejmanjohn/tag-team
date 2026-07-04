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

export type SlackMessageBlock = SlackMarkdownBlock | SlackContextBlock;

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
  modelLabel: string;
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
    rendered.blocks && rendered.blocks.length > 0
      ? rendered.blocks
      : [{ type: 'markdown' as const, text: truncateText(rendered.text, slackMarkdownBlockTextLimit) }];

  return {
    text: rendered.text,
    blocks: [...contentBlocks, renderSlackReplyFooterBlock(footer)],
  };
}

export function renderSlackReplyFooterBlock(footer: SlackReplyFooter): SlackContextBlock {
  const adminUrl = buildSlackAdminUrl(footer.publicUrl, { agentId: footer.agentId });
  const configure = adminUrl ? `<${adminUrl}|Configure>` : 'Configure';
  return {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: [
          escapeSlackControlCharacters(footer.profileName),
          escapeSlackControlCharacters(footer.modelLabel),
          configure,
        ].join(' | '),
      },
    ],
  };
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
    url = new URL('/admin', trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  } catch {
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

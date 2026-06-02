import { readFileSync } from 'node:fs';

const REQUIRED_PR_BODY_SECTIONS = [
  '## Summary',
  '## Task Context',
  '## Scope',
  '## Maia Invariants',
  '## Validation',
  '## Docs Impact',
  '## Risk and Rollback',
  '## Reviewer Notes',
] as const;

const REQUIRED_PR_BODY_FIELDS = ['Residual risk:'] as const;

type PullRequestEvent = {
  pull_request?: {
    body?: string | null;
    user?: {
      login?: string;
      type?: string;
    } | null;
  } | null;
};

function fail(message: string): never {
  console.error(`pr:body:check failed: ${message}`);
  process.exit(1);
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function getMarkdownHeadings(markdown: string): Set<string> {
  const headings = new Set<string>();
  let inFence = false;
  let inHtmlComment = false;

  for (const line of normalizeLineEndings(markdown).split('\n')) {
    const trimmed = line.trim();

    if (inHtmlComment) {
      inHtmlComment = !trimmed.includes('-->');
      continue;
    }

    if (trimmed.startsWith('<!--')) {
      inHtmlComment = !trimmed.includes('-->');
      continue;
    }

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }

    if (!inFence && trimmed.startsWith('## ')) {
      headings.add(trimmed);
    }
  }

  return headings;
}

function main(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    console.log('pr:body:check skipped: GITHUB_EVENT_PATH is not set');
    return;
  }

  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as PullRequestEvent;
  const pullRequest = event.pull_request;

  if (!pullRequest) {
    console.log('pr:body:check skipped: event is not a pull_request event');
    return;
  }

  const authorLogin = pullRequest.user?.login ?? '';
  const authorType = pullRequest.user?.type ?? '';

  if (authorType === 'Bot' || authorLogin.endsWith('[bot]')) {
    console.log(`pr:body:check skipped: bot-authored PR (${authorLogin || 'unknown bot'})`);
    return;
  }

  const body = normalizeLineEndings(pullRequest.body ?? '');

  if (!body.trim()) {
    fail('pull request body is empty; keep the agent-aware PR template sections');
  }

  const headings = getMarkdownHeadings(body);

  for (const section of REQUIRED_PR_BODY_SECTIONS) {
    if (!headings.has(section)) {
      fail(`pull request body must include section: ${section}`);
    }
  }

  for (const field of REQUIRED_PR_BODY_FIELDS) {
    if (!body.includes(field)) {
      fail(`pull request body must include field: ${field}`);
    }
  }

  console.log('pr:body:check passed');
}

main();

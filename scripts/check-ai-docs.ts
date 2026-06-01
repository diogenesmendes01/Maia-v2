import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

const REQUIRED_FILES = [
  'AGENTS.md',
  '.github/pull_request_template.md',
  'docs/ai/agent-operating-model.md',
  'docs/ai/coding-agent-playbook.md',
  'docs/ai/review-agent-playbook.md',
  'docs/ai/task-spec-template.md',
  'docs/ai/architecture-decision-template.md',
  'docs/ai/maia-invariants-checklist.md',
  'docs/architecture/decisions/0001-ai-engineering-operating-model.md',
] as const;

const REQUIRED_AGENTS_REFERENCES = [
  'docs/ai/agent-operating-model.md',
  'docs/ai/coding-agent-playbook.md',
  'docs/ai/review-agent-playbook.md',
  'docs/ai/task-spec-template.md',
  'docs/ai/maia-invariants-checklist.md',
  'docs/architecture/decisions/',
] as const;

const REQUIRED_PR_TEMPLATE_REFERENCES = [
  'docs/ai/maia-invariants-checklist.md',
  'npm run docs:ai:check',
  'npm run typecheck',
  'npm run lint',
] as const;

const REQUIRED_PR_TEMPLATE_SECTIONS = [
  '## Summary',
  '## Task Context',
  '## Scope',
  '## Maia Invariants',
  '## Validation',
  '## Docs Impact',
  '## Risk and Rollback',
  '## Reviewer Notes',
] as const;

const REQUIRED_PR_TEMPLATE_FIELDS = ['Residual risk:'] as const;

const FORBIDDEN_ACTIVE_REFERENCES = [
  '2026-05-28-architecture-docs-design',
  'Architecture Documentation Suite for Maia v3',
] as const;

const FORBIDDEN_STRATEGY_PHRASES_IN_SUPERPOWER_SPECS = [
  'engineering-agent operating model',
  'AI Engineering Agent Operating Model',
  'agent-primary documentation',
  'Claude Code, Codex, or similar',
] as const;

function readText(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function walkMarkdownFiles(dir: string): string[] {
  const absoluteDir = join(ROOT, dir);

  if (!existsSync(absoluteDir)) {
    return [];
  }

  return readdirSync(absoluteDir).flatMap((entry) => {
    const absolutePath = join(absoluteDir, entry);
    const relativePath = relative(ROOT, absolutePath);
    const stat = statSync(absolutePath);

    if (stat.isDirectory()) {
      return walkMarkdownFiles(relativePath);
    }

    return entry.endsWith('.md') ? [relativePath] : [];
  });
}

function fail(message: string): never {
  console.error(`docs:ai:check failed: ${message}`);
  process.exit(1);
}

function assertRequiredFiles(): void {
  for (const path of REQUIRED_FILES) {
    if (!existsSync(join(ROOT, path))) {
      fail(`missing required AI engineering doc: ${path}`);
    }
  }
}

function assertAgentsPointers(): void {
  const agents = readText('AGENTS.md');

  for (const reference of REQUIRED_AGENTS_REFERENCES) {
    if (!agents.includes(reference)) {
      fail(`AGENTS.md must point agents to ${reference}`);
    }
  }
}

function assertPrTemplate(): void {
  const template = readText('.github/pull_request_template.md');

  for (const section of REQUIRED_PR_TEMPLATE_SECTIONS) {
    if (!template.includes(section)) {
      fail(`pull request template must include section: ${section}`);
    }
  }

  for (const field of REQUIRED_PR_TEMPLATE_FIELDS) {
    if (!template.includes(field)) {
      fail(`pull request template must include field: ${field}`);
    }
  }

  for (const reference of REQUIRED_PR_TEMPLATE_REFERENCES) {
    if (!template.includes(reference)) {
      fail(`pull request template must reference ${reference}`);
    }
  }
}

function assertNoForbiddenReferences(): void {
  const docsToScan = [
    'AGENTS.md',
    'ARCHITECTURE.md',
    'README.md',
    ...walkMarkdownFiles('docs'),
  ];

  for (const path of docsToScan) {
    const content = readText(path);

    for (const forbidden of FORBIDDEN_ACTIVE_REFERENCES) {
      if (path.includes(forbidden)) {
        fail(`${path} reintroduces the removed/rival AI documentation strategy file: ${forbidden}`);
      }

      if (content.includes(forbidden)) {
        fail(`${path} still references removed/rival AI documentation strategy: ${forbidden}`);
      }
    }
  }
}

function assertSuperpowerSpecsAreFeatureSpecs(): void {
  for (const path of walkMarkdownFiles('docs/superpowers/specs')) {
    const content = readText(path);

    for (const phrase of FORBIDDEN_STRATEGY_PHRASES_IN_SUPERPOWER_SPECS) {
      if (content.includes(phrase)) {
        fail(
          `${path} appears to define global engineering-agent strategy. Move that content to docs/ai/ or docs/architecture/decisions/.`,
        );
      }
    }
  }
}

function main(): void {
  assertRequiredFiles();
  assertAgentsPointers();
  assertPrTemplate();
  assertNoForbiddenReferences();
  assertSuperpowerSpecsAreFeatureSpecs();

  console.log('docs:ai:check passed');
}

main();

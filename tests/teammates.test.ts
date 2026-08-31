/**
 * Tests for teammates: lane-name sanitization, tool normalization, persona
 * matching, agent-input validation, frontmatter parsing, and JSON output
 * extraction. Worktree creation and subprocess spawning stay glue.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  extractFinalOutput,
  laneToken,
  matchPersona,
  normalizeTools,
  parseAgentInput,
  parseSimpleFrontmatter,
  personasFromDir,
  type Persona,
} from '../pi/extensions/teammates.ts';

const persona = (name: string, filePath = `${name}.md`, tools?: string[]): Persona => ({
  name,
  description: '',
  tools,
  systemPrompt: '',
  filePath,
});

describe('normalizeTools', () => {
  it('maps Claude names to pi names', () => {
    assert.deepEqual(normalizeTools(['Read', 'Grep', 'Glob', 'Bash']).tools, ['read', 'grep', 'find', 'bash']);
  });

  it('drops tools without a pi equivalent and reports them', () => {
    const result = normalizeTools(['Read', 'WebFetch', 'WebSearch', 'Task']);
    assert.deepEqual(result.tools, ['read']);
    assert.deepEqual(result.dropped, ['WebFetch', 'WebSearch', 'Task']);
  });

  it('dedupes case-insensitively', () => {
    assert.deepEqual(normalizeTools(['bash', 'Bash']).tools, ['bash']);
  });

  it('returns empty sets for an empty list', () => {
    assert.deepEqual(normalizeTools([]), { tools: [], dropped: [] });
  });
});

describe('matchPersona', () => {
  const personas = [persona('Staff Engineer', 'staff-engineer.md')];

  it('matches exact name, case-insensitive name, and filename stem', () => {
    assert.equal(matchPersona('Staff Engineer', personas)?.filePath, 'staff-engineer.md');
    assert.equal(matchPersona('staff engineer', personas)?.filePath, 'staff-engineer.md');
    assert.equal(matchPersona('staff-engineer', personas)?.filePath, 'staff-engineer.md');
    assert.equal(matchPersona('staff-engineer.md', personas)?.filePath, 'staff-engineer.md');
  });

  it('returns null on a miss', () => {
    assert.equal(matchPersona('Security Expert', personas), null);
  });
});

describe('laneToken', () => {
  it('kebab-cases and bounds teammate names', () => {
    assert.equal(laneToken('Staff Engineer'), 'staff-engineer');
    assert.equal(laneToken('  UX Expert!! '), 'ux-expert');
    assert.equal(laneToken('   '), 'teammate');
    assert.equal(laneToken('X'.repeat(80)).length, 40);
  });
});

describe('parseAgentInput', () => {
  it('accepts a valid input and applies the isolation default', () => {
    assert.deepEqual(parseAgentInput({ name: 'PR Reviewer', brief: 'review the diff' }), {
      name: 'PR Reviewer',
      brief: 'review the diff',
      isolation: 'none',
    });
  });

  it('keeps an explicit worktree isolation', () => {
    assert.deepEqual(parseAgentInput({ name: 'x', brief: 'y', isolation: 'worktree' }), {
      name: 'x',
      brief: 'y',
      isolation: 'worktree',
    });
  });

  it('rejects malformed input', () => {
    assert.equal(parseAgentInput(null), null);
    assert.equal(parseAgentInput('agent'), null);
    assert.equal(parseAgentInput({ name: 'x' }), null);
    assert.equal(parseAgentInput({ name: 'x', brief: 'y', isolation: 'worktree-fork' }), null);
  });
});

describe('parseSimpleFrontmatter', () => {
  it('splits frontmatter fields from the persona body', () => {
    const parsed = parseSimpleFrontmatter('---\nname: QA Expert\ntools: Read, Bash\n---\n\nYou own test strategy.');
    assert.equal(parsed?.fields.name, 'QA Expert');
    assert.equal(parsed?.fields.tools, 'Read, Bash');
    assert.equal(parsed?.body, 'You own test strategy.');
  });

  it('returns null without frontmatter', () => {
    assert.equal(parseSimpleFrontmatter('# no persona here'), null);
  });
});

describe('personasFromDir', () => {
  it('skips bad files and keeps good ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-teammates-'));
    try {
      writeFileSync(join(dir, 'good.md'), '---\nname: Scout\ndescription: fast recon\n---\nScout fast.');
      writeFileSync(join(dir, 'broken.md'), 'no frontmatter');
      const found = personasFromDir(dir);
      assert.equal(found.length, 1);
      assert.equal(found[0]?.name, 'Scout');
      assert.deepEqual(found[0]?.tools, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a comma-separated tools string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-teammates-'));
    try {
      writeFileSync(
        join(dir, 'reviewer.md'),
        '---\nname: PR Reviewer\ntools: Read, Grep, Glob, Bash\n---\nReview.',
      );
      const found = personasFromDir(dir);
      assert.deepEqual(found[0]?.tools, ['Read', 'Grep', 'Glob', 'Bash']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty for a missing directory', () => {
    assert.deepEqual(personasFromDir('/nonexistent/agents-dir'), []);
  });
});

describe('extractFinalOutput', () => {
  it('returns the last assistant message text', () => {
    const jsonLines = [
      '{"type":"message_end","message":{"role":"user","content":"start"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"first draft"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"final answer"}]}}',
    ].join('\n');
    assert.equal(extractFinalOutput(jsonLines), 'final answer');
  });

  it('tolerates non-JSON noise', () => {
    assert.equal(extractFinalOutput('garbage\n{"type":"message_end","message":{"role":"assistant","content":"ok"}}'), 'ok');
    assert.equal(extractFinalOutput('nothing'), '');
  });
});
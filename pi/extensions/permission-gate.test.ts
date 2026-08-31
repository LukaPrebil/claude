/**
 * Tests for permission-gate: a pure unit layer on synthetic rules, plus a
 * drift alarm - every rule in the real root settings.json must classify as
 * translated or sit on an explicit expected-skip list, so deny-list edits
 * pi cannot enforce fail here instead of silently skipping at runtime.
 */

import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  bashSegments,
  classifyRule,
  compileBashRule,
  compilePathGlob,
  loadGateConfig,
  matchBash,
  matchPath,
  type GateRule,
} from './permission-gate.ts';

const rule = (source: string): GateRule => {
  const classified = classifyRule(source);
  assert.ok(classified, `fixture must classify: ${source}`);
  const regex =
    classified.family === 'bash' ? compileBashRule(classified.pattern) : compilePathGlob(classified.pattern);
  return { ...classified, source, regex };
};

describe('classifyRule', () => {
  it('binds Read rules to path-read', () => {
    assert.deepEqual(classifyRule('Read(**/.env)'), { family: 'path-read', pattern: '**/.env' });
  });

  it('binds Edit and Write rules to the superset path-write family', () => {
    assert.equal(classifyRule('Edit(~/.ssh/**)')?.family, 'path-write');
    assert.equal(classifyRule('Write(**/credentials.json)')?.family, 'path-write');
  });

  it('binds Bash rules to bash', () => {
    assert.deepEqual(classifyRule('Bash(sudo *)'), { family: 'bash', pattern: 'sudo *' });
  });

  it('leaves MCP wildcards unclassified', () => {
    assert.equal(classifyRule('mcp__claude_ai_Atlassian__*'), undefined);
  });
});

describe('compilePathGlob', () => {
  it('spans segments with **/', () => {
    const re = compilePathGlob('**/.env');
    assert.ok(re.test('/Users/x/proj/.env'));
    assert.ok(re.test('/.env'));
    assert.ok(!re.test('/Users/x/proj/env'));
  });

  it('keeps * inside one segment', () => {
    const re = compilePathGlob('**/*.pem');
    assert.ok(re.test('/Users/x/a/b/key.pem'));
    assert.ok(!re.test('/Users/x/a/b/keypem'));
  });

  it('expands ~ to the real home directory', () => {
    const re = compilePathGlob('~/.ssh/**');
    assert.ok(re.test(join(homedir(), '.ssh', 'id_ed25519')));
  });

  it('matches the directory itself for a trailing **', () => {
    const re = compilePathGlob('~/.aws/**');
    assert.ok(re.test(join(homedir(), '.aws')));
    assert.ok(!re.test(join(homedir(), '.awsx')));
  });

  it('treats literal dots literally', () => {
    const re = compilePathGlob('**/.env.local');
    assert.ok(re.test('/x/.env.local'));
    assert.ok(!re.test('/x/.envXlocal'));
  });
});

describe('matchPath', () => {
  const rules = [
    rule('Read(**/.env)'),
    rule('Read(~/.ssh/**)'),
    rule('Edit(~/.gitconfig)'),
    rule('Read(**/*-key.json)'),
  ];

  it('blocks env files for reads anywhere', () => {
    const hit = matchPath('/Users/x/proj', '/Users/x/proj/backend/.env', rules);
    assert.equal(hit?.pattern, '**/.env');
  });

  it('blocks ssh material under the expanded home', () => {
    const hit = matchPath('/Users/x/proj', join(homedir(), '.ssh', 'known_hosts'), rules);
    assert.equal(hit?.source, 'Read(~/.ssh/**)');
  });

  it('resolves relative tool paths against cwd', () => {
    const hit = matchPath('/Users/x/proj/app', '.env', rules);
    assert.equal(hit?.pattern, '**/.env');
  });

  it('matches tilde spellings passed verbatim by the model', () => {
    assert.equal(matchPath('/tmp', '~/.ssh/id_ed25519', rules)?.pattern, '~/.ssh/**');
  });

  it('binds Edit rules to write-family matching, not read', () => {
    const gitconfig = join(homedir(), '.gitconfig');
    assert.equal(matchPath('/tmp', gitconfig, rules.filter((r) => r.family === 'path-write'))?.pattern, '~/.gitconfig');
    assert.equal(matchPath('/tmp', gitconfig, rules.filter((r) => r.family === 'path-read')), null);
  });

  it('does not block .env.example', () => {
    assert.equal(matchPath('/Users/x/proj', '/Users/x/proj/.env.example', rules), null);
  });

  it('does not block unrelated paths', () => {
    assert.equal(matchPath('/Users/x/proj', '/Users/x/proj/src/index.ts', rules), null);
  });
});

describe('bashSegments', () => {
  it('splits on chains, semicolons, pipes, and newlines', () => {
    assert.deepEqual(bashSegments('cd /tmp && sudo rm -rf x'), ['cd /tmp', 'sudo rm -rf x']);
    assert.deepEqual(
      bashSegments('echo a; echo b | echo c\necho d || echo e'),
      ['echo a', 'echo b', 'echo c', 'echo d', 'echo e'],
    );
    assert.deepEqual(bashSegments('   '), []);
  });
});

describe('compileBashRule', () => {
  it('anchors non-leading-star patterns at the start', () => {
    assert.ok(compileBashRule('dd *').test('dd if=/dev/zero of=x'));
    assert.ok(!compileBashRule('dd *').test('echo dd x'));
  });

  it('searches anywhere for leading-star patterns', () => {
    assert.ok(compileBashRule('*DROP TABLE*').test('echo DROP TABLE'));
  });
});

describe('matchBash', () => {
  const rules = [
    rule('Bash(sudo *)'),
    rule('Bash(git push --force *)'),
    rule('Bash(*DROP TABLE*)'),
    rule('Bash(*TRUNCATE TABLE*)'),
    rule('Bash(chmod * ~/.ssh/*)'),
  ];

  it('catches chained sudo a whole-string prefix match would miss', () => {
    assert.equal(matchBash('cd /tmp && sudo rm -rf x', rules)?.pattern, 'sudo *');
  });

  it('matches mid-string wildcards from any segment', () => {
    assert.equal(matchBash('psql -c "DROP TABLE users"', rules)?.pattern, '*DROP TABLE*');
    assert.equal(matchBash('echo start; TRUNCATE TABLE t', rules)?.pattern, '*TRUNCATE TABLE*');
  });

  it('anchors prefix patterns at segment starts, not mid-word', () => {
    assert.equal(matchBash('echo "sudo is a command"', rules), null);
    assert.equal(matchBash('sudois a word', rules), null);
  });

  it('matches force pushes anywhere in a chain', () => {
    const hit = matchBash('git add -A && git commit -m x && git push --force origin main', rules);
    assert.equal(hit?.pattern, 'git push --force *');
  });

  it('matches chmod on ssh material in both tilde spellings', () => {
    assert.equal(matchBash('chmod 600 ~/.ssh/id', rules)?.pattern, 'chmod * ~/.ssh/*');
    assert.equal(matchBash(`chmod 600 ${homedir()}/.ssh/id`, rules)?.pattern, 'chmod * ~/.ssh/*');
  });

  it('does not match unrelated commands', () => {
    assert.equal(matchBash('ls -la', rules), null);
  });
});

describe('loadGateConfig (drift alarm)', () => {
  const settingsPath = resolve(import.meta.dirname, '../../settings.json');

  it('translates every deny rule in the real settings.json or lists it as expected skip', () => {
    const expectedSkips = ['mcp__claude_ai_Atlassian__*'];
    const config = loadGateConfig(settingsPath);
    if (config.status !== 'ok') {
      assert.fail(`gate must load the tracked permission source: ${config.reason}`);
    }
    const deny = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { permissions: { deny: string[] } })
      .permissions.deny;
    const translated = new Set(config.rules.map((r) => r.source));
    const unexpected = deny.filter((source) => !translated.has(source) && !expectedSkips.includes(source));
    assert.deepEqual(unexpected, [], 'deny rules pi cannot translate; extend the gate or the expected-skip list');
    assert.equal(config.skipped.length, expectedSkips.length);
    assert.ok(config.rules.length > 100, 'sanity: the deny list must translate in bulk');
    assert.equal(config.allowCount, 4);
  });

  it('reports missing and broken sources without throwing', () => {
    assert.equal(loadGateConfig('/nonexistent/settings.json').status, 'missing');
    assert.equal(loadGateConfig(join(import.meta.dirname, 'permission-gate.test.ts')).status, 'error');
  });

  it('treats a permissions block without a deny list as empty', () => {
    const fixturePath = join(tmpdir(), 'permission-gate-fixture-empty.json');
    writeFileSync(fixturePath, JSON.stringify({ permissions: { allow: ['Read(**/x)'] } }));
    try {
      assert.equal(loadGateConfig(fixturePath).status, 'empty');
    } finally {
      rmSync(fixturePath);
    }
  });
});
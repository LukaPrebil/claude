/**
 * teammates - pi's lane-mode parity for the shared skills' Agent contract.
 *
 * Registers one tool, `agent`, matching the compat notation `Agent(...)`:
 * a persona (from the shared agents/ tree via pi's agent discovery), a
 * self-contained brief, and workload isolation. With
 * isolation: "worktree" the tool mechanically creates
 * <repo>/.claude/worktrees/<teammate-name> on branch lane/<teammate-name>,
 * spawns a `pi --mode json -p --no-session` subprocess with cwd set there,
 * and returns {worktreePath, branch} for the existing worktree-merge and
 * worktree-prune flows. Parallel agent calls are parallel lanes; each result
 * is the lane's completion. Panel mode (SendMessage peer relay) is a
 * separate, later slice.
 *
 * Persona tools arrive as Claude-named names in agents/*.md (Read, Grep,
 * Glob, Bash). The adapter normalizes them to pi's vocabulary; unknown names
 * are dropped and reported in the spawn result, applying the compatibility-
 * notation doctrine to tool names. Writers carry no tools key and keep all
 * pi tools.
 *
 * Lanes cap at 5 concurrent spawns (rules/parallel-agents.md ceiling).
 * Module top imports only node builtins so `node --test` can exercise the
 * pure helpers without resolving pi packages; the factory resolves
 * @earendil-works/pi-coding-agent dynamically at runtime.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Pure helpers: tool normalization, persona matching, lane naming
// ---------------------------------------------------------------------------

/** Claude tool name to pi tool name. Unknown names yield undefined (dropped). */
export const CLAUDE_TO_PI_TOOLS: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'edit',
  bash: 'bash',
  grep: 'grep',
  glob: 'find',
  ls: 'ls',
  find: 'find',
};

export interface PersonaTools {
  tools: string[];
  dropped: string[];
}

/** Normalize a persona's Claude-named tool list to pi names; unknowns are dropped. */
export function normalizeTools(claudeTools: string[]): PersonaTools {
  const tools: string[] = [];
  const dropped: string[] = [];
  for (const raw of claudeTools) {
    const mapped = CLAUDE_TO_PI_TOOLS[raw.trim().toLowerCase()];
    if (mapped === undefined) {
      dropped.push(raw);
      continue;
    }
    if (!tools.includes(mapped)) tools.push(mapped);
  }
  return { tools, dropped };
}

export interface Persona {
  name: string;
  description: string;
  tools?: string[];
  systemPrompt: string;
  filePath: string;
}

/** Match a persona by exact name, case-insensitive name, or filename stem. */
export function matchPersona(name: string, personas: Persona[]): Persona | null {
  const query = name.trim().toLowerCase();
  const stem = query.endsWith('.md') ? query.slice(0, -3) : query;
  for (const persona of personas) {
    if (persona.name.toLowerCase() === query) return persona;
    if (basename(persona.filePath).replace(/\.md$/, '').toLowerCase() === stem) return persona;
  }
  return null;
}

/** Sanitize a teammate name into a worktree/branch-safe kebab token. */
export function laneToken(name: string): string {
  const token = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return token.length > 0 ? token : 'teammate';
}

/** Concurrent-lane ceiling from rules/parallel-agents.md ("target 4, ceiling 5"). */
export const MAX_CONCURRENT_LANES = 5;

/** Cap gathered child output per stream; a runaway lane must not eat memory. */
export const MAX_CHILD_OUTPUT = 16 * 1024 * 1024;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse the minimal YAML this adapter needs: `key: value` lines. */
export function parseSimpleFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const match = FRONTMATTER_RE.exec(text);
  if (match === null) return null;
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? '').split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return { fields, body: (match[2] ?? '').trim() };
}

/** Discover personas in one agents dir; a single bad file never fails discovery. */
export function personasFromDir(agentsDir: string): Persona[] {
  const personas: Persona[] = [];
  if (!existsSync(agentsDir)) return personas;
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return personas;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const filePath = join(agentsDir, entry);
    try {
      const parsed = parseSimpleFrontmatter(readFileSync(filePath, 'utf8'));
      if (parsed === null || parsed.fields.name === undefined) continue;
      const { fields, body } = parsed;
      personas.push({
        name: fields.name,
        description: fields.description ?? '',
        tools:
          fields.tools !== undefined
            ? fields.tools.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0)
            : undefined,
        systemPrompt: body,
        filePath,
      });
    } catch {
      // skip unreadable persona file
    }
  }
  return personas;
}

/** Last assistant text out of pi's JSON-mode stdout. */
export function extractFinalOutput(jsonStdout: string): string {
  const lines = jsonStdout.split('\n').filter((line) => line.trim().startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i] ?? '') as {
        type?: string;
        message?: { role?: string; content?: unknown };
      };
      if (event.type !== 'message_end' || event.message?.role !== 'assistant') continue;
      const content = event.message.content;
      if (typeof content === 'string') return content.trim();
      if (Array.isArray(content)) {
        return content
          .map((part) => (typeof part === 'object' && part !== null && (part as { text?: string }).text) || '')
          .join('')
          .trim();
      }
    } catch {
      // trailing non-JSON output: keep scanning older lines
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Spawn engine
// ---------------------------------------------------------------------------

export interface SpawnOutcome {
  exitCode: number;
  output: string;
  stderr: string;
}

interface LaneSpawnOptions {
  brief: string;
  cwd: string;
  tools: string[] | undefined;
  systemPrompt: string;
  signal?: AbortSignal;
}

/** Run `pi --mode json -p --no-session` in the lane cwd; never throws. */
export function runLaneSubprocess(options: LaneSpawnOptions): Promise<SpawnOutcome> {
  return new Promise((resolveSpawn) => {
    const args = ['--mode', 'json', '-p', '--no-session'];
    if (options.tools !== undefined && options.tools.length > 0) {
      args.push('--tools', options.tools.join(','));
    }
    let promptDir: string | undefined;
    if (options.systemPrompt.trim().length > 0) {
      promptDir = mkdtempSync(join(tmpdir(), 'pi-teammate-'));
      writeFileSync(join(promptDir, 'persona.md'), options.systemPrompt);
      args.push('--append-system-prompt', join(promptDir, 'persona.md'));
    }
    args.push(options.brief);

    // stdin is ignored: the spawned pi must never wait on an open pipe for
    // input that will never come (same stdio contract as the subagent example).
    const child = spawn('pi', args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (promptDir !== undefined) rmSync(promptDir, { recursive: true, force: true });
      resolveSpawn({ exitCode, output: stdout, stderr });
    };
    const timer = setTimeout(() => {
      child.kill();
    }, 900_000);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CHILD_OUTPUT) stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CHILD_OUTPUT) stderr += String(chunk);
    });
    child.on('error', (err) => {
      stderr = `${stderr}\n${err.message}`.trim();
      settle(1);
    });
    child.on('close', (code) => {
      settle(code ?? 1);
    });
    options.signal?.addEventListener('abort', () => {
      child.kill();
    });
  });
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export function laneWorktree(cwd: string, token: string): { worktreePath: string; branch: string; baseSha: string } {
  const worktreePath = resolve(join(cwd, '.claude', 'worktrees', token));
  const branch = `lane/${token}`;
  if (existsSync(worktreePath)) {
    throw new Error(`lane worktree already exists: ${worktreePath}`);
  }
  let branchExists = false;
  try {
    execFileSync('git', ['-C', cwd, 'rev-parse', '--verify', `refs/heads/${branch}`], { stdio: 'ignore' });
    branchExists = true;
  } catch {
    branchExists = false;
  }
  if (branchExists) {
    throw new Error(`lane branch already exists: ${branch}`);
  }
  const baseSha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync(dirname(worktreePath), { recursive: true });
  execFileSync('git', ['-C', cwd, 'worktree', 'add', '-b', branch, worktreePath], { timeout: 30_000, stdio: 'ignore' });
  return { worktreePath, branch, baseSha };
}

export function laneHasCommits(worktreePath: string, baseSha: string): boolean {
  try {
    return execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== baseSha;
  } catch {
    return true; // unreadable: do not destroy work we cannot inspect
  }
}

/** Remove a lane worktree whose subprocess never produced committed work. */
export function rollbackLane(cwd: string, worktreePath: string, branch: string | undefined): void {
  try {
    execFileSync('git', ['-C', cwd, 'worktree', 'remove', '--force', worktreePath], { timeout: 30_000, stdio: 'ignore' });
  } catch {
    // best effort; leave the residue for worktree-prune rather than failing the tool
  }
  if (branch === undefined) return;
  try {
    execFileSync('git', ['-C', cwd, 'branch', '-D', branch], { timeout: 30_000, stdio: 'ignore' });
  } catch {
    // branch already gone or still referenced: harmless residue
  }
}


/** Validated boundary for dynamic-import tool params; null when malformed. */
export function parseAgentInput(
  params: unknown,
): { name: string; brief: string; isolation: 'none' | 'worktree' } | null {
  if (typeof params !== 'object' || params === null) return null;
  const record = params as Record<string, unknown>;
  const name = record.name;
  const brief = record.brief;
  const rawIsolation = record.isolation;
  if (typeof name !== 'string' || typeof brief !== 'string') return null;
  const isolation = rawIsolation === undefined ? 'none' : rawIsolation;
  if (isolation !== 'none' && isolation !== 'worktree') return null;
  return { name, brief, isolation };
}

export default async function (pi: ExtensionAPI) {
  const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
  const { Type, StringEnum } = await import('@earendil-works/pi-ai');

  type AgentToolDefinition = Parameters<ExtensionAPI['registerTool']>[0];

  let activeLanes = 0;

  const tool: AgentToolDefinition = {
    name: 'agent',
    label: 'Teammate',
    description:
      'Spawn a lane-mode teammate: a persona-driven pi subprocess doing one self-contained task. ' +
      'Mutating lanes must use isolation: "worktree". Independent teammates launch as parallel agent calls; ' +
      "each result is that lane's completion.",
    promptSnippet: 'Spawn a lane-mode teammate (persona-driven pi subprocess, optional git worktree isolation)',
    parameters: Type.Object({
      name: Type.String({ description: 'Persona name or file stem, e.g. "Staff Engineer" or "staff-engineer"' }),
      brief: Type.String({
        description:
          'Self-contained brief: goal, exact file paths, constraints and patterns to match, and the command that verifies the work',
      }),
      isolation: StringEnum(['none', 'worktree'], {
        description: '"worktree" isolates the teammate in a git worktree on branch lane/<name>; required for mutating work',
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = parseAgentInput(params);
      if (input === null) {
        return {
          content: [{ type: 'text', text: 'agent requires name (string), brief (string), and isolation "none" or "worktree".' }],
          isError: true,
          details: {},
        };
      }
      if (activeLanes >= MAX_CONCURRENT_LANES) {
        return {
          content: [{ type: 'text', text: `Lane cap (${MAX_CONCURRENT_LANES}) reached; wait for an in-flight lane to finish.` }],
          isError: true,
          details: {},
        };
      }

      const personas = [...personasFromDir(join(getAgentDir(), 'agents'))];
      if (ctx.isProjectTrusted()) {
        personas.push(...personasFromDir(join(ctx.cwd, '.pi', 'agents')));
      }
      const persona = matchPersona(input.name, personas);
      if (persona === null) {
        const available = personas.map((p) => `${p.name} (${basename(p.filePath)})`).join(', ') || 'none discovered';
        return {
          content: [{ type: 'text', text: `Unknown teammate "${input.name}". Available personas: ${available}.` }],
          isError: true,
          details: {},
        };
      }

      let worktreePath: string | undefined;
      let branch: string | undefined;
      let baseSha = '';
      if (input.isolation === 'worktree') {
        try {
          const lane = laneWorktree(ctx.cwd, laneToken(persona.name));
          worktreePath = lane.worktreePath;
          branch = lane.branch;
          baseSha = lane.baseSha;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `Could not create lane worktree: ${message}` }],
            isError: true,
            details: {},
          };
        }
      }

      const normalized = persona.tools !== undefined ? normalizeTools(persona.tools) : undefined;

      activeLanes += 1;
      let outcome: SpawnOutcome;
      try {
        outcome = await runLaneSubprocess({
          brief: input.brief,
          cwd: worktreePath ?? ctx.cwd,
          tools: normalized?.tools,
          systemPrompt: persona.systemPrompt,
          signal,
        });
      } finally {
        activeLanes -= 1;
      }

      const output = extractFinalOutput(outcome.output);
      const workIsEmpty = worktreePath !== undefined && !laneHasCommits(worktreePath, baseSha);
      if (workIsEmpty && outcome.exitCode !== 0 && worktreePath !== undefined) {
        rollbackLane(ctx.cwd, worktreePath, branch);
        worktreePath = undefined;
        branch = undefined;
      }

      if (output.length === 0 && outcome.exitCode !== 0) {
        return {
          content: [
            {
              type: 'text',
              text: `Teammate "${persona.name}" failed (exit ${outcome.exitCode}).\n${outcome.stderr.slice(-400)}`,
            },
          ],
          isError: true,
          details: { persona: persona.name, worktreePath, branch, exitCode: outcome.exitCode },
        };
      }

      const location =
        worktreePath === undefined
          ? ''
          : `Worktree: ${worktreePath}\nBranch: ${branch}\nReview the diff, merge the branch, then let worktree-prune sweep it.\n\n`;
      const droppedNote =
        normalized !== undefined && normalized.dropped.length > 0
          ? `\n(no pi equivalent for tools: ${normalized.dropped.join(', ')})`
          : '';
      return {
        content: [{ type: 'text', text: `${location}${output.length > 0 ? output : '(no output)'}${droppedNote}` }],
        details: { persona: persona.name, worktreePath, branch, exitCode: outcome.exitCode, dropped: normalized?.dropped ?? [] },
      };
    },
  };

  pi.registerTool(tool);
}

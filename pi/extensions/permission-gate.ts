/**
 * permission-gate - pi's mechanical enforcement of the harness deny list.
 *
 * Translates the permissions block of the tracked root settings.json into
 * tool_call gates at runtime (see CONTEXT.md: "Deny list", "Permission gate"):
 *
 *   Read(...)  -> pi read
 *   Edit(...)  -> pi edit AND write (superset: creating a secret is worse
 *                 than editing one)
 *   Bash(...)  -> model-invoked bash; the user's own `!` commands stay ungated
 *   MCP rules  -> no pi translation; surfaced in a skip notice, never applied
 *
 * Allow rules are inert: the deny list enumerates secret files explicitly
 * (.env.example matches no deny pattern), and Claude's real precedence is
 * deny-wins, so there is no allow-override semantics to reproduce.
 *
 * Bash patterns match the whole command and every segment split on &&, ||,
 * `;`, `|`, and newlines, so chaining cannot slip past a prefix pattern.
 * Deliberate obfuscation still wins: per pi's security.md this gate is
 * friction, not a security boundary. Real isolation needs an OS boundary.
 *
 * Fail loud: a missing, empty, or unparseable permission source leaves the
 * gate UNGATED and says so on every session start - error notify plus a
 * persistent widget in TUI, one console.error line in headless modes.
 *
 * Module top imports only node builtins so `node --test` can exercise the
 * pure helpers without resolving pi packages; the factory resolves
 * @earendil-works/pi-coding-agent dynamically at runtime.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Pure rule engine
// ---------------------------------------------------------------------------

export type RuleFamily = 'path-read' | 'path-write' | 'bash';

export interface GateRule {
  family: RuleFamily;
  /** Pattern inside the Claude rule, i.e. a path glob or a command prefix. */
  pattern: string;
  /** Full source rule as written in the deny list, e.g. a Read rule for .env. */
  source: string;
  regex: RegExp;
}

export type GateConfig =
  | { status: 'ok'; rules: GateRule[]; skipped: string[]; allowCount: number }
  | { status: 'missing'; reason: string }
  | { status: 'empty'; reason: string }
  | { status: 'error'; reason: string };

/** Structural subset of the pi context the gate touches (keeps helpers testable). */
interface GateUiContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level: 'info' | 'warning' | 'error'): void;
    setWidget(id: string, widget: string[] | undefined): void;
  };
}

const RULE_RE = /^(Read|Edit|Write|Bash)\((.*)\)$/s;

/** Classify one Claude permission rule; undefined when pi cannot enforce it. */
export function classifyRule(source: string): { family: RuleFamily; pattern: string } | undefined {
  const match = RULE_RE.exec(source.trim());
  if (match === null) return undefined;
  const verb = match[1];
  const pattern = match[2];
  if (verb === 'Bash') return { family: 'bash', pattern };
  if (verb === 'Read') return { family: 'path-read', pattern };
  // Edit and Write both bind edit+write: file-tool rules enforce a superset.
  if (verb === 'Edit' || verb === 'Write') return { family: 'path-write', pattern };
  return undefined;
}

function escapeRegexChar(char: string): string {
  return /[.+^${}()|[\]\\?]/.test(char) ? `\\${char}` : char;
}

/**
 * Compile a path glob. A tilde expands to home; a double-star may match zero
 * or more segments; a trailing double-star matches the directory itself plus
 * everything under it; a bare star stays inside one segment.
 */
export function compilePathGlob(pattern: string): RegExp {
  let glob = pattern;
  if (glob.startsWith('~')) glob = homedir() + glob.slice(1);
  // A trailing '/**' also matches the directory itself: drop the marker slash
  // and append an optional descendant arm after tokenizing the rest.
  const matchesDirItself = glob.endsWith('/**');
  if (matchesDirItself) glob = glob.slice(0, -3);
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char !== '*') {
      source += escapeRegexChar(char);
      continue;
    }
    if (glob.charAt(i + 1) === '*') {
      i++;
      if (glob.charAt(i + 1) === '/') {
        i++;
        source += '(?:.*/)?';
      } else {
        // Trailing ** must also match the directory itself.
        source += i + 1 < glob.length ? '.*' : '(?:/.*)?';
      }
    } else {
      source += '[^/]*';
    }
  }
  if (matchesDirItself) source += '(?:/.*)?';
  return new RegExp(`^${source}$`);
}

/**
 * Compile a bash pattern. A leading `*` searches anywhere; otherwise the
 * pattern anchors at a segment start. `~` inside the pattern compiles twice
 * (literal and home-expanded), because the model types both spellings.
 */
export function compileBashRule(pattern: string): RegExp {
  const compile = (body: string): RegExp => {
    const source = body.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(body.startsWith('*') ? source : `^${source}`);
  };
  if (pattern.includes('~')) {
    const expanded = pattern.replaceAll('~', homedir());
    // Match either spelling: build one alternation over both bodies.
    const bodies = [pattern, expanded].map((body) => {
      const source = body.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replaceAll('*', '.*');
      return body.startsWith('*') ? source : `(?:^${source})`;
    });
    return new RegExp(bodies.join('|'));
  }
  return compile(pattern);
}

export function rulesForFamily(config: { rules: GateRule[] }, family: RuleFamily): GateRule[] {
  return config.rules.filter((rule) => rule.family === family);
}

/** Expand a leading `~` and resolve a tool path against cwd for matching. */
export function resolveToolPath(cwd: string, rawPath: string): string {
  let candidate = rawPath.trim();
  if (candidate === '~') candidate = homedir();
  else if (candidate.startsWith('~/')) candidate = join(homedir(), candidate.slice(2));
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

/** First rule whose compiled regex matches the resolved path, or null. */
export function matchPath(cwd: string, rawPath: string, rules: GateRule[]): GateRule | null {
  const absolute = resolveToolPath(cwd, rawPath);
  for (const rule of rules) {
    if (rule.regex.test(absolute)) return rule;
  }
  return null; // no deny rule covers this path
}

/** Split a command into executable segments (`&&`, `||`, `;`, `|`, newlines). */
export function bashSegments(command: string): string[] {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** First bash rule matching the whole command or any segment, or null. */
export function matchBash(command: string, rules: GateRule[]): GateRule | null {
  const targets = [command, ...bashSegments(command)];
  for (const rule of rules) {
    for (const target of targets) {
      if (rule.regex.test(target)) return rule;
    }
  }
  return null;
}

/** Load and translate the permissions block; never throws. */
export function loadGateConfig(settingsPath: string): GateConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing', reason: `permission source not found: ${settingsPath}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'error', reason: `permission source unreadable: ${message}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 'empty', reason: 'permission source is not an object' };
  }
  const permissions = (parsed as { permissions?: unknown }).permissions;
  if (typeof permissions !== 'object' || permissions === null) {
    return { status: 'empty', reason: 'no permissions block' };
  }
  const deny = (permissions as { deny?: unknown }).deny;
  if (!Array.isArray(deny) || deny.length === 0) {
    return { status: 'empty', reason: 'deny list absent or empty' };
  }
  const allow = (permissions as { allow?: unknown }).allow;
  const allowCount = Array.isArray(allow) ? allow.length : 0;

  const rules: GateRule[] = [];
  const skipped: string[] = [];
  for (const source of deny) {
    if (typeof source !== 'string') {
      skipped.push(String(source));
      continue;
    }
    const classified = classifyRule(source);
    if (classified === undefined) {
      skipped.push(source);
      continue;
    }
    const regex =
      classified.family === 'bash' ? compileBashRule(classified.pattern) : compilePathGlob(classified.pattern);
    rules.push({ ...classified, source, regex });
  }
  if (rules.length === 0) {
    return { status: 'empty', reason: 'deny list translates to zero pi rules' };
  }
  return { status: 'ok', rules, skipped, allowCount };
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const WIDGET_ID = 'permission-gate';

function gateBlockReason(hit: GateRule): string {
  return `Blocked by permission-gate: ${hit.source} from the harness deny list. Stop touching this path or command and pick a different approach.`;
}

export default async function (pi: ExtensionAPI) {
  const { getAgentDir, isToolCallEventType } = await import('@earendil-works/pi-coding-agent');

  let gates: Extract<GateConfig, { status: 'ok' }> | undefined;

  pi.on('session_start', (_event, ctx) => {
    const moduleSettings = join(dirname(fileURLToPath(import.meta.url)), '../../settings.json');
    const candidates = [moduleSettings, join(getAgentDir(), 'settings.json')];

    let config: Extract<GateConfig, { status: 'ok' }> | undefined;
    let loadedFrom: string | undefined;
    let ungatedReason = 'no permission source found';
    for (const candidate of candidates) {
      const loaded = loadGateConfig(candidate);
      if (loaded.status === 'ok') {
        config = loaded;
        loadedFrom = candidate;
        break;
      }
      if (loaded.status === 'missing') continue; // try the next candidate
      ungatedReason = loaded.reason;
    }

    if (config === undefined) {
      gates = undefined;
      const message = `Permission gate UNGATED (${ungatedReason}); deny list is not enforced this session.`;
      if (ctx.hasUI) {
        ctx.ui.notify(message, 'error');
        ctx.ui.setWidget(WIDGET_ID, ['perms: UNGATED - deny list not enforced']);
      } else {
        console.error(message);
      }
      return;
    }

    gates = config;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);

    const summary = [`enforcing ${config.rules.length} deny rules from ${loadedFrom}`];
    if (config.skipped.length > 0) {
      summary.push(`skipped ${config.skipped.length} (no pi translation): ${config.skipped.join(', ')}`);
    }
    if (config.allowCount > 0) {
      summary.push(`${config.allowCount} allow rules inert (deny-wins)`);
    }
    if (ctx.hasUI) ctx.ui.notify(`Permission gate: ${summary.join('; ')}`, 'info');
  });

  pi.on('tool_call', (event, ctx) => {
    if (gates === undefined) return;

    if (isToolCallEventType('bash', event)) {
      const hit = matchBash(event.input.command, rulesForFamily(gates, 'bash'));
      if (hit !== null) return { block: true, reason: gateBlockReason(hit) };
      return;
    }

    const family: RuleFamily | undefined =
      event.toolName === 'read'
        ? 'path-read'
        : event.toolName === 'write' || event.toolName === 'edit'
          ? 'path-write'
          : undefined;
    if (family === undefined) return;

    let rawPath: string | undefined;
    if (isToolCallEventType('read', event)) rawPath = event.input.path;
    else if (isToolCallEventType('write', event)) rawPath = event.input.path;
    else if (isToolCallEventType('edit', event)) rawPath = event.input.path;
    if (rawPath === undefined) return;

    const hit = matchPath(ctx.cwd, rawPath, rulesForFamily(gates, family));
    if (hit !== null) return { block: true, reason: gateBlockReason(hit) };
  });
}
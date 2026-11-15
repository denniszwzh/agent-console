type Json = Record<string, unknown>;
type Group = { matcher?: string; hooks?: Array<{ type?: string; command?: string }> };

export interface HookCmds {
  Stop: string;
  UserPromptSubmit: string;
}

/** Codex (~/.codex/hooks.json) only gets the Stop hook; delivery goes through the copy button / queue. */
export interface CodexHookCmds {
  Stop: string;
}

const EVENTS: Array<keyof HookCmds> = ['Stop', 'UserPromptSubmit'];

/** True when a hook command is one of ours: our dist script inside an agent-console path. */
function isOurs(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  const c = command.toLowerCase();
  return c.includes('agent-console') && (c.includes('claude-stop.js') || c.includes('claude-prompt.js') || c.includes('codex-stop.js'));
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Removes our entries from a group list; groups left empty by that are dropped. */
function stripOurs(groups: Group[]): Group[] {
  const out: Group[] = [];
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !isOurs(h?.command));
    if (kept.length === g.hooks.length) out.push(g);
    else if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return out;
}

export function removeHooks(settings: object): object {
  assertHooksShape(settings);
  const out = clone(settings) as Json;
  const hooks = out.hooks as Json | undefined;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const after = stripOurs(groups as Group[]);
    if (after.length === groups.length && after.every((g, i) => g === groups[i])) continue;
    if (after.length > 0) hooks[event] = after;
    else delete hooks[event];
  }
  return out;
}

/** Throws when `hooks` exists but is not a plain object. */
function assertHooksShape(settings: object): void {
  const h = (settings as Json).hooks;
  if (h !== undefined && (h === null || typeof h !== 'object' || Array.isArray(h))) {
    throw new Error('settings.json "hooks" is not an object; refusing to modify it');
  }
}

/** Throws unless every generated command is recognisable by removeHooks. */
export function assertRecognisable(hookCmds: HookCmds | CodexHookCmds): void {
  for (const c of Object.values(hookCmds)) {
    if (!isOurs(c)) {
      throw new Error(`hook command is not recognisable as agent-console's (path must contain "agent-console"): ${c}`);
    }
  }
}

export function addHooks(settings: object, hookCmds: HookCmds): object {
  return addEvents(settings, hookCmds, EVENTS);
}

/** hooks.json has the same hooks structure as Claude's settings.json. */
export function addCodexHooks(settings: object, hookCmds: CodexHookCmds): object {
  return addEvents(settings, hookCmds, ['Stop']);
}

function addEvents<K extends string>(settings: object, hookCmds: Record<K, string>, events: K[]): object {
  assertHooksShape(settings);
  // Strip first so repeated calls (and stale paths) never duplicate our entries.
  const out = removeHooks(settings) as Json;
  const hooks = (out.hooks && typeof out.hooks === 'object' ? out.hooks : {}) as Json;
  for (const event of events) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as Group[]) : [];
    groups.push({ hooks: [{ type: 'command', command: hookCmds[event] }] });
    hooks[event] = groups;
  }
  out.hooks = hooks;
  return out;
}

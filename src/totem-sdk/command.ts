/**
 * Command (`cmd`) path semantics — lifted verbatim from totem-core
 * (packages/totem-core/src/command.ts) per docs/Totem_Integration.md §5: this is
 * pure logic over plain strings with no codec/crypto dependency, so it ports to
 * the JWT substrate unchanged.
 *
 * Commands are `/`-delimited hierarchical paths. Attenuation narrows by
 * hierarchy: a parent `cmd` permits itself and any sub-path. `/` is the root
 * ("all"), forbidden in production issuance policy. Segments are strictly
 * validated (SEGMENT_RE rejects empty, `.`, `..`) so a `cmd` like
 * `/a/b/../../admin` cannot string-prefix `/a/b` and then resolve to `/admin`
 * downstream (path-escape). `commandPermits` is total: malformed input fails
 * closed (returns `false`) instead of throwing.
 */

/** A path segment: starts alphanumeric, then alphanumeric / `.` / `_` / `-`. Excludes `.`, `..`, empty. */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Normalize a command to its canonical form. Throws on malformed input (use at issuance). */
export function normalizeCommand(cmd: string): string {
  if (cmd === '/') return '/';
  if (cmd === '') throw new Error('empty command path (root must be spelled "/")');
  let c = cmd.startsWith('/') ? cmd : `/${cmd}`;
  while (c.length > 1 && c.endsWith('/')) c = c.slice(0, -1);
  // An all-slashes input (e.g. "///") collapses to "/" but is not an explicit root.
  if (c === '/') throw new Error(`malformed command path: ${JSON.stringify(cmd)}`);
  const segments = c.slice(1).split('/');
  for (const segment of segments) {
    if (!SEGMENT_RE.test(segment)) {
      throw new Error(`malformed command segment ${JSON.stringify(segment)} in ${JSON.stringify(cmd)}`);
    }
  }
  return c;
}

/** True if `cmd` is a well-formed command path. */
export function isValidCommand(cmd: string): boolean {
  try {
    normalizeCommand(cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * True if `child` is permitted by `parent` — i.e. `child` equals `parent` or is
 * a strict sub-path of it. The root `/` permits everything. Total: malformed
 * `parent` or `child` fails closed (returns `false`).
 */
export function commandPermits(parent: string, child: string): boolean {
  let p: string;
  let c: string;
  try {
    p = normalizeCommand(parent);
    c = normalizeCommand(child);
  } catch {
    return false;
  }
  if (p === '/') return true;
  if (c === p) return true;
  return c.startsWith(`${p}/`);
}

/**
 * Policy (`pol`) evaluation — lifted from totem-core
 * (packages/totem-core/src/policy.ts) per docs/Totem_Integration.md §5, adapted
 * for JSON invocation args (the DAG-CBOR `Uint8Array` value case is dropped — a
 * JWT/JSON args object never carries raw bytes).
 *
 * Predicates are evaluated against an invocation's `args` as a logical AND.
 * Selectors are dot-paths (`.sourceSystems`, `.meta.x`, `.` = whole args).
 *
 * Fail-closed: a comparison against a missing or wrong-typed value is `false`,
 * never a vacuous pass — INCLUDING the negation operators (`!=`, `not`), so a
 * deny-rule cannot be satisfied by simply omitting the field.
 */
import type { Args, PolicyValue, Predicate, Selector } from './types';

/** Keys that must never be reachable via a selector (prototype-pollution surface). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Resolve a dot-path selector into an args object. Returns `undefined` if absent. Own-properties only. */
export function resolveSelector(args: Args, selector: Selector): PolicyValue | undefined {
  if (selector === '.') return args as PolicyValue;
  if (!selector.startsWith('.')) {
    throw new Error(`selector must start with "." : ${selector}`);
  }
  const parts = selector
    .slice(1)
    .split('.')
    .filter((p) => p.length > 0);
  let current: PolicyValue | undefined = args as PolicyValue;
  for (const part of parts) {
    if (FORBIDDEN_KEYS.has(part)) return undefined;
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.hasOwn(current, part)
    ) {
      return undefined;
    }
    current = (current as Record<string, PolicyValue>)[part];
    if (current === undefined) return undefined;
  }
  return current;
}

function valuesEqual(a: PolicyValue | undefined, b: PolicyValue): boolean {
  if (a === undefined) return false;
  // JSON scalars compare by value; arrays/objects compare by reference (matching
  // totem-core's primitive `===` semantics — predicates target scalars).
  return a === b;
}

function asNumber(value: PolicyValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Glob match supporting only `*` (matches any run, including empty). Implemented
 * as a linear two-pointer scan — NOT a RegExp — so it cannot suffer catastrophic
 * backtracking (ReDoS) on adversarial inputs.
 */
export function globMatch(text: string, glob: string): boolean {
  let t = 0;
  let g = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === text[t]) {
      t++;
      g++;
    } else if (g < glob.length && glob[g] === '*') {
      star = g;
      mark = t;
      g++;
    } else if (star !== -1) {
      g = star + 1;
      mark++;
      t = mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

/** The selector of a leaf comparison predicate, or `null` for boolean combinators. */
function leafSelector(predicate: Predicate): Selector | null {
  switch (predicate[0]) {
    case '==':
    case '!=':
    case '<=':
    case '<':
    case '>=':
    case '>':
    case 'in':
    case 'like':
      return predicate[1];
    default:
      return null;
  }
}

/** Evaluate a single predicate against args. */
export function evaluatePredicate(predicate: Predicate, args: Args): boolean {
  switch (predicate[0]) {
    case '==':
      return valuesEqual(resolveSelector(args, predicate[1]), predicate[2]);
    case '!=': {
      // Fail closed: an absent selector does NOT satisfy a deny-rule.
      const v = resolveSelector(args, predicate[1]);
      return v !== undefined && !valuesEqual(v, predicate[2]);
    }
    case '<=': {
      const n = asNumber(resolveSelector(args, predicate[1]));
      return n !== undefined && n <= predicate[2];
    }
    case '<': {
      const n = asNumber(resolveSelector(args, predicate[1]));
      return n !== undefined && n < predicate[2];
    }
    case '>=': {
      const n = asNumber(resolveSelector(args, predicate[1]));
      return n !== undefined && n >= predicate[2];
    }
    case '>': {
      const n = asNumber(resolveSelector(args, predicate[1]));
      return n !== undefined && n > predicate[2];
    }
    case 'in': {
      const v = resolveSelector(args, predicate[1]);
      return v !== undefined && predicate[2].some((candidate) => valuesEqual(v, candidate));
    }
    case 'like': {
      const v = resolveSelector(args, predicate[1]);
      return typeof v === 'string' && globMatch(v, predicate[2]);
    }
    case 'and':
      return predicate[1].every((p) => evaluatePredicate(p, args));
    case 'or':
      return predicate[1].some((p) => evaluatePredicate(p, args));
    case 'not': {
      // Fail closed: `not` over a leaf predicate whose selector is absent is
      // `false`, so a deny-rule expressed as not(==) can't be dodged by omission.
      const inner = predicate[1];
      const sel = leafSelector(inner);
      if (sel !== null && resolveSelector(args, sel) === undefined) return false;
      return !evaluatePredicate(inner, args);
    }
    default:
      // Exhaustiveness guard: an unknown predicate operator fails closed.
      return false;
  }
}

/**
 * Evaluate a full predicate list (AND) against args. Returns the failing
 * predicates (empty array = all satisfied).
 */
export function evaluatePolicy(policy: readonly Predicate[], args: Args): Predicate[] {
  return policy.filter((p) => !evaluatePredicate(p, args));
}

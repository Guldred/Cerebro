/**
 * Resolve the caller's principals (Entra ID groups + user id) that drive the ACL
 * filter.
 *
 * MVP: read a comma-separated `x-cerebro-principals` header. This is a stand-in.
 * PHASE 2 (plan §7): replace with validated Entra ID OIDC — verify the bearer
 * token, resolve the user's transitive group memberships, and NEVER trust a
 * client-supplied principal list. The retrieval ACL filter must run on every path
 * (REST and MCP); a request with no resolvable identity sees only public content
 * (fail-closed), never the whole corpus.
 */
export function resolvePrincipals(header?: string): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const PRINCIPALS_HEADER = 'x-cerebro-principals';

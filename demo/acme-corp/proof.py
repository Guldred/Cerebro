#!/usr/bin/env python3
"""Synthetic-company permission + retrieval proof battery for Cerebro.

Run against a Cerebro API started with the real bge-m3 + LLM brain (see run-demo.sh).
Uses dev-header auth (x-cerebro-principals) — the demo stands in validated Entra
principals verbatim; the production OIDC path is eval-gated separately.

The security claim is anchored on /search (raw chunks, no LLM): the SAME query
returns N chunks from a restricted doc for the entitled caller and 0 for everyone
else. /query layers the grounded LLM answer + citations on top.
"""
import json
import urllib.request

API = "http://localhost:3000"


def post(path, body, principal, timeout=180):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-cerebro-principals": principal},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def from_doc(principal, query, target, k=16):
    """How many of the returned chunks come from the target document (the 0-vs-N proof)."""
    r = post("/search", {"query": query, "topK": k}, principal)["results"]
    return sum(1 for x in r if x["documentId"] == target)


def proof(title, query, target, callers):
    print("-" * 80)
    print(title)
    print("-" * 80)
    for label, principal in callers:
        n = from_doc(principal, query, target)
        print(f"    {target.split(':')[-1]:<24} caller={label:<32} {n:>2}  [{'VISIBLE' if n else 'blocked'}]")
    print()


def ask(label, principal, q):
    a = post("/query", {"question": q}, principal)
    ans = (a.get("answer") or "").strip().replace("\n", " ")
    cites = [c.get("deepLink") or c.get("sourceUrl") for c in a.get("citations", [])]
    print(f"[{label}] Q: {q}")
    print(f"  A: {ans[:320]}")
    print(f"  cited: {cites if cites else '(none — abstained)'}\n")


print("=" * 80)
print("PERMISSION PROOFS  (same query, 0 vs N from the restricted document)")
print("=" * 80)
proof("A  HR salary — entitled vs not",
      "staff engineer salary bands and retention bonus pool", "confluence:ACME-SALARY-BANDS",
      [("public", "public"), ("entra-group:hr", "entra-group:hr")])
proof("B  Finance / Project Northwind — cross-team isolation",
      "approved Q3 budget for Project Northwind", "confluence:ACME-FINANCE-Q3",
      [("public", "public"), ("entra-group:hr (wrong team)", "entra-group:hr"), ("entra-group:finance", "entra-group:finance")])
proof("C  Engineering runbook (gitlab source, mapped via gitlab-project)",
      "roll back a bad deploy of the conveyor API", "gitlab:acme/platform:docs/runbook.md",
      [("public", "public"), ("entra-group:engineering", "entra-group:engineering")])
proof("D  Board doc is UNMAPPED -> invisible to EVERYONE (fail-closed)",
      "Project BlueOak acquisition price", "confluence:ACME-BOARD-STRATEGY",
      [("public", "public"), ("entra-group:finance", "entra-group:finance"), ("entra-group:board (made-up)", "entra-group:board")])
proof("E  Quarantined doc invisible EVEN to its mapped group (acl_status: failed)",
      "customer-PII export security incident", "confluence:ACME-SEC-INCIDENT",
      [("entra-group:security (IS mapped)", "entra-group:security")])

print("=" * 80)
print("GROUNDED ANSWERS  (real LLM + deep-link citations)")
print("=" * 80)
ask("entra-group:hr", "entra-group:hr", "What does Band E5 pay and how big is the retention bonus pool?")
ask("public (no HR)", "public", "What does Band E5 pay and how big is the retention bonus pool?")
ask("entra-group:finance", "entra-group:finance", "What is the approved Q3 budget for Project Northwind?")

print("=" * 80)
print("CROSS-LINGUAL  (bge-m3 multilingual embeddings)")
print("=" * 80)
# Embeddings bridge languages: an EN query ranks the DE chunks #1 by vector similarity.
r = post("/search", {"query": "how quickly must we respond to a data deletion request", "topK": 16}, "public")["results"]
de = [(i, round(x["score"], 4), x.get("vectorRank"), x.get("ftsRank")) for i, x in enumerate(r, 1) if "DATENSCHUTZ" in x["documentId"]]
print(f"EN /search -> German doc chunks (fusedPos, rrf, vectorRank, ftsRank): {de}")
print("  (vectorRank ~1-3 = cross-lingual embedding match is excellent; ftsRank None = zero")
print("   lexical overlap, so RRF under-weights it vs bilingual English chunks.)\n")
# The honest failure: EN question + (RRF-buried) DE evidence -> mistral abstains
# rather than synthesise across languages. Correct fail-safe, but not a full answer.
ask("public — EN question, DE evidence (RRF-buried)", "public",
    "How quickly must we respond to a data deletion or access request?")
# Generation is reliable when query + evidence share a language:
ask("public — DE question, DE evidence (works)", "public",
    "Wie schnell müssen wir auf einen Antrag auf Löschung oder Auskunft reagieren?")

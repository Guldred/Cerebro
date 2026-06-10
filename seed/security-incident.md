---
source_system: confluence
external_id: SEC-INCIDENT-2026
source_url: https://confluence.example.com/display/SEC/Incident+Postmortem+April+2026
title: Security Incident Postmortem April 2026
breadcrumb: Security > Incidents > April 2026 Postmortem
author: Riley Chen
content_type: text/markdown
lang: en
acl_principals: ["confluence-group:security-team"]
# Simulates a permission-resolution failure at the source: ingestion QUARANTINES
# this document — content stored, zero principals, invisible to EVERY caller
# (even one holding the mapped group) until resolution succeeds. Exercises the
# fail-closed quarantine path end-to-end through the real SQL filter.
acl_status: failed
created_at: 2026-04-12T08:00:00Z
updated_at: 2026-04-20T16:00:00Z
---

# Security Incident Postmortem — April 2026

## Summary

On 12 April 2026 a CI runner token with excessive scopes was exfiltrated via a
compromised third-party action. The attacker pivoted to the artifact registry
and attempted lateral movement toward the deployment credentials.

## Impact

Build artifacts for two internal services were exposed for roughly six hours.
No customer data was accessed. The deployment credential rotation completed
before any misuse was observed.

## Root cause

The runner token was provisioned with org-wide read scope instead of
repo-scoped access, violating the least-privilege provisioning runbook.

## Remediation

All runner tokens were rotated and re-scoped, the third-party action was
pinned to a reviewed SHA, and scope linting was added to the provisioning
pipeline.

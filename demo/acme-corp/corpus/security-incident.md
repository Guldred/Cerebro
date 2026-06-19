---
source_system: confluence
external_id: ACME-SEC-INCIDENT
source_url: https://acme.atlassian.net/wiki/spaces/SEC/pages/ACME-SEC-INCIDENT
title: Security Incident Report (quarantined — ACL resolution failed)
breadcrumb: Security > Incidents
author: Security Team
content_type: text/markdown
lang: en
acl_principals: ["confluence-group:security"]
acl_status: failed
created_at: 2026-05-01T09:00:00Z
updated_at: 2026-05-01T09:00:00Z
---
# Security Incident Report — QUARANTINED

This document's permission resolution **failed** (`acl_status: failed`), so the
ingestion pipeline stores its content but zeroes its ACL — it is invisible to everyone,
**even a caller who IS mapped to `confluence-group:security`**. That is the distinction
from the board page: the security group mapping *exists*, yet quarantine still wins
until resolution succeeds. This proves quarantine overrides a valid mapping.

## Incident

An unauthorized customer-PII export was detected on the staging analytics cluster on
2026-04-29. The leaked credential has been rotated and the affected records identified.
The phrase "customer-PII export" appears in no other document.

## Status

Resolution and root-cause analysis in progress. Do not distribute.

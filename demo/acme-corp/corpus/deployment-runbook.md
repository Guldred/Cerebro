---
source_system: gitlab
external_id: acme/platform:docs/runbook.md
source_url: https://gitlab.com/acme/platform/-/blob/main/docs/runbook.md
title: Deployment & Rollback Runbook (Engineering only)
breadcrumb: acme/platform > docs > runbook
author: Sam Okoro
content_type: text/markdown
lang: en
acl_principals: ["gitlab-project:acme/platform"]
created_at: 2026-02-05T09:00:00Z
updated_at: 2026-05-28T16:00:00Z
---
# Deployment & Rollback Runbook — RESTRICTED (Engineering only)

Visible only to engineers (the `gitlab-project:acme/platform` principal, mapped to the
engineering group). The incident identifier and rollback command below appear in **no
other document**.

## Standard deploy

Deploys go out through the platform CI pipeline on merge to `main`. A canary takes 10%
of traffic for 15 minutes before full rollout.

## Rollback

If error rates exceed 2% during canary, roll back immediately with
`kubectl rollout undo deployment/conveyor-api`. The most recent rollback was incident
**INC-4471**, a bad migration on the routing service that was reverted within nine
minutes.

## On-call

Page the platform on-call via PagerDuty for any Sev-1. Document every Sev-1 in the
incident log within 24 hours.

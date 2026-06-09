---
source_system: gitlab
external_id: platform/runbooks/deployment
source_url: https://gitlab.example.com/platform/runbooks/-/blob/main/deployment.md
title: Deployment Runbook
breadcrumb: Platform > Runbooks > Deployment
author: Sam Lee
content_type: text/markdown
lang: en
acl_principals: [public]
created_at: 2026-03-05T10:00:00Z
updated_at: 2026-05-28T16:45:00Z
---
# Deployment Runbook

How to deploy the knowledge-layer service to production.

## Prerequisites

A green CI pipeline on the `main` branch and an approved merge request. Database
migrations must be backward compatible with the currently running version.

## Deployment Steps

Trigger the `deploy:production` pipeline job. It builds the image, runs migrations,
and performs a rolling restart. Watch the dashboard for error-rate spikes during the
rollout.

## Rollback

If the error rate exceeds two percent for more than five minutes, roll back. Re-run the
previous successful `deploy:production` job, or run `kubectl rollout undo deployment/
knowledge-layer`. Rolling back does not revert database migrations, so only backward-
compatible migrations are allowed.

## Post-Deployment

Confirm the health endpoint returns `ok` and that query latency is within the p95
target of three to five seconds.

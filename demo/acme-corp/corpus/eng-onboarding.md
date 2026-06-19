---
source_system: confluence
external_id: ACME-ENG-ONBOARDING
source_url: https://acme.atlassian.net/wiki/spaces/ENG/pages/ACME-ENG-ONBOARDING
title: Engineering Onboarding
breadcrumb: Engineering > Onboarding
author: Sam Okoro
content_type: text/markdown
lang: en
acl_principals: [public]
created_at: 2026-02-01T09:00:00Z
updated_at: 2026-05-20T11:30:00Z
---
# Engineering Onboarding

Public starting point for new engineers. Restricted runbooks (deployment, incidents)
live in the platform space and require the engineering group.

## Accounts

On day one, request access to GitLab, Confluence and the internal VPN through the
identity portal. Access is granted by your Entra ID group membership, so most tools
work automatically once you are added to the `engineering` group.

## Local setup

Install Node.js 20+ and Docker. Clone the service repository and run
`docker compose up` to start Postgres locally. Copy `.env.example` to `.env`; the
defaults connect to the local database and need no external keys.

## Where to go next

The deployment runbook and incident procedures are in the platform space and are
visible only to the engineering team. Ask your lead to confirm your group membership
if you cannot see them.

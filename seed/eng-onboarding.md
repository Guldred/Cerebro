---
source_system: confluence
external_id: ENG-ONBOARDING
source_url: https://confluence.example.com/display/ENG/Engineering+Onboarding
title: Engineering Onboarding
breadcrumb: Engineering > Onboarding
author: Jane Doe
content_type: text/markdown
lang: en
acl_principals: [public]
created_at: 2026-01-10T09:00:00Z
updated_at: 2026-05-02T11:30:00Z
---
# Engineering Onboarding

Welcome to the engineering team. This page is the starting point for your first week.

## Accounts and Access

On day one, request access to GitLab, Confluence and the internal VPN. Your manager
approves the requests in the identity portal. Access is granted via your Entra ID
group membership, so most tools work automatically once you are added to the
`engineering` group.

## Local Development Setup

Install Node.js 20 or newer and Docker. Clone the service repository from GitLab and
run `docker compose up` to start Postgres locally. Copy `.env.example` to `.env`; the
defaults connect to the local database and require no external API keys.

## Database

We use PostgreSQL with the pgvector extension for semantic search. Run the database
migrations with `npm run db:migrate` before starting the application for the first
time. If a migration fails, check that the `vector` extension is available in your
Postgres image.

## Getting Help

Ask in the `#engineering-help` Teams channel. For urgent production issues, follow the
incident runbook linked from the deployment page.

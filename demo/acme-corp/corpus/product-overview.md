---
source_system: github
external_id: acme/conveyor-os:README.md
source_url: https://github.com/acme/conveyor-os/blob/main/README.md
title: Conveyor OS — Product Overview
breadcrumb: acme/conveyor-os
author: Acme Robotics
content_type: text/markdown
lang: en
acl_principals: [public]
created_at: 2026-01-15T09:00:00Z
updated_at: 2026-06-01T08:00:00Z
---
# Conveyor OS

Conveyor OS is Acme Robotics' flagship product: an operating system for warehouse
conveyor and sortation hardware. This README is public on our open documentation
repository.

## What it does

Conveyor OS coordinates fleets of conveyor segments, diverters and scanners. It
exposes a real-time control API and a web dashboard for floor operators. It is written
in Rust on the device side and TypeScript for the dashboard.

## Key features

- Real-time routing of parcels across conveyor segments
- Health monitoring and predictive-maintenance alerts for motors and belts
- A simulation mode so a new warehouse layout can be validated before install

## Getting started

See the public quickstart in this repository to run Conveyor OS against the bundled
hardware simulator. No customer hardware is required for evaluation.

# Changelog — Patient Engagement Engine

## [Unreleased]

## 2026-02-15
### Added
- CHANGELOG.md, DECISIONS.md, TODO.md — project management files

## 2026-02-12
### Added
- Initial project setup
- SMS System Implementation Spec v1.0 — locked production stack: Vercel + Supabase + Twilio + Anthropic Claude Haiku
- SMS Flow Specification v1.0 — full message content, templates, and conversation flows
- Functional Scale Definition v1.0 — HV-FIS 1–5 classification scale
- Visit Ready Report Template v1.0 — patient and clinician report designs
- Pilot Study Protocol v1.0 — 20–25 patient, 12-week study design
- Patient Engagement Design Brief
- Copay Assistance Feature spec
- Pricing Sheet v3
- Database migration 001: initial schema — 11 tables (patients, daily_entries, sprints, messages, weekly_entries, medication_history, state_transitions, providers, scheduled_jobs, webhook_log, reference_medications), 22 indexes, 4 report views, RLS policies, pg_cron setup
- Database migration 002: seed reference medications — 24 Rx preventives + 18 OTC/acute meds
- Database migration 003: Supabase RPC functions — get_and_lock_due_jobs (atomic dispatch with SKIP LOCKED), get_sprint_report (full report data), record_daily_entry (atomic write with sprint/patient count updates)
- lib/supabase.js — Supabase client singleton (service_role key, server-side only)
- lib/twilio.js — SMS send, webhook signature verification, inbound/outbound message logging
- lib/state-machine/transitions.js — valid transition map, transitionState() with audit logging, patient lookup by phone/ID
- lib/services/scheduler.js — job queue: schedule daily check-ins with jitter, one-shot jobs, cancel on pause/stop, timezone-aware next-occurrence calculation
- lib/templates.js — all outbound SMS message templates (O-1 through T-1, D-ACK rotation, SYS-*, ERR-*), rendering with patient data
- lib/utils/parse-time.js — natural language time parsing (e.g., "8am", "morning", "8:30 pm")
- lib/handlers/state-handlers.js — per-state inbound message handlers (ENROLLED, ONBOARDING, DAILY_ACTIVE, PAUSED, TRANSITION, DORMANT)
- api/webhooks/twilio.js — main inbound webhook: Twilio signature verification, patient lookup, global command routing (STOP/HELP/TIME/REPORT/PAUSE), state-based dispatch, reply sending
- package.json — three deps: @supabase/supabase-js, @anthropic-ai/sdk, twilio
- vercel.json — route mapping + Vercel Cron definitions
- .env.example — all required environment variables

### Changed
- Stack decision finalized: moved from AWS-native (ECS/RDS/SQS/EventBridge) to Vercel + Supabase (~65% cost reduction)
- Scheduling: replaced SQS + EventBridge with pg_cron + scheduled_jobs table (single Postgres-backed queue)

### Known Issues
- Twilio 10DLC healthcare registration not yet started (2–4 week lead time)
- BAAs not yet executed with Supabase, Twilio, Vercel, Anthropic
- AI parser (lib/ai/parser.js) not yet built
- Cron dispatch handler (api/cron/dispatch.js) not yet built
- Enrollment endpoint (api/enroll.js) not yet built
- Report generation not yet built

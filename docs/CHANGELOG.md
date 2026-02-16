# Changelog — Patient Engagement Engine

## [Unreleased]

## 2026-02-15
### Added
- CHANGELOG.md, DECISIONS.md, TODO.md — project management files
- lib/ai/parser.js — full AI classification pipeline using Claude 3.5 Haiku via structured tool_use output
  - Numeric passthrough for direct 1–5 responses (no API call needed)
  - AI classification for natural language text (e.g., "rough day but got through it")
  - Regex fallback patterns for API outages (>30s timeout)
  - Confidence-based routing: ≥0.80 accept, 0.60–0.79 clarify, <0.60 re-prompt
  - Action-based return values (ACCEPT/CLARIFY/REPROMPT) for clean handler integration
- tests/ai-parser.test.js — 96-test suite covering all specification patterns, edge cases, and full pipeline fallback behavior
- api/cron/dispatch.js — outbound message dispatcher
  - Processes 7 job types: daily check-ins, weekly questions, insight delivery, re-engagement, transition reminders, missed-day follow-ups, report generation
  - Proactive response detection on daily check-ins (skips if patient already responded today)
  - Atomic job locking via SELECT FOR UPDATE SKIP LOCKED
  - Concurrent job processing for performance
  - Error handling with retry logic per job

### Changed
- lib/handlers/state-handlers.js — replaced parseWithAI() stub with real parser integration
  - handleDailyActive now uses parseResponse() from lib/ai/parser.js
  - Routing switched from manual confidence checking to action-based dispatch (ACCEPT/CLARIFY/REPROMPT)
  - Removed inline keyword-matching fallback (now handled by parser's regex fallback layer)
- Supabase HIPAA BAA form submitted with detailed PHI descriptions and architecture overview

### Infrastructure
- Supabase HIPAA BAA application submitted
- Drafted answers for Twilio and Vercel BAA processes (not yet submitted)
- Identified deployment sequence: GitHub → Supabase migrations → Vercel config → Twilio 10DLC → BAAs

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
- BAAs not yet fully executed (Supabase submitted, others pending)
- Enrollment endpoint (api/enroll.js) not yet built
- Report generation not yet built
- api/cron/missed-days.js not yet built

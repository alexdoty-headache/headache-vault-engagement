# TODO — Patient Engagement Engine

## Critical Path (Blocking First Patient)
- [ ] Execute BAAs: Supabase, Twilio, Vercel, Anthropic
- [ ] Start Twilio 10DLC healthcare registration (2–4 week lead time)
- [ ] Deploy database schema to Supabase (migrations 001–003 ready, not yet run)
- [ ] Enable pg_cron and pg_net extensions in Supabase Dashboard
- [ ] Set environment variables in Vercel (see .env.example)

## Built ✓
- [x] Database migration 001: initial schema (11 tables, indexes, RLS, views)
- [x] Database migration 002: seed reference medications (42 records)
- [x] Database migration 003: Supabase RPC functions (atomic dispatch, report data, daily entry writes)
- [x] lib/supabase.js — client singleton
- [x] lib/twilio.js — send SMS, verify signatures, log messages
- [x] lib/state-machine/transitions.js — state machine engine with audit logging
- [x] lib/services/scheduler.js — job queue with jitter, timezone handling
- [x] lib/templates.js — all outbound SMS templates (O-1 through T-1)
- [x] lib/utils/parse-time.js — natural language time parsing
- [x] lib/handlers/state-handlers.js — per-state inbound message handlers
- [x] api/webhooks/twilio.js — main inbound webhook handler
- [x] package.json, vercel.json, .env.example

## Next Up (Build Priority Order)
- [ ] lib/ai/parser.js — Claude Haiku classification pipeline (HV-FIS level from free text, confidence thresholds, clarification prompts)
- [ ] api/cron/dispatch.js — cron handler that processes due jobs from scheduled_jobs table
- [ ] api/cron/missed-days.js — nightly detector for patients who didn't respond within 24h
- [ ] api/enroll.js — enrollment endpoint (create patient, trigger O-1 welcome message)
- [ ] End-to-end test with personal phone number (full onboarding → daily check-in → response → ACK cycle)

## Post-Core (Before Pilot Launch)
- [ ] Visit Ready Report generation (HTML + PDF via Puppeteer)
- [ ] Insight reflection messages (I-5, I-10, I-14, I-21, I-30) — data-driven content from sprint entries
- [ ] Day 30 transition flow (T-1)
- [ ] PCP enrollment interface (minimal — form or API endpoint for coordinators)
- [ ] Monitoring dashboard (Metabase connected to Supabase PostgreSQL)
- [ ] Draft patient consent document
- [ ] Draft clinician study information sheet
- [ ] Security review (Twilio signature validation, RLS policies, token URL generation)
- [ ] Load test: 50 concurrent simulated patients

## Pilot Execution (12 Weeks)
- [ ] Recruit 25 patients (rolling enrollment over 3 weeks)
- [ ] Week 5 go/no-go checkpoint (enrollment pace, day 7 retention, delivery rates)
- [ ] Week 8 go/no-go checkpoint (completion rates, AI parsing accuracy, clinician feedback)
- [ ] Manual review of all AI-parsed responses during first 2 weeks
- [ ] Clinician interviews post-appointment (structured utility assessment)
- [ ] Exit surveys at day 30

## Post-Beta
- [ ] Provider summary report generation
- [ ] Weekly monitoring mode (Phase 2 state machine)
- [ ] Treatment monitoring mode (Phase 2)
- [ ] Self-service web enrollment
- [ ] Data analysis pipeline for publication
- [ ] Publication prep (prospective vs. retrospective headache frequency gap)
- [ ] PA Engine integration (auto-populate forms from engagement data)

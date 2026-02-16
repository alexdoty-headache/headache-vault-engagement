# TODO — Patient Engagement Engine

*Last updated: 2026-02-15*

## Critical Path (Blocking First Patient)
- [ ] Execute BAAs: Supabase (submitted 2/15), Twilio, Vercel, Anthropic
- [ ] Start Twilio 10DLC healthcare registration (2–4 week lead time)
- [ ] Push codebase to GitHub
- [ ] Deploy database schema to Supabase (migrations 001–003 ready, not yet run)
- [ ] Enable pg_cron and pg_net extensions in Supabase Dashboard
- [ ] Set environment variables in Vercel (see .env.example)
- [ ] Build api/enroll.js — enrollment endpoint (create patient, trigger O-1)
- [ ] Build Visit Ready Report generator (HTML + PDF)
- [ ] End-to-end test with personal phone number (full onboarding → daily check-in → response → ACK cycle)

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
- [x] lib/handlers/state-handlers.js — per-state inbound message handlers (with real AI parser integration)
- [x] api/webhooks/twilio.js — main inbound webhook handler
- [x] lib/ai/parser.js — Claude 3.5 Haiku classification pipeline (numeric passthrough → AI tool_use → regex fallback)
- [x] tests/ai-parser.test.js — 96-test suite (all spec patterns, edge cases, pipeline fallback)
- [x] api/cron/dispatch.js — outbound message dispatcher (7 job types, concurrent processing, proactive response detection)
- [x] package.json, vercel.json, .env.example
- [x] CHANGELOG.md, DECISIONS.md, TODO.md

## Remaining Build Items
- [ ] api/enroll.js — enrollment endpoint (create patient + sprint, trigger O-1 welcome)
- [ ] api/cron/missed-days.js — nightly detector for patients who didn't respond within 24h
- [ ] api/reports/[token].js — Visit Ready Report endpoint (HTML rendering, patient/clinician toggle)
- [ ] Report PDF generation (Puppeteer or equivalent)
- [ ] Insight reflection content (I-5, I-10, I-14, I-21, I-30) — data-driven messages from sprint entries

## Compliance & Infrastructure
- [x] Supabase HIPAA BAA form submitted (2/15)
- [ ] Supabase BAA — awaiting execution
- [ ] Twilio HIPAA-eligible account + BAA
- [ ] Twilio 10DLC healthcare campaign registration
- [ ] Vercel BAA
- [ ] Anthropic BAA
- [ ] Toll-free number as fallback while 10DLC processes
- [ ] Domain setup for report URLs

## Pre-Pilot Launch
- [ ] PCP enrollment interface (minimal — form or API endpoint for coordinators)
- [ ] Monitoring dashboard (Metabase connected to Supabase PostgreSQL)
- [ ] Draft patient consent document
- [ ] Draft clinician study information sheet
- [ ] Security review (Twilio signature validation, RLS policies, token URL generation)
- [ ] Load test: 50 concurrent simulated patients
- [ ] Manual review protocol for AI-parsed responses during first 2 weeks

## Pilot Execution (12 Weeks)
- [ ] Recruit 25 patients (rolling enrollment over 3 weeks)
- [ ] Week 5 go/no-go checkpoint (enrollment pace, day 7 retention, delivery rates)
- [ ] Week 8 go/no-go checkpoint (completion rates, AI parsing accuracy, clinician feedback)
- [ ] Clinician interviews post-appointment (structured utility assessment)
- [ ] Exit surveys at day 30

## Post-Pilot
- [ ] Provider summary report generation
- [ ] Weekly monitoring mode (Phase 2 state machine)
- [ ] Treatment monitoring mode (Phase 2)
- [ ] Self-service web enrollment
- [ ] Data analysis pipeline for publication
- [ ] Publication prep (prospective vs. retrospective headache frequency gap)
- [ ] PA Engine integration (auto-populate forms from engagement data)

# Architecture Decision Records — Patient Engagement Engine

## ADR-001: Production Stack from Day One
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Could build a quick pilot with Landbot/Typeform, or go straight to production infrastructure.
**Decision:** Build with Next.js + Supabase + Twilio for production from the start.
**Rationale:** No throwaway code. HIPAA-compliant from day one. Supports publication-quality data collection. Healthcare systems require immediate reliability — a prototype rewrite mid-pilot would risk patient data continuity.
**Consequences:** Slower initial build (~4 weeks vs. ~1 week for no-code), but no rewrite needed. Every line of code ships to production.

## ADR-002: Structured SMS Input with AI Fallback (Not AI-First)
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Could use Claude to parse all free-text SMS responses, or require structured input (numbers, Y/N) with AI only as a fallback.
**Decision:** Primary path is structured numeric input (1–5 for HV-FIS). AI parsing via Claude 3.5 Haiku activates only when a patient sends free text instead of a number.
**Rationale:** Structured input is deterministic — no hallucination risk with patient data. AI fallback captures natural responses ("rough day but got through it") without forcing robotic interactions. Confidence thresholds (≥0.80 accept, 0.60–0.79 clarify, <0.60 re-prompt) ensure data quality.
**Consequences:** Slightly less conversational feel for numeric responders, but the data pipeline is trustworthy. AI costs stay low since most responses will be numeric.

## ADR-003: Vercel + Supabase over AWS-Native
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Original architecture was AWS ECS + RDS + SQS + EventBridge. Evaluated Vercel + Supabase as alternative.
**Decision:** Migrate to Vercel (serverless functions) + Supabase (managed PostgreSQL) for all infrastructure.
**Rationale:** ~65% cost reduction ($47/mo vs. $135/mo estimated). Shared platform with PA Engine reduces ops burden. Supabase provides BAA on Pro tier for HIPAA compliance. Vercel serverless fits the webhook-driven event pattern naturally. Zero cold starts on Pro tier.
**Consequences:** Vendor lock-in to Supabase/Vercel (mitigated by standard PostgreSQL and Node.js). Some limitations on long-running jobs (Vercel function timeout), addressed by keeping each job unit small.

## ADR-004: Postgres-Backed Job Queue over SQS/EventBridge
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Needed a way to schedule daily check-ins, insight reflections, and weekly context questions at patient-specific times with jitter.
**Decision:** Use a `scheduled_jobs` table in PostgreSQL with pg_cron dispatching every minute via `SELECT FOR UPDATE SKIP LOCKED`.
**Rationale:** At pilot scale (25 patients), a dedicated message queue is over-engineering. Postgres-backed queue keeps all scheduling state visible via SQL. No additional infrastructure to manage. SKIP LOCKED prevents double-processing. Jitter is baked into `scheduled_for` timestamp at job creation.
**Consequences:** Won't scale past ~500 concurrent patients without optimization. Acceptable — we'll re-evaluate at scale. All scheduling state is queryable, which helps debugging during the pilot.

## ADR-005: Reference Medication Tables in Postgres (Not Static JSON)
**Date:** 2026-02-12
**Status:** Accepted
**Context:** AI parser and Visit Ready Report need medication reference data (Therapeutic_Doses.csv, OTC_Medications.csv — ~70 records total). Could store as static JSON files or as database tables.
**Decision:** Import as a `reference_medications` table in PostgreSQL with seed migration.
**Rationale:** Report generation SQL can JOIN directly against reference data. AI parser prompt can query current medication list. Single source of truth in the database. Easy to update without redeployment.
**Consequences:** Slightly more complex migration, but simplifies downstream code. Medication updates require a SQL update rather than a code deploy.

## ADR-006: No In-Memory State Caching
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Could cache patient state in application memory for faster response times, or read from database on every request.
**Decision:** Read patient state from Supabase on every inbound message. No in-memory caching at the application layer.
**Rationale:** Stateless application instances mean any Vercel function can handle any patient's message. If a function instance crashes mid-processing, the next message re-reads correct state from the database. Eliminates an entire class of cache-invalidation bugs. At pilot scale, the extra DB read adds <50ms.
**Consequences:** Slightly higher database load per request. Negligible at 25 patients. Simplifies deployment and eliminates state synchronization issues entirely.

## ADR-007: Report URLs as Authentication (Token-Based, No Login)
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Visit Ready Reports need to be accessible to patients (via SMS link) and clinicians (via toggle on the same page). Could require login or use token-based URLs.
**Decision:** Reports are accessed via unguessable token URLs (32-character random string). No login required. URLs expire after 90 days. Patient can request a new link via REPORT command.
**Rationale:** Patients accessing reports via SMS link won't have accounts. Requiring login adds friction that would tank report access rates. Token URLs are standard for HIPAA-compliant document sharing when the link itself is the credential. The token is cryptographically random and not sequential.
**Consequences:** Anyone with the URL can view the report (mitigated by cryptographic randomness and expiration). No audit trail of who viewed the report beyond server logs.

## ADR-008: Three-Tier AI Classification Pipeline with Structured tool_use Output
**Date:** 2026-02-15
**Status:** Accepted
**Context:** Needed to classify natural language patient responses onto the HV-FIS 1–5 scale. The stub keyword matcher from 2/12 was functional for testing but not production-grade.
**Decision:** Implement a three-tier pipeline: (1) numeric passthrough for direct 1–5 inputs (no API call), (2) Claude 3.5 Haiku classification via structured tool_use for natural language, (3) regex fallback patterns if the Anthropic API is unavailable (>30s timeout). Parser returns action-based results (ACCEPT/CLARIFY/REPROMPT) rather than raw confidence scores.
**Rationale:** Numeric passthrough handles the expected majority of responses with zero latency and zero cost. Structured tool_use output eliminates JSON parsing fragility — Claude returns a typed object with level, confidence, and reasoning fields. Action-based returns simplify handler integration: the handler doesn't need to know about confidence thresholds, just what action to take. Regex fallback ensures patients can still be served during API outages.
**Consequences:** Three code paths to maintain, but each is simple and independently testable. 96-test suite provides regression coverage. The action abstraction means confidence thresholds can be tuned in the parser without touching handler code.

## ADR-009: Concurrent Job Processing in Cron Dispatcher
**Date:** 2026-02-15
**Status:** Accepted
**Context:** The cron dispatch handler needs to process due jobs from the scheduled_jobs table every minute. Could process sequentially or concurrently.
**Decision:** Process all locked jobs concurrently using Promise.allSettled(). Each job is an independent unit with its own error handling and retry logic. Proactive response detection on daily check-in jobs skips sending if the patient already responded today.
**Rationale:** At pilot scale, the job batch per minute is small (0–5 jobs), but concurrent processing keeps total execution time well within Vercel's 30-second function timeout. Promise.allSettled() ensures one failed job doesn't block others. Proactive response detection prevents the awkward "how are you?" arriving after a patient already checked in.
**Consequences:** No ordering guarantees between jobs in the same batch. Acceptable — jobs are independent by design. If a job fails, it stays in 'pending' state and gets retried next minute.

-- ============================================================================
-- HEADACHE VAULT - Patient Engagement System
-- Migration 001: Initial Schema
-- 
-- Platform:   Supabase (managed PostgreSQL 15+)
-- Implements: SMS System Implementation Spec v1.0 (Phase 1)
-- Reference:  Headache Vault Database Schema v3.0 (Therapeutic Doses, OTC Meds)
--
-- All tables use UUID primary keys. All timestamps are UTC (TIMESTAMPTZ).
-- Engagement system uses its own schema within the shared Supabase project.
-- PA Engine integration happens via direct DB access (same project) or API.
--
-- Scheduling: Replaces AWS SQS + EventBridge with pg_cron + a 
-- scheduled_jobs table. A cron job runs every minute, queries for 
-- due jobs, and dispatches them via pg_net to our Vercel edge function.
-- ============================================================================

BEGIN;

-- ============================================================================
-- EXTENSIONS
-- Supabase pre-enables many of these; CREATE IF NOT EXISTS is safe.
-- pg_cron and pg_net are enabled via Supabase Dashboard > Database > Extensions.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";    -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_bytes() for report tokens
-- NOTE: Enable these via Supabase Dashboard (cannot CREATE in user transaction):
--   pg_cron    — cron-based job scheduling within Postgres
--   pg_net     — async HTTP requests from Postgres (for webhook dispatch)

-- ============================================================================
-- ENUM TYPES
-- ============================================================================

CREATE TYPE patient_state AS ENUM (
    'ENROLLED',
    'ONBOARDING',
    'DAILY_ACTIVE',
    'PAUSED',
    'TRANSITION',
    'WEEKLY',        -- Phase 2
    'TREATMENT',     -- Phase 2
    'DORMANT',
    'UNSUBSCRIBED'
);

CREATE TYPE message_direction AS ENUM ('OUTBOUND', 'INBOUND');

CREATE TYPE delivery_status AS ENUM (
    'QUEUED',
    'SENT',
    'DELIVERED',
    'FAILED',
    'UNDELIVERED'
);

CREATE TYPE enrollment_source AS ENUM (
    'PCP_INITIATED',
    'SELF_SERVICE',
    'REFERRAL',
    'QR_CODE'
);

CREATE TYPE sprint_type AS ENUM (
    'INITIAL',
    'TREATMENT',
    'RE_ENGAGEMENT'
);

CREATE TYPE sprint_status AS ENUM (
    'ACTIVE',
    'COMPLETED',
    'ABANDONED'
);

CREATE TYPE response_method AS ENUM (
    'NUMERIC',
    'AI_PARSED',
    'CLARIFIED'
);

CREATE TYPE weekly_question_type AS ENUM (
    'ACUTE_MEDS',
    'MISSED_ACTIVITIES',
    'TRIGGERS'
);

CREATE TYPE med_status AS ENUM (
    'DISCONTINUED',
    'CURRENT',
    'UNKNOWN'
);

CREATE TYPE discontinuation_reason AS ENUM (
    'SIDE_EFFECTS',
    'INEFFECTIVE',
    'COST',
    'OTHER'
);

CREATE TYPE transition_trigger AS ENUM (
    'PATIENT_RESPONSE',
    'SYSTEM_TIMER',
    'ADMIN_ACTION'
);

CREATE TYPE pending_question_type AS ENUM (
    'ONBOARD_TIME',
    'ONBOARD_APPT',
    'MED_HISTORY_YN',
    'MED_HISTORY_LIST',
    'MED_HISTORY_REASON',
    'CLARIFY_LEVEL',
    'WEEKLY_RESPONSE',
    'TRANSITION_CHOICE'
);

CREATE TYPE medication_type AS ENUM (
    'RX_PREVENTIVE',
    'OTC'
);

-- ============================================================================
-- TABLE: providers
-- PCP records for provider-initiated enrollment.
-- ============================================================================

CREATE TABLE providers (
    provider_id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    provider_name       VARCHAR(200)    NOT NULL,
    practice_name       VARCHAR(200),
    vault_account_id    VARCHAR(50),        -- FK to PA Engine provider account (future)
    npi                 VARCHAR(10),
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_providers_npi ON providers (npi) WHERE npi IS NOT NULL;
CREATE INDEX idx_providers_vault_account ON providers (vault_account_id) WHERE vault_account_id IS NOT NULL;

-- ============================================================================
-- TABLE: patients
-- Core patient record. One row per patient.
-- ============================================================================

CREATE TABLE patients (
    patient_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number        VARCHAR(15)     NOT NULL,
    first_name          VARCHAR(100)    NOT NULL,
    email               VARCHAR(255),
    state               patient_state   NOT NULL DEFAULT 'ENROLLED',
    preferred_time      TIME,               -- Patient's local timezone
    timezone            VARCHAR(50)     NOT NULL DEFAULT 'America/New_York',
    sprint_start_date   DATE,
    day_count           INTEGER         NOT NULL DEFAULT 0,
    consecutive_missed  INTEGER         NOT NULL DEFAULT 0,
    enrollment_source   enrollment_source NOT NULL,
    pcp_provider_id     UUID            REFERENCES providers(provider_id),
    appointment_date    DATE,
    payer_id            VARCHAR(30),        -- Vault_Payer_ID from PA Engine registry
    pending_question    pending_question_type,
    current_treatment   VARCHAR(100),       -- Medication name if in TREATMENT state
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    opted_in_at         TIMESTAMPTZ,        -- When patient replied START
    opted_out_at        TIMESTAMPTZ         -- When patient replied STOP
);

-- Phone number is the primary lookup key for inbound messages
CREATE UNIQUE INDEX idx_patients_phone ON patients (phone_number);
CREATE INDEX idx_patients_state ON patients (state);
CREATE INDEX idx_patients_pcp ON patients (pcp_provider_id) WHERE pcp_provider_id IS NOT NULL;
CREATE INDEX idx_patients_payer ON patients (payer_id) WHERE payer_id IS NOT NULL;

-- ============================================================================
-- TABLE: sprints
-- Groups daily entries into tracking sprints. A patient can have multiple.
-- ============================================================================

CREATE TABLE sprints (
    sprint_id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id              UUID            NOT NULL REFERENCES patients(patient_id),
    sprint_type             sprint_type     NOT NULL DEFAULT 'INITIAL',
    treatment_medication    VARCHAR(100),       -- If sprint_type = TREATMENT
    baseline_sprint_id      UUID            REFERENCES sprints(sprint_id),
    start_date              DATE            NOT NULL,
    end_date                DATE,               -- NULL if in progress
    target_days             SMALLINT        NOT NULL DEFAULT 30,
    days_completed          SMALLINT        NOT NULL DEFAULT 0,
    days_missed             SMALLINT        NOT NULL DEFAULT 0,
    status                  sprint_status   NOT NULL DEFAULT 'ACTIVE',
    report_generated        BOOLEAN         NOT NULL DEFAULT FALSE,
    report_url              TEXT,               -- Authenticated URL for the report
    report_token            VARCHAR(64),        -- Crypto-random token for URL auth
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sprints_patient ON sprints (patient_id);
CREATE INDEX idx_sprints_patient_active ON sprints (patient_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX idx_sprints_report_token ON sprints (report_token) WHERE report_token IS NOT NULL;

-- ============================================================================
-- TABLE: daily_entries
-- One row per patient per day. The core clinical data table.
-- ============================================================================

CREATE TABLE daily_entries (
    entry_id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id              UUID            NOT NULL REFERENCES patients(patient_id),
    sprint_id               UUID            NOT NULL REFERENCES sprints(sprint_id),
    entry_date              DATE            NOT NULL,
    hv_fis_level            SMALLINT        NOT NULL CHECK (hv_fis_level BETWEEN 1 AND 5),
    response_raw            TEXT,               -- Exact patient SMS text. NULL if numeric only.
    response_method         response_method NOT NULL,
    ai_confidence           DECIMAL(3,2)    CHECK (ai_confidence BETWEEN 0.00 AND 1.00),
    prompt_sent_at          TIMESTAMPTZ     NOT NULL,
    response_received_at    TIMESTAMPTZ,        -- NULL if missed day
    response_latency_min    INTEGER,            -- Minutes between prompt and response
    is_missed               BOOLEAN         NOT NULL DEFAULT FALSE,
    day_number              SMALLINT        NOT NULL CHECK (day_number BETWEEN 1 AND 30),
    acknowledgment_template VARCHAR(20),        -- Which D-ACK variant was sent
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Unique constraint: one entry per patient per sprint per date
CREATE UNIQUE INDEX idx_daily_entries_unique ON daily_entries (patient_id, sprint_id, entry_date);
CREATE INDEX idx_daily_entries_sprint ON daily_entries (sprint_id);
CREATE INDEX idx_daily_entries_patient_date ON daily_entries (patient_id, entry_date DESC);

-- ============================================================================
-- TABLE: weekly_entries
-- Responses to weekly context questions (W-1, W-2, W-3).
-- ============================================================================

CREATE TABLE weekly_entries (
    weekly_entry_id     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id          UUID                NOT NULL REFERENCES patients(patient_id),
    sprint_id           UUID                NOT NULL REFERENCES sprints(sprint_id),
    question_type       weekly_question_type NOT NULL,
    week_number         SMALLINT            NOT NULL CHECK (week_number BETWEEN 1 AND 5),
    response_value      VARCHAR(10),            -- Structured: med day count, activity level 1-4
    response_text       TEXT,                   -- Free-text (especially triggers)
    asked_at            TIMESTAMPTZ         NOT NULL,
    responded_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_weekly_entries_patient_sprint ON weekly_entries (patient_id, sprint_id);

-- ============================================================================
-- TABLE: medication_history
-- Patient-reported medication history from onboarding (O-4 sequence).
-- ============================================================================

CREATE TABLE medication_history (
    med_history_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id              UUID            NOT NULL REFERENCES patients(patient_id),
    medication_raw          TEXT            NOT NULL,    -- Patient's original text
    medication_normalized   VARCHAR(100),               -- AI-matched to reference_medications
    drug_class              VARCHAR(50),                -- For step therapy counting
    status                  med_status      NOT NULL DEFAULT 'UNKNOWN',
    discontinuation_reason  discontinuation_reason,
    discontinuation_detail  TEXT,
    ai_match_confidence     DECIMAL(3,2)    CHECK (ai_match_confidence BETWEEN 0.00 AND 1.00),
    created_at              TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_med_history_patient ON medication_history (patient_id);

-- ============================================================================
-- TABLE: messages
-- Complete log of every SMS sent and received. Audit trail.
-- ============================================================================

CREATE TABLE messages (
    message_id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id          UUID            NOT NULL REFERENCES patients(patient_id),
    direction           message_direction NOT NULL,
    template_id         VARCHAR(20),        -- O-1, D-1, I-5, etc. NULL for inbound.
    body                TEXT            NOT NULL,
    twilio_sid          VARCHAR(40),
    delivery_status     delivery_status NOT NULL DEFAULT 'QUEUED',
    failure_reason      TEXT,
    sent_at             TIMESTAMPTZ,        -- For outbound
    received_at         TIMESTAMPTZ,        -- For inbound
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_patient ON messages (patient_id);
CREATE INDEX idx_messages_patient_dir ON messages (patient_id, direction, created_at DESC);
CREATE INDEX idx_messages_twilio_sid ON messages (twilio_sid) WHERE twilio_sid IS NOT NULL;
CREATE INDEX idx_messages_template ON messages (template_id) WHERE template_id IS NOT NULL;

-- ============================================================================
-- TABLE: state_transitions
-- Audit log for every state change. Immutable, append-only.
-- ============================================================================

CREATE TABLE state_transitions (
    transition_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id          UUID            NOT NULL REFERENCES patients(patient_id),
    from_state          patient_state   NOT NULL,
    to_state            patient_state   NOT NULL,
    trigger_type        transition_trigger NOT NULL,
    trigger_detail      TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_state_transitions_patient ON state_transitions (patient_id, created_at DESC);

-- ============================================================================
-- TABLE: reference_medications
-- Merged reference table from Therapeutic_Doses.csv (41 Rx) and 
-- OTC_Medications.csv (29 OTC). Used by AI medication parser and 
-- Visit Ready Report generator.
--
-- Source: Headache Vault Database Schema v3.0
-- ============================================================================

CREATE TABLE reference_medications (
    medication_name             VARCHAR(100)    PRIMARY KEY,
    generic_name                VARCHAR(200)    NOT NULL,
    brand_names                 VARCHAR(500),       -- Additional brand names (OTC mainly)
    medication_type             medication_type NOT NULL,
    drug_class                  VARCHAR(50)     NOT NULL,

    -- Rx-specific fields (NULL for OTC)
    therapeutic_dose_min        INTEGER,
    therapeutic_dose_max        INTEGER,
    dose_unit                   VARCHAR(20),
    trial_duration_min_weeks    INTEGER,
    common_starting_dose        VARCHAR(100),
    titration_schedule          VARCHAR(500),
    common_side_effects         TEXT,               -- Common AEs leading to discontinuation
    contraindications           TEXT,
    step_therapy_class_count    VARCHAR(100),
    evidence_level              VARCHAR(100),

    -- OTC-specific fields (NULL for Rx)
    moh_category                VARCHAR(50),
    moh_threshold_days_per_month INTEGER,
    active_ingredients          VARCHAR(500),
    caffeine_content_mg         INTEGER,

    -- Shared fields
    rxnorm_id                   VARCHAR(20),
    source_citation             VARCHAR(500),
    notes                       TEXT
);

CREATE INDEX idx_ref_meds_type ON reference_medications (medication_type);
CREATE INDEX idx_ref_meds_class ON reference_medications (drug_class);
CREATE INDEX idx_ref_meds_generic ON reference_medications (generic_name);

-- ============================================================================
-- FUNCTION: update_updated_at()
-- Auto-update the updated_at timestamp on patients table.
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_patients_updated_at
    BEFORE UPDATE ON patients
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- FUNCTION: generate_report_token()
-- Generates a crypto-random 32-byte hex string for report URL authentication.
-- ============================================================================

CREATE OR REPLACE FUNCTION generate_report_token()
RETURNS VARCHAR(64) AS $$
BEGIN
    RETURN encode(gen_random_bytes(32), 'hex');
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Report data view: aggregates daily_entries for a sprint into report fields.
-- Used by the report generator to compute all Visit Ready Report metrics.
CREATE VIEW v_sprint_report_data AS
SELECT
    s.sprint_id,
    s.patient_id,
    s.sprint_type,
    s.start_date,
    s.end_date,
    s.days_completed,
    s.days_missed,
    s.target_days,
    s.treatment_medication,
    p.first_name,
    p.appointment_date,
    p.payer_id,
    prov.provider_name AS pcp_name,
    prov.practice_name,

    -- Level distribution
    COUNT(*) FILTER (WHERE de.hv_fis_level = 1) AS level_1_days,
    COUNT(*) FILTER (WHERE de.hv_fis_level = 2) AS level_2_days,
    COUNT(*) FILTER (WHERE de.hv_fis_level = 3) AS level_3_days,
    COUNT(*) FILTER (WHERE de.hv_fis_level = 4) AS level_4_days,
    COUNT(*) FILTER (WHERE de.hv_fis_level = 5) AS level_5_days,

    -- Monthly headache days (Level >= 2)
    COUNT(*) FILTER (WHERE de.hv_fis_level >= 2) AS monthly_headache_days,

    -- Headache-free days (Level 1)
    COUNT(*) FILTER (WHERE de.hv_fis_level = 1) AS headache_free_days,

    -- HV-DBS Score: (L3*1 + L4*2 + L5*3)
    COALESCE(
        SUM(CASE
            WHEN de.hv_fis_level = 3 THEN 1
            WHEN de.hv_fis_level = 4 THEN 2
            WHEN de.hv_fis_level = 5 THEN 3
            ELSE 0
        END), 0
    ) AS hv_dbs_score,

    -- Projected MIDAS: ((L5*2 + L4*1.5 + L3*0.5) * 3)
    COALESCE(
        ROUND((
            SUM(CASE
                WHEN de.hv_fis_level = 5 THEN 2.0
                WHEN de.hv_fis_level = 4 THEN 1.5
                WHEN de.hv_fis_level = 3 THEN 0.5
                ELSE 0
            END) * 3
        )::NUMERIC, 1), 0
    ) AS projected_midas_score,

    -- Completion rate
    CASE WHEN s.target_days > 0
        THEN ROUND((s.days_completed::NUMERIC / s.target_days) * 100, 1)
        ELSE 0
    END AS completion_rate_pct,

    -- Average level
    ROUND(AVG(de.hv_fis_level)::NUMERIC, 2) AS avg_hv_fis_level,

    -- Response method breakdown
    COUNT(*) FILTER (WHERE de.response_method = 'NUMERIC') AS numeric_responses,
    COUNT(*) FILTER (WHERE de.response_method = 'AI_PARSED') AS ai_parsed_responses,
    COUNT(*) FILTER (WHERE de.response_method = 'CLARIFIED') AS clarified_responses,

    -- Engagement metrics
    ROUND(AVG(de.response_latency_min)::NUMERIC, 0) AS avg_response_latency_min,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY de.response_latency_min) AS median_response_latency_min

FROM sprints s
JOIN patients p ON s.patient_id = p.patient_id
LEFT JOIN providers prov ON p.pcp_provider_id = prov.provider_id
LEFT JOIN daily_entries de ON de.sprint_id = s.sprint_id AND de.is_missed = FALSE
GROUP BY
    s.sprint_id, s.patient_id, s.sprint_type, s.start_date, s.end_date,
    s.days_completed, s.days_missed, s.target_days, s.treatment_medication,
    p.first_name, p.appointment_date, p.payer_id,
    prov.provider_name, prov.practice_name;

-- Weekly pattern view: average level by day of week for temporal analysis
CREATE VIEW v_weekly_pattern AS
SELECT
    sprint_id,
    patient_id,
    EXTRACT(DOW FROM entry_date) AS day_of_week,  -- 0=Sun, 6=Sat
    TO_CHAR(entry_date, 'Dy') AS day_name,
    ROUND(AVG(hv_fis_level)::NUMERIC, 2) AS avg_level,
    COUNT(*) AS entry_count
FROM daily_entries
WHERE is_missed = FALSE
GROUP BY sprint_id, patient_id, EXTRACT(DOW FROM entry_date), TO_CHAR(entry_date, 'Dy');

-- Week-over-week trend view
CREATE VIEW v_weekly_trend AS
SELECT
    sprint_id,
    patient_id,
    CEIL(day_number / 7.0)::INTEGER AS week_number,
    ROUND(AVG(hv_fis_level)::NUMERIC, 2) AS avg_level,
    COUNT(*) AS days_tracked,
    COUNT(*) FILTER (WHERE hv_fis_level >= 2) AS headache_days,
    COUNT(*) FILTER (WHERE hv_fis_level = 1) AS headache_free_days
FROM daily_entries
WHERE is_missed = FALSE
GROUP BY sprint_id, patient_id, CEIL(day_number / 7.0)::INTEGER;

-- Acute medication projection view (from weekly_entries W-1 responses)
CREATE VIEW v_acute_med_projection AS
SELECT
    we.sprint_id,
    we.patient_id,
    ROUND(AVG(we.response_value::NUMERIC) * 4.3, 1) AS projected_monthly_acute_days,
    CASE WHEN AVG(we.response_value::NUMERIC) * 4.3 >= 10
        THEN TRUE ELSE FALSE
    END AS moh_risk_flag,
    COUNT(*) AS weeks_reported
FROM weekly_entries we
WHERE we.question_type = 'ACUTE_MEDS'
  AND we.response_value IS NOT NULL
GROUP BY we.sprint_id, we.patient_id;

-- ============================================================================
-- TABLE: scheduled_jobs
-- Replaces AWS SQS + EventBridge. This is the message queue.
--
-- How it works:
--   1. When a patient enters DAILY_ACTIVE, we INSERT a recurring job row.
--   2. A pg_cron job runs every minute and calls a Vercel edge function
--      with the batch of due jobs.
--   3. The edge function processes each job (sends SMS, etc.) and marks
--      it completed or reschedules it.
--
-- Job types: DAILY_CHECKIN, WEEKLY_QUESTION, INSIGHT, RE_ENGAGEMENT,
--            TRANSITION, ONBOARD_REMINDER
-- ============================================================================

CREATE TYPE job_status AS ENUM (
    'PENDING',      -- Waiting to fire
    'PROCESSING',   -- Picked up by the cron dispatcher
    'COMPLETED',    -- Successfully processed
    'FAILED',       -- Processing failed (will retry)
    'CANCELLED'     -- Manually cancelled (patient paused/stopped)
);

CREATE TYPE job_type AS ENUM (
    'DAILY_CHECKIN',
    'WEEKLY_QUESTION',
    'INSIGHT',
    'RE_ENGAGEMENT',
    'TRANSITION',
    'ONBOARD_REMINDER',
    'REPORT_GENERATION'
);

CREATE TABLE scheduled_jobs (
    job_id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    patient_id          UUID            NOT NULL REFERENCES patients(patient_id),
    job_type            job_type        NOT NULL,
    status              job_status      NOT NULL DEFAULT 'PENDING',

    -- When should this job fire?
    scheduled_for       TIMESTAMPTZ     NOT NULL,

    -- Jitter: random 0-5 min offset to avoid carrier throttling.
    -- Applied when the job is created, baked into scheduled_for.
    jitter_seconds      SMALLINT        NOT NULL DEFAULT 0,

    -- Job-specific payload (e.g., which weekly question, which insight day)
    payload             JSONB           NOT NULL DEFAULT '{}',

    -- Retry tracking
    attempts            SMALLINT        NOT NULL DEFAULT 0,
    max_attempts        SMALLINT        NOT NULL DEFAULT 3,
    last_error          TEXT,

    -- Is this a recurring job? If so, the cron expression for rescheduling.
    -- NULL = one-shot job. 'daily' = reschedule for next day at same time.
    recurrence          VARCHAR(20),

    -- Bookkeeping
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ         -- When the job was actually processed
);

-- The critical query: "give me all jobs that are due right now"
CREATE INDEX idx_jobs_pending_due ON scheduled_jobs (scheduled_for)
    WHERE status = 'PENDING';

-- Find all jobs for a patient (for cancellation on PAUSE/STOP)
CREATE INDEX idx_jobs_patient_status ON scheduled_jobs (patient_id, status);

-- Cleanup: find old completed/failed jobs for archival
CREATE INDEX idx_jobs_status_processed ON scheduled_jobs (status, processed_at)
    WHERE status IN ('COMPLETED', 'FAILED');

-- Auto-update updated_at
CREATE TRIGGER trigger_jobs_updated_at
    BEFORE UPDATE ON scheduled_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- TABLE: webhook_log
-- Lightweight log of all inbound Twilio webhooks for debugging.
-- Separate from the messages table because we log the raw webhook
-- BEFORE we've identified the patient or parsed the message.
-- ============================================================================

CREATE TABLE webhook_log (
    log_id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source              VARCHAR(20)     NOT NULL DEFAULT 'twilio',
    method              VARCHAR(10)     NOT NULL DEFAULT 'POST',
    headers             JSONB,
    body                JSONB           NOT NULL,
    from_number         VARCHAR(15),        -- Extracted from body for quick lookup
    twilio_signature    TEXT,               -- For signature verification
    processed           BOOLEAN         NOT NULL DEFAULT FALSE,
    processing_error    TEXT,
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_webhook_log_unprocessed ON webhook_log (created_at)
    WHERE processed = FALSE;
CREATE INDEX idx_webhook_log_from ON webhook_log (from_number, created_at DESC);

-- ============================================================================
-- SUPABASE ROW LEVEL SECURITY (RLS)
-- 
-- Supabase exposes Postgres via its client libraries. RLS ensures that
-- even if the client SDK is used, data access is controlled.
--
-- For Phase 1: all access goes through our Vercel edge functions using
-- the service_role key (bypasses RLS). RLS policies here are defense-
-- in-depth for the anon/authenticated roles.
--
-- We ENABLE RLS on all tables but create permissive policies only for
-- the service_role. The anon role gets nothing.
-- ============================================================================

ALTER TABLE providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_medications ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;

-- Reference medications are read-only for everyone (non-PHI)
CREATE POLICY "reference_medications_read_all"
    ON reference_medications FOR SELECT
    USING (true);

-- All other tables: no access via anon/authenticated roles.
-- Our edge functions use service_role which bypasses RLS entirely.
-- When we build patient-facing features (Phase 2+), we'll add
-- policies like: patients can SELECT their own rows via auth.uid().

-- ============================================================================
-- pg_cron SETUP (run after enabling extension in Supabase Dashboard)
--
-- These statements schedule the cron jobs. Execute them separately
-- in the Supabase SQL Editor after the migration runs, because
-- pg_cron requires the extension to be enabled first.
-- ============================================================================

-- UNCOMMENT AND RUN AFTER ENABLING pg_cron IN SUPABASE DASHBOARD:
--
-- Job dispatcher: runs every minute, finds due jobs, calls our edge function.
-- The edge function URL should be set to your Vercel deployment.
--
-- SELECT cron.schedule(
--     'dispatch-scheduled-jobs',          -- job name
--     '* * * * *',                         -- every minute
--     $$
--     SELECT net.http_post(
--         url := 'https://your-app.vercel.app/api/cron/dispatch',
--         headers := jsonb_build_object(
--             'Content-Type', 'application/json',
--             'Authorization', 'Bearer ' || current_setting('app.cron_secret')
--         ),
--         body := jsonb_build_object(
--             'source', 'pg_cron',
--             'timestamp', now()::text
--         )
--     );
--     $$
-- );
--
-- Cleanup: archive completed jobs older than 7 days (runs daily at 3am UTC)
--
-- SELECT cron.schedule(
--     'cleanup-old-jobs',
--     '0 3 * * *',
--     $$
--     DELETE FROM scheduled_jobs
--     WHERE status IN ('COMPLETED', 'CANCELLED')
--       AND processed_at < NOW() - INTERVAL '7 days';
--     $$
-- );
--
-- Missed day detector: runs daily at 11pm UTC, checks for patients who
-- didn't respond within 24 hours of their prompt.
--
-- SELECT cron.schedule(
--     'detect-missed-days',
--     '0 23 * * *',
--     $$
--     SELECT net.http_post(
--         url := 'https://your-app.vercel.app/api/cron/missed-days',
--         headers := jsonb_build_object(
--             'Content-Type', 'application/json',
--             'Authorization', 'Bearer ' || current_setting('app.cron_secret')
--         ),
--         body := jsonb_build_object(
--             'source', 'pg_cron',
--             'timestamp', now()::text
--         )
--     );
--     $$
-- );

COMMIT;

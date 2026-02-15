-- ============================================================================
-- HEADACHE VAULT - Patient Engagement System
-- Migration 003: Supabase RPC Functions
--
-- Database functions called from the application layer via supabase.rpc().
-- These handle operations that need raw SQL (SELECT FOR UPDATE, etc.)
-- that the Supabase client JS API doesn't support directly.
-- ============================================================================

BEGIN;

-- ============================================================================
-- FUNCTION: get_and_lock_due_jobs
-- 
-- Atomically selects and locks due jobs for processing.
-- Uses FOR UPDATE SKIP LOCKED to prevent double-processing if the
-- cron dispatcher fires twice or runs slow.
--
-- Called by: /api/cron/dispatch (every minute via pg_cron or Vercel Cron)
-- ============================================================================

CREATE OR REPLACE FUNCTION get_and_lock_due_jobs(job_limit INTEGER DEFAULT 50)
RETURNS SETOF scheduled_jobs
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH due_jobs AS (
        SELECT *
        FROM scheduled_jobs
        WHERE status = 'PENDING'
          AND scheduled_for <= NOW()
        ORDER BY scheduled_for ASC
        LIMIT job_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE scheduled_jobs sj
    SET status = 'PROCESSING',
        updated_at = NOW()
    FROM due_jobs dj
    WHERE sj.job_id = dj.job_id
    RETURNING sj.*;
END;
$$;

-- ============================================================================
-- FUNCTION: get_sprint_report
--
-- Returns all data needed to render a Visit Ready Report for a given
-- report token. This is the main query behind /api/reports/[token].
--
-- Returns NULL if the token is invalid or expired (>90 days).
-- ============================================================================

CREATE OR REPLACE FUNCTION get_sprint_report(p_report_token VARCHAR)
RETURNS TABLE (
    -- Sprint info
    sprint_id UUID,
    patient_id UUID,
    sprint_type sprint_type,
    start_date DATE,
    end_date DATE,
    days_completed SMALLINT,
    days_missed SMALLINT,
    target_days SMALLINT,
    treatment_medication VARCHAR,
    -- Patient info
    first_name VARCHAR,
    appointment_date DATE,
    payer_id VARCHAR,
    pcp_name VARCHAR,
    practice_name VARCHAR,
    -- Level distribution
    level_1_days BIGINT,
    level_2_days BIGINT,
    level_3_days BIGINT,
    level_4_days BIGINT,
    level_5_days BIGINT,
    -- Clinical metrics
    monthly_headache_days BIGINT,
    headache_free_days BIGINT,
    hv_dbs_score NUMERIC,
    projected_midas_score NUMERIC,
    completion_rate_pct NUMERIC,
    avg_hv_fis_level NUMERIC,
    -- Engagement metrics
    avg_response_latency_min NUMERIC,
    median_response_latency_min DOUBLE PRECISION
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        rd.sprint_id, rd.patient_id, rd.sprint_type, rd.start_date,
        rd.end_date, rd.days_completed, rd.days_missed, rd.target_days,
        rd.treatment_medication, rd.first_name, rd.appointment_date,
        rd.payer_id, rd.pcp_name, rd.practice_name,
        rd.level_1_days, rd.level_2_days, rd.level_3_days,
        rd.level_4_days, rd.level_5_days,
        rd.monthly_headache_days, rd.headache_free_days,
        rd.hv_dbs_score, rd.projected_midas_score,
        rd.completion_rate_pct, rd.avg_hv_fis_level,
        rd.avg_response_latency_min, rd.median_response_latency_min
    FROM sprints s
    JOIN v_sprint_report_data rd ON rd.sprint_id = s.sprint_id
    WHERE s.report_token = p_report_token
      AND s.created_at > NOW() - INTERVAL '90 days';
END;
$$;

-- ============================================================================
-- FUNCTION: record_daily_entry
--
-- Atomic operation: insert a daily entry, update sprint counts, update
-- patient day_count and consecutive_missed. This should be one transaction
-- so we never have inconsistent counts.
--
-- Called by the inbound message handler after parsing the response.
-- ============================================================================

CREATE OR REPLACE FUNCTION record_daily_entry(
    p_patient_id UUID,
    p_sprint_id UUID,
    p_entry_date DATE,
    p_hv_fis_level SMALLINT,
    p_response_raw TEXT,
    p_response_method response_method,
    p_ai_confidence DECIMAL,
    p_prompt_sent_at TIMESTAMPTZ,
    p_response_received_at TIMESTAMPTZ,
    p_day_number SMALLINT,
    p_ack_template VARCHAR
)
RETURNS daily_entries
LANGUAGE plpgsql
AS $$
DECLARE
    v_entry daily_entries;
    v_latency INTEGER;
BEGIN
    -- Calculate response latency in minutes
    v_latency := EXTRACT(EPOCH FROM (p_response_received_at - p_prompt_sent_at)) / 60;

    -- Insert daily entry (or update if already exists for this date)
    INSERT INTO daily_entries (
        patient_id, sprint_id, entry_date, hv_fis_level,
        response_raw, response_method, ai_confidence,
        prompt_sent_at, response_received_at, response_latency_min,
        is_missed, day_number, acknowledgment_template
    ) VALUES (
        p_patient_id, p_sprint_id, p_entry_date, p_hv_fis_level,
        p_response_raw, p_response_method, p_ai_confidence,
        p_prompt_sent_at, p_response_received_at, v_latency,
        FALSE, p_day_number, p_ack_template
    )
    ON CONFLICT (patient_id, sprint_id, entry_date)
    DO UPDATE SET
        hv_fis_level = EXCLUDED.hv_fis_level,
        response_raw = EXCLUDED.response_raw,
        response_method = EXCLUDED.response_method,
        ai_confidence = EXCLUDED.ai_confidence,
        response_received_at = EXCLUDED.response_received_at,
        response_latency_min = EXCLUDED.response_latency_min,
        is_missed = FALSE,
        acknowledgment_template = EXCLUDED.acknowledgment_template
    RETURNING * INTO v_entry;

    -- Update sprint counts
    UPDATE sprints
    SET days_completed = (
            SELECT COUNT(*) FROM daily_entries
            WHERE sprint_id = p_sprint_id AND is_missed = FALSE
        )
    WHERE sprint_id = p_sprint_id;

    -- Update patient: increment day_count, reset consecutive_missed
    UPDATE patients
    SET day_count = (
            SELECT COUNT(*) FROM daily_entries
            WHERE patient_id = p_patient_id
              AND sprint_id = p_sprint_id
              AND is_missed = FALSE
        ),
        consecutive_missed = 0
    WHERE patient_id = p_patient_id;

    RETURN v_entry;
END;
$$;

COMMIT;

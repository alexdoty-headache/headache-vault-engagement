/**
 * Scheduler Service
 * 
 * Replaces AWS SQS + EventBridge with a Postgres-backed job queue.
 * 
 * How it works:
 *   - scheduleDailyCheckin() creates a recurring PENDING job for the patient's
 *     preferred time (with 0-5 min random jitter).
 *   - getDueJobs() returns all PENDING jobs whose scheduled_for <= now.
 *   - markJobProcessed() / markJobFailed() update status after processing.
 *   - rescheduleDaily() creates tomorrow's job after today's completes.
 *   - cancelPatientJobs() cancels all PENDING jobs (for PAUSE/STOP).
 * 
 * The pg_cron job calls our /api/cron/dispatch endpoint every minute,
 * which calls getDueJobs() and processes each one.
 * 
 * See: SMS System Implementation Spec §6 (Message Scheduling Engine)
 */

const { supabase } = require('../supabase');

/**
 * Add random jitter (0-300 seconds) to avoid carrier throttling.
 * Per spec: "random jitter of 0-5 minutes."
 */
function generateJitter() {
    return Math.floor(Math.random() * 300);
}

/**
 * Calculate the next occurrence of a given time in a given timezone.
 * Returns a UTC timestamp for when we should fire.
 * 
 * @param {string} timeStr - Time in HH:MM format (patient's local time)
 * @param {string} timezone - IANA timezone (e.g., 'America/New_York')
 * @param {Date|null} afterDate - Schedule after this date. Defaults to now.
 * @returns {Date} - UTC Date object
 */
function nextOccurrence(timeStr, timezone, afterDate = null) {
    const now = afterDate || new Date();
    const [hours, minutes] = timeStr.split(':').map(Number);

    // Create a date in the patient's timezone
    // We use Intl to figure out the current offset, then compute UTC
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });

    const parts = formatter.formatToParts(now);
    const localParts = {};
    parts.forEach(p => { localParts[p.type] = p.value; });

    // Build today's target time in the patient's timezone
    const localNow = new Date(
        `${localParts.year}-${localParts.month}-${localParts.day}T` +
        `${localParts.hour}:${localParts.minute}:${localParts.second}`
    );
    const localTarget = new Date(
        `${localParts.year}-${localParts.month}-${localParts.day}T` +
        `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`
    );

    // If target time already passed today, schedule for tomorrow
    if (localTarget <= localNow) {
        localTarget.setDate(localTarget.getDate() + 1);
    }

    // Convert local target time to UTC
    // The offset between localTarget and UTC depends on the timezone
    const utcTarget = new Date(localTarget.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzTarget = new Date(localTarget.toLocaleString('en-US', { timeZone: timezone }));
    const offsetMs = utcTarget - tzTarget;

    return new Date(localTarget.getTime() + offsetMs);
}

/**
 * Schedule a daily check-in job for a patient.
 * Called when a patient enters DAILY_ACTIVE state.
 */
async function scheduleDailyCheckin(patientId, preferredTime, timezone) {
    const jitter = generateJitter();
    const scheduledFor = nextOccurrence(preferredTime, timezone);

    // Add jitter
    scheduledFor.setSeconds(scheduledFor.getSeconds() + jitter);

    const { data, error } = await supabase
        .from('scheduled_jobs')
        .insert({
            patient_id: patientId,
            job_type: 'DAILY_CHECKIN',
            scheduled_for: scheduledFor.toISOString(),
            jitter_seconds: jitter,
            recurrence: 'daily',
            payload: { preferred_time: preferredTime, timezone },
        })
        .select()
        .single();

    if (error) {
        console.error('Failed to schedule daily checkin:', error);
        throw error;
    }

    return data;
}

/**
 * Schedule a one-shot job (insight, weekly question, etc.)
 */
async function scheduleOneShot(patientId, jobType, scheduledFor, payload = {}) {
    const { data, error } = await supabase
        .from('scheduled_jobs')
        .insert({
            patient_id: patientId,
            job_type: jobType,
            scheduled_for: scheduledFor.toISOString(),
            jitter_seconds: 0,
            recurrence: null,
            payload,
        })
        .select()
        .single();

    if (error) {
        console.error(`Failed to schedule ${jobType}:`, error);
        throw error;
    }

    return data;
}

/**
 * Get all jobs that are due for processing.
 * Called by the /api/cron/dispatch endpoint every minute.
 * 
 * Uses SELECT ... FOR UPDATE SKIP LOCKED to prevent double-processing
 * if the cron fires twice.
 */
async function getDueJobs(limit = 50) {
    // Use a raw query for SKIP LOCKED (not available via Supabase client)
    const { data, error } = await supabase.rpc('get_and_lock_due_jobs', {
        job_limit: limit,
    });

    if (error) {
        console.error('Failed to get due jobs:', error);
        return [];
    }

    return data || [];
}

/**
 * Mark a job as successfully completed and schedule the next occurrence
 * if it's a recurring job.
 */
async function markJobCompleted(jobId) {
    const { data: job, error } = await supabase
        .from('scheduled_jobs')
        .update({
            status: 'COMPLETED',
            processed_at: new Date().toISOString(),
        })
        .eq('job_id', jobId)
        .select()
        .single();

    if (error) {
        console.error('Failed to mark job completed:', error);
        return null;
    }

    // If recurring, schedule the next one
    if (job.recurrence === 'daily' && job.payload?.preferred_time) {
        await scheduleDailyCheckin(
            job.patient_id,
            job.payload.preferred_time,
            job.payload.timezone || 'America/New_York'
        );
    }

    return job;
}

/**
 * Mark a job as failed with error detail. Retries up to max_attempts.
 */
async function markJobFailed(jobId, errorMessage) {
    // Get current attempt count
    const { data: job } = await supabase
        .from('scheduled_jobs')
        .select('attempts, max_attempts, patient_id, job_type, scheduled_for, payload, recurrence')
        .eq('job_id', jobId)
        .single();

    if (!job) return null;

    const newAttempts = (job.attempts || 0) + 1;

    if (newAttempts < job.max_attempts) {
        // Retry: set back to PENDING with a 5-minute backoff
        const retryAt = new Date(Date.now() + 5 * 60 * 1000);
        await supabase
            .from('scheduled_jobs')
            .update({
                status: 'PENDING',
                attempts: newAttempts,
                last_error: errorMessage,
                scheduled_for: retryAt.toISOString(),
            })
            .eq('job_id', jobId);
    } else {
        // Max retries exceeded: mark as failed permanently
        await supabase
            .from('scheduled_jobs')
            .update({
                status: 'FAILED',
                attempts: newAttempts,
                last_error: errorMessage,
                processed_at: new Date().toISOString(),
            })
            .eq('job_id', jobId);
    }
}

/**
 * Cancel all pending jobs for a patient.
 * Called on PAUSE or STOP.
 */
async function cancelPatientJobs(patientId) {
    const { data, error } = await supabase
        .from('scheduled_jobs')
        .update({
            status: 'CANCELLED',
            processed_at: new Date().toISOString(),
        })
        .eq('patient_id', patientId)
        .eq('status', 'PENDING')
        .select();

    if (error) {
        console.error('Failed to cancel patient jobs:', error);
    }

    return data || [];
}

module.exports = {
    scheduleDailyCheckin,
    scheduleOneShot,
    getDueJobs,
    markJobCompleted,
    markJobFailed,
    cancelPatientJobs,
    nextOccurrence,
    generateJitter,
};

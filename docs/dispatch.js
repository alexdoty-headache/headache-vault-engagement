/**
 * Cron Dispatch Handler
 * 
 * POST /api/cron/dispatch
 * 
 * Called every minute by Vercel Cron (or pg_cron via pg_net).
 * This is the outbound message pump — it processes all due scheduled
 * jobs and sends the appropriate SMS messages.
 * 
 * Pipeline (per SMS Implementation Spec §2.3, §6):
 *   1. Authenticate request (cron secret or Vercel Cron header)
 *   2. Call get_and_lock_due_jobs() — atomic SELECT FOR UPDATE SKIP LOCKED
 *   3. For each job, look up patient state and run job-type-specific logic
 *   4. Mark completed and reschedule recurring jobs (or mark failed with retry)
 * 
 * Job types handled:
 *   - DAILY_CHECKIN: Send D-1, check for proactive response, update missed count
 *   - WEEKLY_QUESTION: Send W-1/W-2/W-3 based on week rotation
 *   - INSIGHT: Send I-5/I-10/I-14/I-21/I-30 (queued by response handler)
 *   - RE_ENGAGEMENT: Send D-RE3 or D-RE5 based on consecutive_missed
 *   - TRANSITION: Send T-1 day 30 options
 *   - ONBOARD_REMINDER: Re-send O-1 if no START reply after 24h
 * 
 * Concurrency safety: get_and_lock_due_jobs uses SKIP LOCKED, so if
 * the cron fires twice (overlap), the second invocation sees no jobs.
 * 
 * Target: process all jobs in <10 seconds for 50 patients.
 */

const { supabase } = require('../../lib/supabase');
const { sendSMS } = require('../../lib/twilio');
const { getDueJobs, markJobCompleted, markJobFailed } = require('../../lib/services/scheduler');
const { getPatientState, transitionState } = require('../../lib/state-machine/transitions');
const { cancelPatientJobs, scheduleOneShot } = require('../../lib/services/scheduler');
const { render } = require('../../lib/templates');

// ============================================================================
// MAIN HANDLER
// ============================================================================

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // --- Authenticate ---
    if (!authenticateRequest(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const startTime = Date.now();

    try {
        // --- Fetch due jobs (atomic lock) ---
        const jobs = await getDueJobs(50);

        if (jobs.length === 0) {
            return res.status(200).json({ processed: 0, ms: Date.now() - startTime });
        }

        // --- Process each job ---
        const results = await Promise.allSettled(
            jobs.map(job => processJob(job))
        );

        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected').length;

        const ms = Date.now() - startTime;
        if (ms > 10000) {
            console.warn(`SLOW DISPATCH: ${ms}ms for ${jobs.length} jobs`);
        }

        return res.status(200).json({
            processed: jobs.length,
            succeeded,
            failed,
            ms,
        });

    } catch (error) {
        console.error('Cron dispatch error:', error);
        return res.status(500).json({ error: 'Dispatch failed' });
    }
};

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Verify the request came from Vercel Cron or pg_cron.
 * 
 * Vercel Cron: sets the x-vercel-cron header automatically (no secret needed).
 * pg_cron: sends Authorization: Bearer <CRON_SECRET>.
 * Dev: skip auth if NODE_ENV === 'development'.
 */
function authenticateRequest(req) {
    if (process.env.NODE_ENV === 'development') return true;

    // Vercel Cron sets this header automatically
    if (req.headers['x-vercel-cron'] === '1') return true;

    // pg_cron sends Bearer token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader === `Bearer ${process.env.CRON_SECRET}`) return true;

    return false;
}

// ============================================================================
// JOB PROCESSOR
// ============================================================================

/**
 * Process a single scheduled job.
 * Looks up patient state, runs job-type-specific logic, marks complete/failed.
 */
async function processJob(job) {
    try {
        // Look up patient (always fresh from DB, never cached)
        const patient = await getPatientState(job.patient_id);

        if (!patient) {
            await markJobFailed(job.job_id, `Patient not found: ${job.patient_id}`);
            return;
        }

        // Route to job-type handler
        const handler = JOB_HANDLERS[job.job_type];
        if (!handler) {
            await markJobFailed(job.job_id, `Unknown job type: ${job.job_type}`);
            return;
        }

        await handler(job, patient);

        // Mark completed (also reschedules if recurring)
        await markJobCompleted(job.job_id);

    } catch (error) {
        console.error(`Job ${job.job_id} (${job.job_type}) failed:`, error.message);
        await markJobFailed(job.job_id, error.message);
    }
}

// ============================================================================
// JOB TYPE HANDLERS
// ============================================================================

const JOB_HANDLERS = {
    DAILY_CHECKIN: handleDailyCheckin,
    WEEKLY_QUESTION: handleWeeklyQuestion,
    INSIGHT: handleInsight,
    RE_ENGAGEMENT: handleReEngagement,
    TRANSITION: handleTransition,
    ONBOARD_REMINDER: handleOnboardReminder,
    REPORT_GENERATION: handleReportGeneration,
};

/**
 * DAILY_CHECKIN: Send the daily "How's your head today?" message.
 * 
 * Per spec §6.2 decision tree:
 *   1. Check patient is still DAILY_ACTIVE (skip if stale)
 *   2. Check for proactive response (patient texted before prompt)
 *   3. Send D-1 check-in
 *   4. Check if weekly question is due → queue for next day
 *   5. Check consecutive_missed → queue re-engagement if needed
 */
async function handleDailyCheckin(job, patient) {
    // Guard: only process for DAILY_ACTIVE patients
    if (patient.state !== 'DAILY_ACTIVE') {
        console.log(`Skipping DAILY_CHECKIN for patient ${patient.patient_id}: state is ${patient.state}`);
        return;
    }

    // Check if patient already responded today (proactive response)
    const today = new Date().toISOString().split('T')[0];
    const { data: existingEntry } = await supabase
        .from('daily_entries')
        .select('entry_id')
        .eq('patient_id', patient.patient_id)
        .eq('entry_date', today)
        .eq('is_missed', false)
        .limit(1)
        .single();

    if (existingEntry) {
        // Patient already responded today — skip the prompt
        console.log(`Skipping DAILY_CHECKIN for ${patient.patient_id}: already responded today`);
        return;
    }

    // Send D-1 daily check-in
    await sendSMS(
        patient.patient_id,
        patient.phone_number,
        render('D-1', { firstName: patient.first_name }),
        'D-1'
    );

    // Check if a weekly context question is due
    // Rotation: W-1 at day 7, W-2 at day 14, W-3 at day 21, W-1 at day 28
    const dayCount = patient.day_count + 1;  // +1 because today's entry isn't recorded yet
    await checkWeeklyQuestionDue(patient, dayCount);

    // Check consecutive missed days for re-engagement
    await checkMissedDays(patient);
}

/**
 * WEEKLY_QUESTION: Send a weekly context question (W-1, W-2, or W-3).
 * Payload should contain: { questionType: 'ACUTE_MEDS' | 'MISSED_ACTIVITIES' | 'TRIGGERS', weekNumber }
 */
async function handleWeeklyQuestion(job, patient) {
    if (patient.state !== 'DAILY_ACTIVE') return;

    const { questionType, weekNumber } = job.payload;

    const templateMap = {
        'ACUTE_MEDS': 'W-1',
        'MISSED_ACTIVITIES': 'W-2',
        'TRIGGERS': 'W-3',
    };

    const templateId = templateMap[questionType];
    if (!templateId) {
        throw new Error(`Unknown weekly question type: ${questionType}`);
    }

    // Get active sprint
    const { data: sprint } = await supabase
        .from('sprints')
        .select('sprint_id')
        .eq('patient_id', patient.patient_id)
        .eq('status', 'ACTIVE')
        .single();

    if (!sprint) return;

    // Insert the weekly_entries row (asked, not yet responded)
    await supabase
        .from('weekly_entries')
        .insert({
            patient_id: patient.patient_id,
            sprint_id: sprint.sprint_id,
            question_type: questionType,
            week_number: weekNumber,
            asked_at: new Date().toISOString(),
        });

    // Set pending question so the state handler routes the response correctly
    await supabase
        .from('patients')
        .update({ pending_question: 'WEEKLY_RESPONSE' })
        .eq('patient_id', patient.patient_id);

    // Send the question
    await sendSMS(
        patient.patient_id,
        patient.phone_number,
        render(templateId),
        templateId
    );
}

/**
 * INSIGHT: Send an insight reflection message.
 * 
 * Per spec §6.3: Insights are queued for immediate send after the patient
 * responds to the triggering daily check-in. The response handler in
 * state-handlers.js queues this job; we just send it.
 * 
 * Payload: { templateId: 'I-5' | 'I-10' | 'I-14' | 'I-21' | 'I-30', templateData: {...} }
 */
async function handleInsight(job, patient) {
    const { templateId, templateData } = job.payload;

    if (!templateId) {
        throw new Error('INSIGHT job missing templateId in payload');
    }

    await sendSMS(
        patient.patient_id,
        patient.phone_number,
        render(templateId, templateData || {}),
        templateId
    );
}

/**
 * RE_ENGAGEMENT: Send a re-engagement message based on consecutive missed days.
 * 
 * Payload: { type: 'D-RE3' | 'D-RE5' }
 * 
 * D-RE3: gentle nudge at 3 consecutive missed days
 * D-RE5: pause notification at 5 consecutive missed days (also transitions to PAUSED)
 */
async function handleReEngagement(job, patient) {
    const { type } = job.payload;

    if (type === 'D-RE5') {
        // 5+ missed: transition to PAUSED and cancel further jobs
        await transitionState(
            patient.patient_id,
            'PAUSED',
            'SYSTEM_TIMER',
            `5 consecutive missed days (consecutive_missed: ${patient.consecutive_missed})`
        );
        await cancelPatientJobs(patient.patient_id);

        await sendSMS(
            patient.patient_id,
            patient.phone_number,
            render('D-RE5', { firstName: patient.first_name }),
            'D-RE5'
        );
    } else {
        // D-RE3: gentle nudge, keep daily active
        await sendSMS(
            patient.patient_id,
            patient.phone_number,
            render('D-RE3', { firstName: patient.first_name }),
            'D-RE3'
        );
    }
}

/**
 * TRANSITION: Send the day 30 transition message (T-1).
 * This is queued by the response handler when day_count reaches 30.
 */
async function handleTransition(job, patient) {
    await sendSMS(
        patient.patient_id,
        patient.phone_number,
        render('T-1', { firstName: patient.first_name }),
        'T-1'
    );
}

/**
 * ONBOARD_REMINDER: Re-send welcome message if patient hasn't replied START.
 * Only fires if patient is still in ENROLLED state after 24h.
 */
async function handleOnboardReminder(job, patient) {
    if (patient.state !== 'ENROLLED') return;

    const templateId = patient.pcp_provider_id ? 'O-1-PCP' : 'O-1-SELF';
    const templateData = {
        firstName: patient.first_name,
    };

    // For PCP-initiated, we need the provider name
    if (patient.pcp_provider_id) {
        const { data: provider } = await supabase
            .from('providers')
            .select('provider_name')
            .eq('provider_id', patient.pcp_provider_id)
            .single();

        templateData.pcpName = provider?.provider_name || 'your doctor';
    }

    await sendSMS(
        patient.patient_id,
        patient.phone_number,
        render(templateId, templateData),
        templateId
    );
}

/**
 * REPORT_GENERATION: Generate a Visit Ready Report.
 * Phase 1: placeholder — actual generation is in a separate module.
 */
async function handleReportGeneration(job, patient) {
    // TODO: Implement report generation (HTML + Puppeteer PDF)
    console.log(`Report generation queued for patient ${patient.patient_id} — not yet implemented`);
}

// ============================================================================
// HELPER: Weekly Question Scheduling
// ============================================================================

/**
 * Check if a weekly context question should be queued.
 * 
 * Rotation per SMS Flow Spec §4.1:
 *   Day 7  → W-1 (Acute meds)
 *   Day 14 → W-2 (Missed activities)
 *   Day 21 → W-3 (Triggers)
 *   Day 28 → W-1 (Acute meds repeat)
 * 
 * The question is scheduled for the NEXT DAY after the trigger day,
 * to avoid combining two questions in one message.
 */
async function checkWeeklyQuestionDue(patient, dayCount) {
    const weeklySchedule = {
        7: { questionType: 'ACUTE_MEDS', weekNumber: 1 },
        14: { questionType: 'MISSED_ACTIVITIES', weekNumber: 2 },
        21: { questionType: 'TRIGGERS', weekNumber: 3 },
        28: { questionType: 'ACUTE_MEDS', weekNumber: 4 },
    };

    const schedule = weeklySchedule[dayCount];
    if (!schedule) return;

    // Schedule for tomorrow at the patient's preferred time
    // (the scheduler's nextOccurrence handles timezone conversion)
    const { nextOccurrence } = require('../../lib/services/scheduler');
    const scheduledFor = nextOccurrence(
        patient.preferred_time,
        patient.timezone || 'America/New_York'
    );

    await scheduleOneShot(patient.patient_id, 'WEEKLY_QUESTION', scheduledFor, {
        questionType: schedule.questionType,
        weekNumber: schedule.weekNumber,
    });
}

// ============================================================================
// HELPER: Missed Day Detection
// ============================================================================

/**
 * Check consecutive missed days and queue re-engagement if needed.
 * 
 * Per SMS Flow Spec §3.3:
 *   1 missed: nothing
 *   2 missed: nothing
 *   3 missed: send D-RE3 (gentle nudge)
 *   5 missed: send D-RE5 (pause notification) → transition to PAUSED
 * 
 * We only check this during the daily dispatch, not in the nightly
 * missed-days detector (which handles marking entries as missed).
 */
async function checkMissedDays(patient) {
    const missed = patient.consecutive_missed || 0;

    if (missed === 3) {
        // Check we haven't already sent a D-RE3 recently
        const { data: recentRE } = await supabase
            .from('messages')
            .select('message_id')
            .eq('patient_id', patient.patient_id)
            .eq('template_id', 'D-RE3')
            .gte('sent_at', new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString())
            .limit(1)
            .single();

        if (!recentRE) {
            await scheduleOneShot(patient.patient_id, 'RE_ENGAGEMENT', new Date(), {
                type: 'D-RE3',
            });
        }
    }

    if (missed >= 5) {
        const { data: recentRE5 } = await supabase
            .from('messages')
            .select('message_id')
            .eq('patient_id', patient.patient_id)
            .eq('template_id', 'D-RE5')
            .gte('sent_at', new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString())
            .limit(1)
            .single();

        if (!recentRE5) {
            await scheduleOneShot(patient.patient_id, 'RE_ENGAGEMENT', new Date(), {
                type: 'D-RE5',
            });
        }
    }
}

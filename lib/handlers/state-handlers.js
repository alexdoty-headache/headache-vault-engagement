/**
 * State Handlers
 * 
 * Each function handles an inbound message for a patient in a specific state.
 * The webhook router calls the appropriate handler based on patient.state.
 * 
 * Every handler receives the same arguments:
 *   - patient: full patient row from DB
 *   - messageBody: cleaned inbound text
 *   - twilioSid: Twilio message SID (for logging)
 * 
 * Every handler returns: { reply: string, templateId: string }
 * (or an array of replies for multi-message responses)
 * 
 * Side effects (state transitions, DB writes) happen inside the handler.
 * The webhook endpoint handles sending the reply SMS.
 * 
 * Source: SMS Flow Spec §2-§10, SMS Implementation Spec §3
 */

const { supabase } = require('../supabase');
const { transitionState } = require('../state-machine/transitions');
const { scheduleDailyCheckin, cancelPatientJobs, scheduleOneShot } = require('../services/scheduler');
const { render, getNextAck } = require('../templates');
const { parseTime } = require('../utils/parse-time');
const { parseResponse } = require('../ai/parser');

// ============================================================================
// ENROLLED — Waiting for START
// ============================================================================

async function handleEnrolled(patient, messageBody) {
    const text = messageBody.toUpperCase().trim();

    if (text === 'START') {
        await transitionState(
            patient.patient_id,
            'ONBOARDING',
            'PATIENT_RESPONSE',
            'START reply',
            { pending_question: 'ONBOARD_TIME' }
        );

        return { reply: render('O-2'), templateId: 'O-2' };
    }

    // Anything else in ENROLLED: send the welcome again with a nudge
    return {
        reply: render('ERR-ONBOARDING'),
        templateId: 'ERR-ONBOARDING',
    };
}

// ============================================================================
// ONBOARDING — Collecting preferences
// ============================================================================

async function handleOnboarding(patient, messageBody) {
    const pending = patient.pending_question;

    // --- O-2: Time selection ---
    if (pending === 'ONBOARD_TIME') {
        return await handleTimeSelection(patient, messageBody);
    }

    // --- O-3: Appointment date ---
    if (pending === 'ONBOARD_APPT') {
        return await handleAppointmentDate(patient, messageBody);
    }

    // --- O-4: Medication history Y/N ---
    if (pending === 'MED_HISTORY_YN') {
        return await handleMedHistoryYesNo(patient, messageBody);
    }

    // --- O-4: Medication list ---
    if (pending === 'MED_HISTORY_LIST') {
        return await handleMedHistoryList(patient, messageBody);
    }

    // --- O-4: Discontinuation reason for a specific med ---
    if (pending === 'MED_HISTORY_REASON') {
        return await handleMedHistoryReason(patient, messageBody);
    }

    // Fallback
    return { reply: render('ERR-ONBOARDING'), templateId: 'ERR-ONBOARDING' };
}

/**
 * O-2 handler: Patient tells us their preferred check-in time.
 */
async function handleTimeSelection(patient, messageBody) {
    const parsed = parseTime(messageBody);

    if (!parsed) {
        return {
            reply: `I didn't catch a time from that. Try replying with something like "8am" or "9pm".`,
            templateId: 'ERR-ONBOARDING',
        };
    }

    // Determine next pending question and what O-3 variant to send
    let nextPending;
    let templateId;
    let templateData;

    if (patient.appointment_date) {
        // PCP-initiated enrollment: we already have the appointment date
        nextPending = null;
        templateId = 'O-3-WITH-APPT';
        templateData = {
            time: parsed.display,
            appointmentDate: formatDate(patient.appointment_date),
        };
    } else {
        // Self-service: ask for appointment date
        nextPending = 'ONBOARD_APPT';
        templateId = 'O-3-ASK-APPT';
        templateData = { time: parsed.display };
    }

    // Transition to DAILY_ACTIVE (or stay in ONBOARDING if asking for appointment)
    if (nextPending) {
        // Stay in ONBOARDING, just update time and pending question
        await supabase
            .from('patients')
            .update({
                preferred_time: parsed.time24,
                pending_question: nextPending,
            })
            .eq('patient_id', patient.patient_id);
    } else {
        // We have everything — go to DAILY_ACTIVE
        await activatePatient(patient, parsed);
    }

    return { reply: render(templateId, templateData), templateId };
}

/**
 * O-3 handler: Patient provides appointment date or says NO.
 */
async function handleAppointmentDate(patient, messageBody) {
    const text = messageBody.trim().toUpperCase();

    let appointmentDate = null;

    if (text !== 'NO' && text !== 'N' && text !== 'NONE' && text !== 'NOPE') {
        // Try to parse a date
        appointmentDate = parseFuzzyDate(messageBody);

        if (!appointmentDate) {
            return {
                reply: `I didn't catch a date from that. Reply with a date like "March 15" or "3/15", or reply NO if you don't have one.`,
                templateId: 'ERR-ONBOARDING',
            };
        }
    }

    // Read the time we already saved
    const parsed = {
        time24: patient.preferred_time,
        display: formatTime12(patient.preferred_time),
    };

    // Activate the patient
    const extraUpdates = {};
    if (appointmentDate) {
        extraUpdates.appointment_date = appointmentDate;
    }

    await activatePatient(patient, parsed, extraUpdates);

    return {
        reply: render('O-3-CONFIRMED', { time: parsed.display }),
        templateId: 'O-3-CONFIRMED',
    };
}

/**
 * O-4 Y/N: "Have you ever taken a daily prevention medication?"
 */
async function handleMedHistoryYesNo(patient, messageBody) {
    const text = messageBody.trim().toUpperCase();

    if (text === 'NO' || text === 'N' || text === 'NOT SURE' || text === 'UNSURE') {
        // Done with onboarding medication questions
        await supabase
            .from('patients')
            .update({ pending_question: null })
            .eq('patient_id', patient.patient_id);

        return {
            reply: `No problem — we can always add that later. You're all set! Your daily check-ins are running.`,
            templateId: 'O-4-DONE',
        };
    }

    if (text === 'YES' || text === 'Y' || text === 'YEAH') {
        await supabase
            .from('patients')
            .update({ pending_question: 'MED_HISTORY_LIST' })
            .eq('patient_id', patient.patient_id);

        return { reply: render('O-4-LIST'), templateId: 'O-4-LIST' };
    }

    return { reply: render('ERR-ONBOARDING'), templateId: 'ERR-ONBOARDING' };
}

/**
 * O-4 List: Patient lists medications they've tried.
 * For Phase 1, we store the raw text and queue it for AI parsing.
 * The AI parser runs async — we don't block the conversation.
 */
async function handleMedHistoryList(patient, messageBody) {
    // Store raw medication text
    await supabase
        .from('medication_history')
        .insert({
            patient_id: patient.patient_id,
            medication_raw: messageBody.trim(),
            status: 'UNKNOWN',  // AI parser will update this
        });

    // For now, just acknowledge. Phase 1: AI parser processes this
    // asynchronously and may follow up later for disambiguation.
    // Future: parse inline and ask about each medication.
    await supabase
        .from('patients')
        .update({ pending_question: null })
        .eq('patient_id', patient.patient_id);

    return {
        reply: `Got it, thanks — we've recorded that. This will help make your report more useful for your doctor. Your daily check-ins are running!`,
        templateId: 'O-4-DONE',
    };
}

/**
 * O-4 Reason: Why did you stop [medication]? (1-5)
 * Phase 2: iterates through each medication. Phase 1: simplified.
 */
async function handleMedHistoryReason(patient, messageBody) {
    // Phase 2 implementation
    await supabase
        .from('patients')
        .update({ pending_question: null })
        .eq('patient_id', patient.patient_id);

    return {
        reply: `Got it, thanks for sharing that.`,
        templateId: 'O-4-DONE',
    };
}

// ============================================================================
// DAILY_ACTIVE — Core 30-day tracking
// ============================================================================

async function handleDailyActive(patient, messageBody) {
    const pending = patient.pending_question;

    // If we sent a weekly question and are waiting for that response
    if (pending === 'WEEKLY_RESPONSE') {
        return await handleWeeklyResponse(patient, messageBody);
    }

    // If we sent a clarification and are waiting for a clean number
    if (pending === 'CLARIFY_LEVEL') {
        return await handleClarifyLevel(patient, messageBody);
    }

    // If O-4 medication history is pending (asked after first check-in)
    if (pending === 'MED_HISTORY_YN' || pending === 'MED_HISTORY_LIST' || pending === 'MED_HISTORY_REASON') {
        return await handleOnboarding(patient, messageBody);
    }

    // --- Parse the daily check-in response via the AI pipeline ---
    // parseResponse handles the full decision tree:
    //   1. Numeric "1"-"5" → NUMERIC method, ACCEPT action
    //   2. Natural language → Claude Haiku → AI_PARSED method
    //   3. If API down → regex fallback → REGEX_FALLBACK method
    //   4. Unparseable → null
    const parsed = await parseResponse(messageBody);

    if (!parsed) {
        // Completely unparseable — send full scale re-prompt
        return { reply: render('ERR-DAILY'), templateId: 'ERR-DAILY' };
    }

    // Route based on the parser's action decision
    switch (parsed.action) {
        case 'ACCEPT': {
            // High confidence or numeric — record directly
            const method = parsed.method === 'NUMERIC' ? 'NUMERIC' : 'AI_PARSED';
            return await recordDailyResponse(
                patient,
                parsed.level,
                messageBody,
                method,
                parsed.confidence
            );
        }

        case 'CLARIFY': {
            // Medium confidence — ask the patient to confirm
            await supabase
                .from('patients')
                .update({ pending_question: 'CLARIFY_LEVEL' })
                .eq('patient_id', patient.patient_id);

            return {
                reply: render('CLARIFY-LEVEL', { parsedLevel: parsed.level }),
                templateId: 'CLARIFY-LEVEL',
            };
        }

        case 'REPROMPT': {
            // Low confidence — send the full 1-5 scale
            return { reply: render('ERR-DAILY'), templateId: 'ERR-DAILY' };
        }

        default:
            return { reply: render('ERR-DAILY'), templateId: 'ERR-DAILY' };
    }
}

/**
 * Handle a confirmed clarification (patient sends 1-5 after CLARIFY-LEVEL).
 */
async function handleClarifyLevel(patient, messageBody) {
    const level = parseNumericLevel(messageBody);

    if (!level) {
        return { reply: render('ERR-DAILY'), templateId: 'ERR-DAILY' };
    }

    return await recordDailyResponse(patient, level, messageBody, 'CLARIFIED', 1.0);
}

/**
 * Record a daily check-in response.
 * This is the core write path: stores the entry, sends ack, checks triggers.
 */
async function recordDailyResponse(patient, level, rawText, method, confidence) {
    // Get active sprint
    const { data: sprint } = await supabase
        .from('sprints')
        .select('*')
        .eq('patient_id', patient.patient_id)
        .eq('status', 'ACTIVE')
        .single();

    if (!sprint) {
        console.error(`No active sprint for patient ${patient.patient_id}`);
        return { reply: render('ERR-DAILY'), templateId: 'ERR-DAILY' };
    }

    const dayNumber = patient.day_count + 1;
    const today = new Date().toISOString().split('T')[0];

    // Get last ack template for rotation
    const { data: lastEntry } = await supabase
        .from('daily_entries')
        .select('acknowledgment_template')
        .eq('patient_id', patient.patient_id)
        .eq('sprint_id', sprint.sprint_id)
        .order('entry_date', { ascending: false })
        .limit(1)
        .single();

    const ackTemplate = getNextAck(lastEntry?.acknowledgment_template || null);

    // Find the prompt_sent_at for today's check-in
    const { data: todayPrompt } = await supabase
        .from('messages')
        .select('sent_at')
        .eq('patient_id', patient.patient_id)
        .eq('template_id', 'D-1')
        .order('sent_at', { ascending: false })
        .limit(1)
        .single();

    // Write the entry via RPC (atomic: updates sprint + patient counts)
    await supabase.rpc('record_daily_entry', {
        p_patient_id: patient.patient_id,
        p_sprint_id: sprint.sprint_id,
        p_entry_date: today,
        p_hv_fis_level: level,
        p_response_raw: method !== 'NUMERIC' ? rawText : null,
        p_response_method: method,
        p_ai_confidence: confidence,
        p_prompt_sent_at: todayPrompt?.sent_at || new Date().toISOString(),
        p_response_received_at: new Date().toISOString(),
        p_day_number: Math.min(dayNumber, 30),
        p_ack_template: ackTemplate,
    });

    // Clear any pending question
    await supabase
        .from('patients')
        .update({ pending_question: null })
        .eq('patient_id', patient.patient_id);

    // Build reply: ack + possible insight or first-day med history prompt
    const replies = [];

    // Acknowledgment
    replies.push({ reply: render(ackTemplate), templateId: ackTemplate });

    // Day 1: prompt medication history (O-4) after first check-in
    if (dayNumber === 1) {
        await supabase
            .from('patients')
            .update({ pending_question: 'MED_HISTORY_YN' })
            .eq('patient_id', patient.patient_id);

        replies.push({ reply: render('O-4-ASK'), templateId: 'O-4-ASK' });
    }

    // Check insight triggers (days 5, 10, 14, 21, 30)
    const insightResult = await checkInsightTrigger(patient, sprint, dayNumber);
    if (insightResult) {
        replies.push(insightResult);
    }

    // Check day 30 transition
    if (dayNumber >= 30) {
        await triggerTransition(patient, sprint);
    }

    return replies.length === 1 ? replies[0] : replies;
}

// ============================================================================
// PAUSED — Waiting for re-engagement
// ============================================================================

async function handlePaused(patient, messageBody) {
    const text = messageBody.trim().toUpperCase();

    // Any 1-5 response or YES/START resumes tracking
    const numericLevel = parseNumericLevel(messageBody);
    if (numericLevel || text === 'YES' || text === 'START' || text === 'Y') {
        // Resume daily active
        await transitionState(
            patient.patient_id,
            'DAILY_ACTIVE',
            'PATIENT_RESPONSE',
            `Resumed from PAUSED: "${messageBody}"`
        );

        // Re-schedule daily check-ins
        if (patient.preferred_time) {
            await scheduleDailyCheckin(
                patient.patient_id,
                patient.preferred_time,
                patient.timezone || 'America/New_York'
            );
        }

        // If they sent a level, record it too
        if (numericLevel) {
            const result = await recordDailyResponse(patient, numericLevel, messageBody, 'NUMERIC', 1.0);
            return result;
        }

        return {
            reply: `Welcome back! We'll pick up where you left off. Your next check-in will be at your usual time.`,
            templateId: 'SYS-RESUME',
        };
    }

    // Anything else in PAUSED: gentle reminder
    return {
        reply: `You're currently paused. Reply YES or a number (1-5) to resume tracking, or STOP to unsubscribe.`,
        templateId: 'SYS-PAUSED-INFO',
    };
}

// ============================================================================
// TRANSITION — Day 30 complete, presenting options
// ============================================================================

async function handleTransition(patient, messageBody) {
    const text = messageBody.trim();

    if (text === '1') {
        // Weekly monitoring — Phase 2
        await transitionState(
            patient.patient_id, 'DORMANT', 'PATIENT_RESPONSE',
            'Selected weekly monitoring (deferred to Phase 2)'
        );
        return {
            reply: `Weekly check-ins are coming soon! For now, your report is saved and your data is available anytime. We'll reach out when weekly mode launches.\n\nReply START anytime to do another 30-day sprint.`,
            templateId: 'T-1-WEEKLY-DEFER',
        };
    }

    if (text === '2') {
        // Treatment monitoring — Phase 2
        await transitionState(
            patient.patient_id, 'DORMANT', 'PATIENT_RESPONSE',
            'Selected treatment monitoring (deferred to Phase 2)'
        );
        return {
            reply: `Treatment tracking is coming soon! For now, your baseline report is saved — it'll be the comparison when treatment monitoring launches.\n\nReply START anytime to do another 30-day sprint.`,
            templateId: 'T-1-TREATMENT-DEFER',
        };
    }

    if (text === '3') {
        // Pause / done
        await transitionState(
            patient.patient_id, 'DORMANT', 'PATIENT_RESPONSE',
            'Selected pause after transition'
        );
        await cancelPatientJobs(patient.patient_id);

        return {
            reply: `No problem. Your report and data are saved. Reply START anytime if you want to do another tracking sprint.\n\nThanks for tracking with us! 🙏`,
            templateId: 'T-1-DORMANT',
        };
    }

    // Invalid option
    return { reply: render('T-1', { firstName: patient.first_name }), templateId: 'T-1' };
}

// ============================================================================
// DORMANT — Inactive, can self-reactivate
// ============================================================================

async function handleDormant(patient, messageBody) {
    const text = messageBody.trim().toUpperCase();

    if (text === 'START') {
        // Start a new sprint
        const { data: newSprint } = await supabase
            .from('sprints')
            .insert({
                patient_id: patient.patient_id,
                sprint_type: 'INITIAL',
                start_date: new Date().toISOString().split('T')[0],
            })
            .select()
            .single();

        await transitionState(
            patient.patient_id, 'DAILY_ACTIVE', 'PATIENT_RESPONSE',
            'Self-reactivated from DORMANT',
            { day_count: 0, consecutive_missed: 0, sprint_start_date: newSprint?.start_date }
        );

        if (patient.preferred_time) {
            await scheduleDailyCheckin(
                patient.patient_id,
                patient.preferred_time,
                patient.timezone || 'America/New_York'
            );
        }

        return {
            reply: `Welcome back! A new 30-day tracking sprint starts now. Your first check-in comes tomorrow at ${formatTime12(patient.preferred_time)}.`,
            templateId: 'SYS-REACTIVATE',
        };
    }

    return {
        reply: `Hi! You're not currently tracking. Reply START to begin a new 30-day sprint, or HELP for options.`,
        templateId: 'SYS-DORMANT-INFO',
    };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse a clean numeric 1-5 from patient text.
 * Handles: "3", " 3 ", "3.", "level 3", "#3"
 */
function parseNumericLevel(text) {
    const cleaned = text.trim().replace(/[.#]/g, '').replace(/^level\s*/i, '').trim();
    const num = parseInt(cleaned, 10);
    if (num >= 1 && num <= 5 && cleaned === String(num)) {
        return num;
    }
    return null;
}

/**
 * Activate a patient: transition to DAILY_ACTIVE, create sprint, schedule check-ins.
 */
async function activatePatient(patient, parsedTime, extraUpdates = {}) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const startDate = tomorrow.toISOString().split('T')[0];

    // Create the sprint
    const { data: sprint } = await supabase
        .from('sprints')
        .insert({
            patient_id: patient.patient_id,
            sprint_type: 'INITIAL',
            start_date: startDate,
        })
        .select()
        .single();

    // Transition state
    await transitionState(
        patient.patient_id,
        'DAILY_ACTIVE',
        'PATIENT_RESPONSE',
        `Time selected: ${parsedTime.display}`,
        {
            preferred_time: parsedTime.time24,
            pending_question: null,
            sprint_start_date: startDate,
            day_count: 0,
            consecutive_missed: 0,
            ...extraUpdates,
        }
    );

    // Schedule the first check-in
    await scheduleDailyCheckin(
        patient.patient_id,
        parsedTime.time24,
        patient.timezone || 'America/New_York'
    );
}

/**
 * Check if an insight should be sent based on day number.
 * Returns a reply object if an insight is due, null otherwise.
 */
async function checkInsightTrigger(patient, sprint, dayNumber) {
    const insightDays = { 5: 'I-5', 10: 'I-10', 14: 'I-14', 21: 'I-21', 30: 'I-30' };
    const templateId = insightDays[dayNumber];
    if (!templateId) return null;

    // Compute insight data from sprint entries
    const { data: entries } = await supabase
        .from('daily_entries')
        .select('hv_fis_level')
        .eq('sprint_id', sprint.sprint_id)
        .eq('is_missed', false);

    if (!entries || entries.length === 0) return null;

    const totalDays = entries.length;
    const headacheDays = entries.filter(e => e.hv_fis_level >= 2).length;
    const headacheFreeDays = entries.filter(e => e.hv_fis_level === 1).length;
    const avgLevel = (entries.reduce((sum, e) => sum + e.hv_fis_level, 0) / totalDays).toFixed(1);

    // Most common level (for I-14)
    const levelCounts = [0, 0, 0, 0, 0, 0]; // index 0 unused
    entries.forEach(e => levelCounts[e.hv_fis_level]++);
    const mostCommonLevel = levelCounts.indexOf(Math.max(...levelCounts.slice(1)));

    const data = {
        headacheDays,
        headacheFreeDays,
        totalDays,
        avgLevel,
        mostCommonLevel,
        firstName: patient.first_name,
    };

    // I-30 needs the report URL
    if (templateId === 'I-30') {
        const reportToken = await generateReportToken(sprint.sprint_id);
        data.reportUrl = `${process.env.REPORT_BASE_URL}/${reportToken}`;
    }

    return { reply: render(templateId, data), templateId };
}

/**
 * Generate a report token for a sprint and store it.
 */
async function generateReportToken(sprintId) {
    const { data } = await supabase.rpc('generate_report_token');
    const token = data;

    await supabase
        .from('sprints')
        .update({
            report_token: token,
            report_generated: true,
            end_date: new Date().toISOString().split('T')[0],
            status: 'COMPLETED',
        })
        .eq('sprint_id', sprintId);

    return token;
}

/**
 * Trigger the day 30 transition: generate report, send T-1.
 */
async function triggerTransition(patient, sprint) {
    await transitionState(
        patient.patient_id, 'TRANSITION', 'SYSTEM_TIMER',
        `Day 30 reached (day_count: ${patient.day_count + 1})`,
        { pending_question: 'TRANSITION_CHOICE' }
    );

    // Cancel daily scheduler
    await cancelPatientJobs(patient.patient_id);
}

/**
 * Handle weekly context question response (W-1, W-2, W-3).
 */
async function handleWeeklyResponse(patient, messageBody) {
    // Determine which weekly question was pending
    const { data: latestWeekly } = await supabase
        .from('weekly_entries')
        .select('*')
        .eq('patient_id', patient.patient_id)
        .is('responded_at', null)
        .order('asked_at', { ascending: false })
        .limit(1)
        .single();

    if (!latestWeekly) {
        // No pending weekly question — treat as daily response
        await supabase
            .from('patients')
            .update({ pending_question: null })
            .eq('patient_id', patient.patient_id);
        return await handleDailyActive(
            { ...patient, pending_question: null },
            messageBody
        );
    }

    // Store the response
    await supabase
        .from('weekly_entries')
        .update({
            response_value: messageBody.trim().substring(0, 10),
            response_text: messageBody.trim(),
            responded_at: new Date().toISOString(),
        })
        .eq('weekly_entry_id', latestWeekly.weekly_entry_id);

    // Clear pending
    await supabase
        .from('patients')
        .update({ pending_question: null })
        .eq('patient_id', patient.patient_id);

    return {
        reply: `Got it, thanks. Back to your regular check-ins tomorrow. 👍`,
        templateId: 'W-ACK',
    };
}

/**
 * Parse a fuzzy date like "March 15", "3/15", "march 15th".
 * Returns YYYY-MM-DD string or null.
 */
function parseFuzzyDate(text) {
    const cleaned = text.trim().toLowerCase()
        .replace(/(st|nd|rd|th)/g, '')
        .replace(/\s+/g, ' ');

    const months = {
        jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
        apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
        aug: 7, august: 7, sep: 8, september: 8, oct: 9, october: 9,
        nov: 10, november: 10, dec: 11, december: 11,
    };

    // "March 15", "march 15", "Mar 15"
    let match = cleaned.match(/^([a-z]+)\s+(\d{1,2})$/);
    if (match && months[match[1]] !== undefined) {
        const month = months[match[1]];
        const day = parseInt(match[2], 10);
        return buildDate(month, day);
    }

    // "3/15", "03/15"
    match = cleaned.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (match) {
        const month = parseInt(match[1], 10) - 1;
        const day = parseInt(match[2], 10);
        if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
            return buildDate(month, day);
        }
    }

    // "3-15", "03-15"
    match = cleaned.match(/^(\d{1,2})-(\d{1,2})$/);
    if (match) {
        const month = parseInt(match[1], 10) - 1;
        const day = parseInt(match[2], 10);
        if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
            return buildDate(month, day);
        }
    }

    return null;
}

function buildDate(month, day) {
    const now = new Date();
    let year = now.getFullYear();
    const candidate = new Date(year, month, day);

    // If the date is in the past, assume next year
    if (candidate < now) {
        year++;
    }

    const d = new Date(year, month, day);
    return d.toISOString().split('T')[0];
}

/**
 * Format a 24h time string "08:00" into display format "8:00 AM".
 */
function formatTime12(time24) {
    if (!time24) return 'your usual time';
    const [h, m] = time24.split(':').map(Number);
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const period = h >= 12 ? 'PM' : 'AM';
    return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Format a date string for display.
 */
function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

module.exports = {
    handleEnrolled,
    handleOnboarding,
    handleDailyActive,
    handlePaused,
    handleTransition,
    handleDormant,
    parseNumericLevel,
    // Exported for testing
    parseFuzzyDate,
    formatTime12,
};

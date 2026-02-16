/**
 * Twilio Inbound Webhook
 * 
 * POST /api/webhooks/twilio
 * 
 * This is the front door. Every patient text message arrives here via Twilio.
 * 
 * Pipeline (per SMS Implementation Spec §2.4):
 *   1. Verify Twilio signature (reject spoofed requests)
 *   2. Log raw webhook to webhook_log table
 *   3. Look up patient by phone number
 *   4. Check for global commands (STOP, HELP, TIME, REPORT, PAUSE)
 *   5. Route to state-specific handler based on patient.state
 *   6. Send reply SMS(es) via Twilio
 *   7. Log all messages
 *   8. Return TwiML response (empty — we send replies via API, not TwiML)
 * 
 * Target latency: <2 seconds end-to-end (webhook → reply sent).
 * 
 * Vercel serverless function. Stateless — reads all state from Supabase
 * on every request. Any instance can handle any patient.
 */

const { supabase } = require('../../lib/supabase');
const { verifyWebhookSignature, sendSMS, logInboundMessage } = require('../../lib/twilio');
const { getPatientByPhone, transitionState } = require('../../lib/state-machine/transitions');
const { cancelPatientJobs, scheduleDailyCheckin } = require('../../lib/services/scheduler');
const { render } = require('../../lib/templates');
const { parseTime } = require('../../lib/utils/parse-time');
const {
    handleEnrolled,
    handleOnboarding,
    handleDailyActive,
    handlePaused,
    handleTransition,
    handleDormant,
} = require('../../lib/handlers/state-handlers');

// ==========================================================================
// MAIN HANDLER
// ==========================================================================

module.exports = async function handler(req, res) {
    // --- Only accept POST ---
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const startTime = Date.now();

    try {
        // --- 1. Parse Twilio webhook body ---
        const body = req.body;
        const fromNumber = normalizePhone(body.From);
        const messageBody = (body.Body || '').trim();
        const twilioSid = body.MessageSid;

        if (!fromNumber || !messageBody) {
            return res.status(400).json({ error: 'Missing From or Body' });
        }

        // --- 2. Verify Twilio signature ---
        if (process.env.NODE_ENV !== 'development') {
            const signature = req.headers['x-twilio-signature'];
            const webhookUrl = `${process.env.REPORT_BASE_URL?.replace('/api/reports', '')}/api/webhooks/twilio`;

            if (!signature || !verifyWebhookSignature(signature, webhookUrl, body)) {
                console.warn('Invalid Twilio signature from:', fromNumber);
                return res.status(403).json({ error: 'Invalid signature' });
            }
        }

        // --- 3. Log raw webhook ---
        await supabase.from('webhook_log').insert({
            source: 'twilio',
            method: 'POST',
            body: body,
            from_number: fromNumber,
            twilio_signature: req.headers['x-twilio-signature'] || null,
        });

        // --- 4. Look up patient ---
        const patient = await getPatientByPhone(fromNumber);

        if (!patient) {
            // Unknown number: send info message, don't create a patient
            console.log(`Unknown number: ${fromNumber}`);
            // We can't log to messages table without a patient_id
            // Just respond via TwiML this one time
            return sendTwiML(res, render('ERR-UNKNOWN-NUMBER'));
        }

        // --- 5. Log inbound message ---
        await logInboundMessage(patient.patient_id, messageBody, twilioSid);

        // --- 6. Check global commands (override state routing) ---
        const globalResult = await handleGlobalCommands(patient, messageBody);
        if (globalResult) {
            await sendReplies(patient, globalResult);
            logLatency(startTime, patient.patient_id, 'global-command');
            return sendTwiML(res);
        }

        // --- 7. Route to state handler ---
        const stateHandler = STATE_HANDLERS[patient.state];

        if (!stateHandler) {
            console.error(`No handler for state: ${patient.state}`);
            await sendReplies(patient, {
                reply: render('SYS-HELP'),
                templateId: 'SYS-HELP',
            });
            return sendTwiML(res);
        }

        const result = await stateHandler(patient, messageBody, twilioSid);

        // --- 8. Send reply SMS(es) ---
        await sendReplies(patient, result);

        logLatency(startTime, patient.patient_id, patient.state);
        return sendTwiML(res);

    } catch (error) {
        console.error('Webhook handler error:', error);

        // Don't expose internal errors to Twilio.
        // Return 200 so Twilio doesn't retry (retries would hit the same error).
        return sendTwiML(res);
    }
};

// ==========================================================================
// STATE HANDLER ROUTER
// ==========================================================================

const STATE_HANDLERS = {
    ENROLLED: handleEnrolled,
    ONBOARDING: handleOnboarding,
    DAILY_ACTIVE: handleDailyActive,
    PAUSED: handlePaused,
    TRANSITION: handleTransition,
    WEEKLY: handleDormant,        // Phase 2: use dormant handler as stub
    TREATMENT: handleDailyActive, // Phase 2: same as daily for now
    DORMANT: handleDormant,
    // UNSUBSCRIBED: no handler — global STOP already handled
};

// ==========================================================================
// GLOBAL COMMANDS
// ==========================================================================

/**
 * Handle commands that work from any state: STOP, HELP, TIME, REPORT, PAUSE.
 * Returns a reply object if a global command was matched, null otherwise.
 * 
 * Per TCPA: STOP must be honored immediately from any state.
 */
async function handleGlobalCommands(patient, messageBody) {
    const text = messageBody.toUpperCase().trim();

    // --- STOP: Immediate unsubscribe from any state ---
    if (text === 'STOP' || text === 'UNSUBSCRIBE' || text === 'QUIT' || text === 'CANCEL') {
        await transitionState(
            patient.patient_id,
            'UNSUBSCRIBED',
            'PATIENT_RESPONSE',
            `STOP command: "${messageBody}"`
        );
        await cancelPatientJobs(patient.patient_id);

        // Get report URL if one exists
        const { data: sprint } = await supabase
            .from('sprints')
            .select('report_token')
            .eq('patient_id', patient.patient_id)
            .not('report_token', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .single();

        const reportUrl = sprint?.report_token
            ? `${process.env.REPORT_BASE_URL}/${sprint.report_token}`
            : null;

        return {
            reply: render('SYS-STOP', { reportUrl }),
            templateId: 'SYS-STOP',
        };
    }

    // --- Don't process other commands for UNSUBSCRIBED patients ---
    if (patient.state === 'UNSUBSCRIBED') {
        // Per TCPA: after STOP, the only valid response is START (re-subscribe).
        // But we don't auto-re-subscribe — they need to go through enrollment again.
        return {
            reply: `You're currently unsubscribed. Visit headachevault.com/track to re-enroll, or reply HELP for more info.`,
            templateId: 'SYS-UNSUBSCRIBED',
        };
    }

    // --- HELP ---
    if (text === 'HELP' || text === 'INFO') {
        return { reply: render('SYS-HELP'), templateId: 'SYS-HELP' };
    }

    // --- TIME: Change check-in time ---
    if (text === 'TIME' || text.startsWith('TIME ')) {
        // If they sent "TIME 8am", try to parse inline
        if (text.length > 5) {
            const parsed = parseTime(text.substring(5));
            if (parsed) {
                return await updatePatientTime(patient, parsed);
            }
        }

        // Otherwise ask for the time
        return { reply: render('SYS-TIME-ASK'), templateId: 'SYS-TIME-ASK' };
    }

    // --- REPORT: Get latest report link ---
    if (text === 'REPORT') {
        return await handleReportRequest(patient);
    }

    // --- PAUSE ---
    if (text === 'PAUSE' || text === 'BREAK') {
        if (patient.state === 'DAILY_ACTIVE') {
            await transitionState(
                patient.patient_id,
                'PAUSED',
                'PATIENT_RESPONSE',
                `PAUSE command: "${messageBody}"`
            );
            await cancelPatientJobs(patient.patient_id);

            return {
                reply: `Got it — your check-ins are paused. Reply YES or any number (1-5) whenever you're ready to resume. Your data is saved.`,
                templateId: 'SYS-PAUSE',
            };
        }
        // PAUSE from other states: ignore (not applicable)
        return null;
    }

    // No global command matched
    return null;
}

/**
 * Update patient's preferred check-in time and reschedule.
 */
async function updatePatientTime(patient, parsed) {
    await supabase
        .from('patients')
        .update({ preferred_time: parsed.time24 })
        .eq('patient_id', patient.patient_id);

    // Reschedule if currently active
    if (patient.state === 'DAILY_ACTIVE') {
        await cancelPatientJobs(patient.patient_id);
        await scheduleDailyCheckin(
            patient.patient_id,
            parsed.time24,
            patient.timezone || 'America/New_York'
        );
    }

    return {
        reply: render('SYS-TIME-CONFIRM', { time: parsed.display }),
        templateId: 'SYS-TIME-CONFIRM',
    };
}

/**
 * Handle REPORT command: return the latest report link.
 */
async function handleReportRequest(patient) {
    const { data: sprint } = await supabase
        .from('sprints')
        .select('report_token, days_completed, target_days')
        .eq('patient_id', patient.patient_id)
        .not('report_token', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

    if (!sprint || !sprint.report_token) {
        return {
            reply: `You don't have a report yet — keep tracking and you'll get one at day 30!`,
            templateId: 'SYS-REPORT-NONE',
        };
    }

    const reportUrl = `${process.env.REPORT_BASE_URL}/${sprint.report_token}`;
    const completionPct = Math.round((sprint.days_completed / sprint.target_days) * 100);

    return {
        reply: render('SYS-REPORT', { reportUrl, completionPct }),
        templateId: 'SYS-REPORT',
    };
}

// ==========================================================================
// UTILITIES
// ==========================================================================

/**
 * Send one or more reply messages to a patient.
 * Handles both single reply objects and arrays of replies.
 * Adds a small delay between multi-message sends so they arrive in order.
 */
async function sendReplies(patient, result) {
    if (!result) return;

    const replies = Array.isArray(result) ? result : [result];

    for (let i = 0; i < replies.length; i++) {
        const { reply, templateId } = replies[i];

        if (reply) {
            await sendSMS(
                patient.patient_id,
                patient.phone_number,
                reply,
                templateId
            );

            // Small delay between messages so they arrive in order
            if (i < replies.length - 1) {
                await sleep(500);
            }
        }
    }
}

/**
 * Normalize phone number to E.164 format.
 * Twilio sends "+1XXXXXXXXXX" — we store it that way.
 */
function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (phone.startsWith('+')) return phone;
    return null;
}

/**
 * Return an empty TwiML response.
 * We send replies via the Twilio API (not TwiML) so we have control
 * over delivery timing and can log the message SID.
 */
function sendTwiML(res, fallbackMessage = null) {
    res.setHeader('Content-Type', 'text/xml');

    if (fallbackMessage) {
        // Only used for unknown numbers where we can't use the API
        return res.status(200).send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(fallbackMessage)}</Message></Response>`
        );
    }

    return res.status(200).send(
        '<?xml version="1.0" encoding="UTF-8"?><Response></Response>'
    );
}

function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function logLatency(startTime, patientId, context) {
    const ms = Date.now() - startTime;
    if (ms > 2000) {
        console.warn(`SLOW: ${ms}ms for ${context} (patient: ${patientId})`);
    }
}

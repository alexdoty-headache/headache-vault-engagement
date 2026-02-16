/**
 * Message Templates
 * 
 * Every outbound SMS has a template ID (O-1, D-1, I-5, etc.) and a
 * function that renders the message body with patient-specific data.
 * 
 * Character limit: ≤320 chars (2 SMS segments) unless noted.
 * Tone: warm, respectful, never patronizing. No guilt. No false cheer.
 * 
 * Source: SMS Flow Specification v1.0
 */

const REPORT_BASE_URL = process.env.REPORT_BASE_URL || 'https://headachevault.com/report';

// ==========================================================================
// ONBOARDING
// ==========================================================================

const templates = {

    // O-1: Welcome (two variants based on enrollment source)
    'O-1-PCP': ({ firstName, pcpName }) =>
        `Hi ${firstName}, this is the Headache Vault. Dr. ${pcpName}'s office set up a 30-day headache tracking program for you.\n\nIt's one quick text per day — takes about 10 seconds.\n\nReply START to begin, or STOP at any time to opt out.`,

    'O-1-SELF': ({ firstName }) =>
        `Welcome to the Headache Vault! You're starting a 30-day headache tracking program. One text per day, about 10 seconds.\n\nAt the end, you'll get a report you can bring to any doctor.\n\nReply START to begin, or STOP at any time.`,

    // O-2: Preferred time
    'O-2': () =>
        `Great! What time works best for a daily check-in? Most people pick morning or evening.\n\nReply with a time like "8am" or "9pm"`,

    // O-3: Appointment anchor (two variants)
    'O-3-WITH-APPT': ({ time, appointmentDate }) =>
        `Got it — you'll hear from us daily at ${time}.\n\nYour next appointment is ${appointmentDate}. We'll have your report ready before then.\n\nYour first check-in comes tomorrow at ${time}. 👍`,

    'O-3-ASK-APPT': ({ time }) =>
        `Got it — you'll hear from us daily at ${time}.\n\nQuick question: do you have a doctor's appointment coming up? If so, reply with the date (like "March 15"). If not, just reply NO.`,

    'O-3-CONFIRMED': ({ time }) =>
        `Got it — you'll hear from us daily at ${time}.\n\nYour first check-in comes tomorrow at ${time}. 👍`,

    // O-4: Medication history
    'O-4-ASK': () =>
        `One more thing that'll make your report more useful:\n\nHave you ever taken a daily prevention medication for headaches? (Not Excedrin or Tylenol — things like topiramate, propranolol, amitriptyline, or a CGRP med.)\n\nReply YES, NO, or NOT SURE.`,

    'O-4-LIST': () =>
        `Which ones have you tried? You can list them or describe them — brand or generic names both work.\n\nExample: "topiramate and propranolol" or "the one that made me foggy and a beta blocker"`,

    'O-4-REASON': ({ medication }) =>
        `Why did you stop ${medication}?\n\n1 — Side effects\n2 — Didn't help\n3 — Cost\n4 — Other reason\n5 — I'm still on it`,

    // ==========================================================================
    // DAILY CHECK-IN
    // ==========================================================================

    'D-1': ({ firstName }) =>
        `How's your head today?\n\n1 — Didn't notice it\n2 — Noticed but didn't change my plans\n3 — Had to push through some things\n4 — Had to skip or modify something\n5 — Couldn't function`,

    // D-ACK: Acknowledgment variants (6 total, rotating)
    'D-ACK-1': () => `Got it, thanks. See you tomorrow. 👍`,
    'D-ACK-2': () => `Logged. Thanks for checking in.`,
    'D-ACK-3': () => `Recorded — that's one more day of data for your report.`,
    'D-ACK-4': () => `Thanks for sharing that. Every day of tracking matters.`,
    'D-ACK-5': () => `Got it. Your consistency is building a really clear picture.`,
    'D-ACK-6': () => `Noted. This kind of daily tracking is exactly what doctors need to see.`,

    // D-RE: Re-engagement
    'D-RE3': ({ firstName }) =>
        `Hey ${firstName} — haven't heard from you in a few days. No pressure, just checking in.\n\nReply with today's level (1-5) whenever you're ready, or reply PAUSE to take a break.`,

    'D-RE5': ({ firstName }) =>
        `Hi ${firstName}, it's been about 5 days. We'll pause your daily check-ins for now.\n\nReply YES anytime to pick back up where you left off. Your data is saved.`,

    // ==========================================================================
    // WEEKLY CONTEXT QUESTIONS
    // ==========================================================================

    'W-1': () =>
        `Quick weekly question: How many days this past week did you take something for a headache? (Tylenol, Excedrin, a triptan, anything.)\n\nReply with a number (0-7).`,

    'W-2': () =>
        `Weekly check: This past week, how much did headaches affect your activities?\n\n1 — Not at all\n2 — Mild — adjusted a few things\n3 — Moderate — missed some activities\n4 — Severe — missed most of what I planned`,

    'W-3': () =>
        `Last weekly question: Did you notice any triggers this week? (Stress, weather, sleep, food, hormones, etc.)\n\nReply with what you noticed, or NO if nothing stood out.`,

    // ==========================================================================
    // INSIGHT REFLECTIONS
    // ==========================================================================

    'I-5': ({ headacheDays, totalDays }) =>
        `5 days in! Here's what we're seeing so far: ${headacheDays} out of ${totalDays} days with some headache impact.\n\nStill early — patterns usually emerge around day 14.`,

    'I-10': ({ avgLevel, headacheFreeDays, totalDays }) =>
        `10-day check: Your average daily level is ${avgLevel}. You've had ${headacheFreeDays} headache-free days out of ${totalDays}.\n\nYou're building something most doctors never get to see — a real picture of your pattern.`,

    'I-14': ({ headacheDays, totalDays, mostCommonLevel }) =>
        `Two weeks of data! ${headacheDays} days with headache impact out of ${totalDays} tracked.\n\nYour most common level: ${mostCommonLevel}. Halfway there — the full 30 days makes the strongest case for your doctor.`,

    'I-21': ({ headacheDays, totalDays }) =>
        `3 weeks done. ${headacheDays} headache days out of ${totalDays} so far.\n\nYou're in the home stretch. 9 more days to complete the picture.`,

    'I-30': ({ firstName, reportUrl }) =>
        `${firstName}, you did it — 30 days of tracking! 🎉\n\nYour Visit Ready Report is here: ${reportUrl}\n\nThis has everything your doctor needs to see your pattern and make a plan. Bring it to your next appointment.`,

    // ==========================================================================
    // TRANSITION (Day 30+)
    // ==========================================================================

    'T-1': ({ firstName }) =>
        `${firstName}, now that your 30-day sprint is complete, what would you like to do?\n\n1 — Weekly check-ins (less frequent)\n2 — Track a new treatment (restart daily)\n3 — Pause for now\n\nYour report and data are saved regardless.`,

    // ==========================================================================
    // SYSTEM MESSAGES
    // ==========================================================================

    'SYS-STOP': ({ reportUrl }) =>
        `You've been unsubscribed from Headache Vault messages.${reportUrl ? ` Your data and reports remain available at ${reportUrl}` : ''}\n\nText START anytime to re-subscribe.`,

    'SYS-HELP': () =>
        `Headache Vault tracking system.\n\nReply with 1-5 for daily check-in.\nReply STOP to unsubscribe.\nReply TIME to change your check-in time.\nReply REPORT to get your latest report link.\n\nQuestions? Email support@headachevault.com`,

    'SYS-TIME-ASK': () =>
        `What time would you like your daily check-in? Reply with a time like "8am" or "9pm"`,

    'SYS-TIME-CONFIRM': ({ time }) =>
        `Got it — your check-in time is now ${time}. The change starts tomorrow.`,

    'SYS-REPORT': ({ reportUrl, completionPct }) =>
        completionPct < 100
            ? `Your latest report: ${reportUrl}\n\nYour report is ${completionPct}% complete. Keep tracking for the full 30-day picture.`
            : `Your latest report: ${reportUrl}`,

    // ==========================================================================
    // ERROR / CLARIFICATION
    // ==========================================================================

    'ERR-DAILY': () =>
        `I didn't catch that. Quick reminder — reply with:\n\n1 — Didn't notice my head\n2 — Noticed but no impact\n3 — Had to push through\n4 — Had to skip/modify plans\n5 — Couldn't function`,

    'ERR-ONBOARDING': () =>
        `Hmm, I'm not sure what you mean. Could you try again? Or reply HELP for options.`,

    'ERR-UNKNOWN-NUMBER': () =>
        `Hi! This is the Headache Vault. We don't have your number on file. Visit headachevault.com/track to sign up, or reply STOP to not hear from us again.`,

    'CLARIFY-LEVEL': ({ parsedLevel }) =>
        `Thanks — just want to make sure I got that right. Did you mean Level ${parsedLevel}?\n\n1 — Didn't notice it\n2 — Noticed but no impact\n3 — Had to push through\n4 — Had to skip/modify plans\n5 — Couldn't function\n\nReply with a number.`,
};

// ==========================================================================
// ACKNOWLEDGMENT ROTATION
// ==========================================================================

const ACK_TEMPLATES = ['D-ACK-1', 'D-ACK-2', 'D-ACK-3', 'D-ACK-4', 'D-ACK-5', 'D-ACK-6'];

/**
 * Get the next acknowledgment template, rotating sequentially.
 * Never repeats the last one used.
 * 
 * @param {string|null} lastAckTemplate - The template ID used yesterday
 * @returns {string} - Template ID for today's acknowledgment
 */
function getNextAck(lastAckTemplate) {
    if (!lastAckTemplate) return ACK_TEMPLATES[0];

    const lastIndex = ACK_TEMPLATES.indexOf(lastAckTemplate);
    const nextIndex = (lastIndex + 1) % ACK_TEMPLATES.length;
    return ACK_TEMPLATES[nextIndex];
}

/**
 * Render a template with data.
 * 
 * @param {string} templateId - Template key (e.g., 'O-1-PCP', 'D-1')
 * @param {object} data - Template variables
 * @returns {string} - Rendered message body
 */
function render(templateId, data = {}) {
    const tmpl = templates[templateId];
    if (!tmpl) {
        console.error(`Unknown template: ${templateId}`);
        return `Something went wrong. Reply HELP for options.`;
    }
    return tmpl(data);
}

module.exports = {
    templates,
    render,
    getNextAck,
    ACK_TEMPLATES,
};

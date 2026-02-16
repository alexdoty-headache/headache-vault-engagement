/**
 * Twilio Utility Module
 * 
 * Provides SMS sending, webhook signature verification, and message logging.
 * Used by api/webhooks/twilio.js (inbound) and api/cron/dispatch.js (outbound).
 * 
 * NEVER expose Twilio credentials to the browser/client.
 * All calls happen server-side in Vercel serverless functions.
 * 
 * See: SMS System Implementation Spec §2.3, §2.4
 */

const twilio = require('twilio');
const { supabase } = require('./supabase');

// ---------------------------------------------------------------------------
// Twilio Client (lazy singleton)
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
    if (!_client) {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;

        if (!accountSid || !authToken) {
            throw new Error(
                'Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN. ' +
                'Set them in .env.local (dev) or Vercel environment variables (prod).'
            );
        }

        _client = twilio(accountSid, authToken);
    }
    return _client;
}

// ---------------------------------------------------------------------------
// Send SMS
// ---------------------------------------------------------------------------

/**
 * Send an SMS message to a patient and log it to the messages table.
 * 
 * @param {string} patientId - UUID of the patient
 * @param {string} toNumber - E.164 phone number (e.g., "+12155551234")
 * @param {string} body - Message text (≤320 chars recommended for 2 segments)
 * @param {string} templateId - Template ID for analytics (e.g., "D-1", "O-2")
 * @returns {Promise<string>} - Twilio message SID
 */
async function sendSMS(patientId, toNumber, body, templateId) {
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;

    if (!fromNumber) {
        throw new Error('Missing TWILIO_PHONE_NUMBER environment variable');
    }

    const client = getClient();

    const message = await client.messages.create({
        to: toNumber,
        from: fromNumber,
        body: body,
    });

    // Log outbound message
    await supabase.from('messages').insert({
        patient_id: patientId,
        direction: 'OUTBOUND',
        body: body,
        template_id: templateId,
        twilio_sid: message.sid,
        delivery_status: 'SENT',
        sent_at: new Date().toISOString(),
    });

    return message.sid;
}

// ---------------------------------------------------------------------------
// Verify Webhook Signature
// ---------------------------------------------------------------------------

/**
 * Verify that an inbound webhook request actually came from Twilio.
 * Uses Twilio's X-Twilio-Signature header validation.
 * 
 * @param {string} signature - Value of X-Twilio-Signature header
 * @param {string} url - The full webhook URL Twilio POSTed to
 * @param {object} params - The POST body parameters
 * @returns {boolean} - True if signature is valid
 */
function verifyWebhookSignature(signature, url, params) {
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!authToken) {
        console.error('Cannot verify webhook: missing TWILIO_AUTH_TOKEN');
        return false;
    }

    return twilio.validateRequest(authToken, signature, url, params);
}

// ---------------------------------------------------------------------------
// Log Inbound Message
// ---------------------------------------------------------------------------

/**
 * Log an inbound SMS message to the messages table.
 * Called after patient lookup succeeds in the webhook handler.
 * 
 * @param {string} patientId - UUID of the patient
 * @param {string} body - Message text
 * @param {string} twilioSid - Twilio message SID from the webhook
 */
async function logInboundMessage(patientId, body, twilioSid) {
    await supabase.from('messages').insert({
        patient_id: patientId,
        direction: 'INBOUND',
        body: body,
        twilio_sid: twilioSid,
        delivery_status: 'DELIVERED',
        sent_at: new Date().toISOString(),
    });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    sendSMS,
    verifyWebhookSignature,
    logInboundMessage,
    getClient,
};

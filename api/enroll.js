/**
 * Enrollment Endpoint
 * 
 * POST /api/enroll
 * 
 * Creates a new patient record and sends the O-1 welcome SMS.
 * Supports two enrollment types:
 *   - PCP-initiated: provider enrolls patient from dashboard/API
 *   - Self-service: patient signs up directly
 * 
 * The patient starts in ENROLLED state and must reply START to
 * proceed to onboarding. An ONBOARD_REMINDER job is scheduled
 * for 24h later in case they don't respond.
 * 
 * Request body:
 *   {
 *     firstName: string (required),
 *     phoneNumber: string (required, E.164 or 10-digit),
 *     enrollmentSource: "PCP_INITIATED" | "SELF_SERVICE" (required),
 *     timezone: string (optional, defaults to "America/New_York"),
 *     email: string (optional),
 *     appointmentDate: string (optional, YYYY-MM-DD),
 *     pcpProviderId: string (optional, UUID — required if PCP_INITIATED),
 *     pcpName: string (optional — used if no pcpProviderId, creates provider on the fly),
 *     payerId: string (optional, Vault_Payer_ID)
 *   }
 * 
 * Response:
 *   201: { patientId, state, messageSid }
 *   400: { error } — validation failure
 *   409: { error, patientId } — phone number already enrolled
 *   500: { error } — server error
 * 
 * See: SMS Flow Spec §2, Implementation Spec §2
 */

const { supabase } = require('../lib/supabase');
const { sendSMS } = require('../lib/twilio');
const { render } = require('../lib/templates');
const { scheduleOneShot } = require('../lib/services/scheduler');

module.exports = async function handler(req, res) {
    // --- Only accept POST ---
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const {
            firstName,
            phoneNumber,
            enrollmentSource,
            timezone = 'America/New_York',
            email = null,
            appointmentDate = null,
            pcpProviderId = null,
            pcpName = null,
            payerId = null,
        } = req.body;

        // --- Validate required fields ---
        if (!firstName || typeof firstName !== 'string' || firstName.trim().length === 0) {
            return res.status(400).json({ error: 'firstName is required' });
        }

        if (!phoneNumber) {
            return res.status(400).json({ error: 'phoneNumber is required' });
        }

        const validSources = ['PCP_INITIATED', 'SELF_SERVICE', 'REFERRAL', 'QR_CODE'];
        if (!enrollmentSource || !validSources.includes(enrollmentSource)) {
            return res.status(400).json({
                error: `enrollmentSource must be one of: ${validSources.join(', ')}`,
            });
        }

        // --- Normalize phone number ---
        const normalizedPhone = normalizePhone(phoneNumber);
        if (!normalizedPhone) {
            return res.status(400).json({
                error: 'Invalid phone number. Provide E.164 format (+1XXXXXXXXXX) or 10-digit US number.',
            });
        }

        // --- Check for duplicate phone number ---
        const { data: existing } = await supabase
            .from('patients')
            .select('patient_id, state')
            .eq('phone_number', normalizedPhone)
            .single();

        if (existing) {
            // If patient previously unsubscribed, allow re-enrollment
            if (existing.state === 'UNSUBSCRIBED') {
                // Reset the patient for re-enrollment
                const { data: reactivated, error: reactivateError } = await supabase
                    .from('patients')
                    .update({
                        state: 'ENROLLED',
                        first_name: firstName.trim(),
                        opted_out_at: null,
                        day_count: 0,
                        consecutive_missed: 0,
                        pending_question: null,
                    })
                    .eq('patient_id', existing.patient_id)
                    .select()
                    .single();

                if (reactivateError) {
                    console.error('Re-enrollment update failed:', reactivateError);
                    return res.status(500).json({ error: 'Re-enrollment failed' });
                }

                // Send welcome and schedule reminder
                const messageSid = await sendWelcome(reactivated, pcpProviderId, pcpName);
                await scheduleOnboardReminder(reactivated.patient_id, reactivated.timezone);

                return res.status(201).json({
                    patientId: reactivated.patient_id,
                    state: 'ENROLLED',
                    messageSid,
                    reEnrolled: true,
                });
            }

            return res.status(409).json({
                error: 'Phone number already enrolled',
                patientId: existing.patient_id,
                currentState: existing.state,
            });
        }

        // --- Resolve PCP provider ---
        let resolvedProviderId = pcpProviderId;

        if (enrollmentSource === 'PCP_INITIATED' && !resolvedProviderId && pcpName) {
            // Create a new provider record on the fly
            const { data: provider, error: providerError } = await supabase
                .from('providers')
                .insert({ provider_name: pcpName.trim() })
                .select()
                .single();

            if (providerError) {
                console.error('Provider creation failed:', providerError);
                return res.status(500).json({ error: 'Failed to create provider record' });
            }

            resolvedProviderId = provider.provider_id;
        }

        // --- Create patient record ---
        const patientData = {
            phone_number: normalizedPhone,
            first_name: firstName.trim(),
            email: email,
            state: 'ENROLLED',
            enrollment_source: enrollmentSource,
            timezone: timezone,
            pcp_provider_id: resolvedProviderId || null,
            appointment_date: appointmentDate || null,
            payer_id: payerId || null,
        };

        const { data: patient, error: insertError } = await supabase
            .from('patients')
            .insert(patientData)
            .select()
            .single();

        if (insertError) {
            console.error('Patient creation failed:', insertError);

            if (insertError.code === '23505') {
                // Unique constraint violation (race condition on phone number)
                return res.status(409).json({ error: 'Phone number already enrolled' });
            }

            return res.status(500).json({ error: 'Failed to create patient' });
        }

        // --- Log state transition ---
        await supabase.from('state_transitions').insert({
            patient_id: patient.patient_id,
            from_state: 'ENROLLED',
            to_state: 'ENROLLED',
            trigger_type: 'ADMIN_ACTION',
            trigger_detail: `Enrollment via ${enrollmentSource}`,
        });

        // --- Send O-1 welcome SMS ---
        const messageSid = await sendWelcome(patient, resolvedProviderId, pcpName);

        // --- Schedule onboard reminder (24h) ---
        await scheduleOnboardReminder(patient.patient_id, timezone);

        return res.status(201).json({
            patientId: patient.patient_id,
            state: 'ENROLLED',
            messageSid,
        });

    } catch (error) {
        console.error('Enrollment error:', error);
        return res.status(500).json({ error: 'Enrollment failed' });
    }
};

// ==========================================================================
// HELPERS
// ==========================================================================

/**
 * Send the O-1 welcome message based on enrollment source.
 */
async function sendWelcome(patient, providerId, pcpName) {
    let templateId;
    let templateData;

    if (patient.enrollment_source === 'PCP_INITIATED' && providerId) {
        // Look up provider name if we don't have it
        let providerDisplayName = pcpName;
        if (!providerDisplayName) {
            const { data: provider } = await supabase
                .from('providers')
                .select('provider_name')
                .eq('provider_id', providerId)
                .single();
            providerDisplayName = provider?.provider_name || 'your doctor';
        }

        templateId = 'O-1-PCP';
        templateData = {
            firstName: patient.first_name,
            pcpName: providerDisplayName,
        };
    } else {
        templateId = 'O-1-SELF';
        templateData = {
            firstName: patient.first_name,
        };
    }

    const body = render(templateId, templateData);
    return await sendSMS(patient.patient_id, patient.phone_number, body, templateId);
}

/**
 * Schedule a reminder SMS if patient hasn't replied START within 24h.
 */
async function scheduleOnboardReminder(patientId, timezone) {
    const reminderTime = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await scheduleOneShot(patientId, 'ONBOARD_REMINDER', reminderTime, {});
}

/**
 * Normalize phone number to E.164 format.
 */
function normalizePhone(phone) {
    if (!phone) return null;
    const digits = phone.toString().replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    if (phone.startsWith('+') && digits.length === 11) return `+${digits}`;
    return null;
}

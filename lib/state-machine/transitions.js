/**
 * Patient State Machine
 * 
 * The central control structure of the engagement system.
 * Every patient is in exactly one state at any time. This module
 * defines valid transitions, executes them, and logs every change
 * to the state_transitions audit table.
 * 
 * States: ENROLLED → ONBOARDING → DAILY_ACTIVE → TRANSITION → (WEEKLY|TREATMENT|DORMANT)
 *         Any state → PAUSED (via patient request or 3 missed days)
 *         Any state → UNSUBSCRIBED (via STOP, terminal)
 * 
 * See: SMS System Implementation Spec §3 (State Machine)
 */

const { supabase } = require('../supabase');

// --- Valid Transitions ---
// Map of from_state → [allowed to_states]
// This is the guard: if a transition isn't in this map, it's a bug.

const VALID_TRANSITIONS = {
    ENROLLED: ['ONBOARDING', 'UNSUBSCRIBED', 'DORMANT'],
    ONBOARDING: ['DAILY_ACTIVE', 'UNSUBSCRIBED'],
    DAILY_ACTIVE: ['DAILY_ACTIVE', 'PAUSED', 'TRANSITION', 'UNSUBSCRIBED'],
    PAUSED: ['DAILY_ACTIVE', 'DORMANT', 'UNSUBSCRIBED'],
    TRANSITION: ['WEEKLY', 'TREATMENT', 'DORMANT', 'UNSUBSCRIBED'],
    WEEKLY: ['DAILY_ACTIVE', 'DORMANT', 'UNSUBSCRIBED'],       // Phase 2
    TREATMENT: ['TRANSITION', 'PAUSED', 'UNSUBSCRIBED'],       // Phase 2
    DORMANT: ['DAILY_ACTIVE', 'UNSUBSCRIBED'],
    UNSUBSCRIBED: [],   // Terminal state. No exits.
};

/**
 * Transition a patient to a new state.
 * 
 * This is the ONLY function that should modify patients.state.
 * It validates the transition, updates the patient record, and
 * writes an immutable audit log entry.
 * 
 * @param {string} patientId - UUID
 * @param {string} toState - Target state (e.g., 'DAILY_ACTIVE')
 * @param {string} triggerType - What caused this: PATIENT_RESPONSE, SYSTEM_TIMER, ADMIN_ACTION
 * @param {string|null} triggerDetail - Free-text context (message content, timer rule, etc.)
 * @param {object} additionalUpdates - Extra columns to update on patients table (e.g., { preferred_time: '08:00' })
 * @returns {object} - { success, patient, error }
 */
async function transitionState(patientId, toState, triggerType, triggerDetail = null, additionalUpdates = {}) {
    // 1. Read current state (always from DB, never cached)
    const { data: patient, error: fetchError } = await supabase
        .from('patients')
        .select('patient_id, state, phone_number, first_name')
        .eq('patient_id', patientId)
        .single();

    if (fetchError || !patient) {
        return { success: false, patient: null, error: `Patient not found: ${patientId}` };
    }

    const fromState = patient.state;

    // 2. STOP is always valid from any non-terminal state
    if (toState === 'UNSUBSCRIBED' && fromState !== 'UNSUBSCRIBED') {
        // Allow — STOP overrides everything
    }
    // 3. Validate transition
    else if (!VALID_TRANSITIONS[fromState]?.includes(toState)) {
        return {
            success: false,
            patient,
            error: `Invalid transition: ${fromState} → ${toState}`,
        };
    }

    // 4. Skip if already in target state (except DAILY_ACTIVE → DAILY_ACTIVE, which is a daily cycle)
    if (fromState === toState && toState !== 'DAILY_ACTIVE') {
        return { success: true, patient, error: null };
    }

    // 5. Update patient state + any additional fields
    const updates = {
        state: toState,
        ...additionalUpdates,
    };

    // Set opt-in/opt-out timestamps
    if (toState === 'ONBOARDING' && !patient.opted_in_at) {
        updates.opted_in_at = new Date().toISOString();
    }
    if (toState === 'UNSUBSCRIBED') {
        updates.opted_out_at = new Date().toISOString();
    }

    const { data: updatedPatient, error: updateError } = await supabase
        .from('patients')
        .update(updates)
        .eq('patient_id', patientId)
        .select()
        .single();

    if (updateError) {
        return { success: false, patient, error: `Update failed: ${updateError.message}` };
    }

    // 6. Write audit log (append-only, never fails silently)
    const { error: logError } = await supabase
        .from('state_transitions')
        .insert({
            patient_id: patientId,
            from_state: fromState,
            to_state: toState,
            trigger_type: triggerType,
            trigger_detail: triggerDetail,
        });

    if (logError) {
        console.error('CRITICAL: State transition log failed:', logError);
        // Don't roll back the state change — the transition happened.
        // Log the failure loudly for monitoring to catch.
    }

    return { success: true, patient: updatedPatient, error: null };
}

/**
 * Get a patient's current state, read fresh from the database.
 * Never cache this — the spec requires reading from DB on every message.
 */
async function getPatientState(patientId) {
    const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('patient_id', patientId)
        .single();

    if (error) return null;
    return data;
}

/**
 * Look up a patient by phone number (for inbound message routing).
 */
async function getPatientByPhone(phoneNumber) {
    const { data, error } = await supabase
        .from('patients')
        .select('*')
        .eq('phone_number', phoneNumber)
        .single();

    if (error) return null;
    return data;
}

module.exports = {
    VALID_TRANSITIONS,
    transitionState,
    getPatientState,
    getPatientByPhone,
};

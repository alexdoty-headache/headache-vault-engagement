/**
 * Time Parser
 * 
 * Converts natural-language time strings from patients into HH:MM (24h).
 * Patients reply to O-2 with things like "8am", "9pm", "830", "morning".
 * 
 * Returns null if the input can't be parsed.
 */

/**
 * Parse a patient's time input into HH:MM 24-hour format.
 * 
 * Supported formats:
 *   "8am", "8 am", "8:00am", "8:00 am"
 *   "9pm", "9 pm", "9:30pm"
 *   "830" (→ 08:30), "2030" (→ 20:30)
 *   "morning" (→ 08:00), "evening" (→ 18:00), "night" (→ 20:00)
 *   "8" (ambiguous — assume AM if ≤7 assume PM, if 8-11 assume AM, 12 = noon)
 * 
 * @param {string} input - Raw patient text
 * @returns {{ time24: string, display: string } | null}
 *   time24: "08:00" format for database
 *   display: "8:00 AM" format for confirmation messages
 */
function parseTime(input) {
    if (!input || typeof input !== 'string') return null;

    const text = input.trim().toLowerCase().replace(/\s+/g, ' ');

    // --- Named times ---
    const namedTimes = {
        'morning': { h: 8, m: 0 },
        'am': { h: 8, m: 0 },          // Just "am" with no number
        'afternoon': { h: 14, m: 0 },
        'evening': { h: 18, m: 0 },
        'night': { h: 20, m: 0 },
        'noon': { h: 12, m: 0 },
        'midnight': { h: 0, m: 0 },
    };

    if (namedTimes[text]) {
        return formatResult(namedTimes[text].h, namedTimes[text].m);
    }

    // --- Regex patterns (ordered from most specific to least) ---

    // "8:30am", "8:30 am", "8:30pm", "8:30 pm"
    let match = text.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        const period = match[3];
        h = to24(h, period);
        if (isValid(h, m)) return formatResult(h, m);
    }

    // "8am", "8 am", "8pm", "8 pm", "11am"
    match = text.match(/^(\d{1,2})\s*(am|pm)$/);
    if (match) {
        let h = parseInt(match[1], 10);
        const period = match[2];
        h = to24(h, period);
        if (isValid(h, 0)) return formatResult(h, 0);
    }

    // "830", "0830", "2030" (military-ish)
    match = text.match(/^(\d{3,4})$/);
    if (match) {
        const num = match[1].padStart(4, '0');
        const h = parseInt(num.substring(0, 2), 10);
        const m = parseInt(num.substring(2, 4), 10);
        if (isValid(h, m)) return formatResult(h, m);
    }

    // "8:30" (no am/pm — use context heuristic)
    match = text.match(/^(\d{1,2}):(\d{2})$/);
    if (match) {
        let h = parseInt(match[1], 10);
        const m = parseInt(match[2], 10);
        h = guessAmPm(h);
        if (isValid(h, m)) return formatResult(h, m);
    }

    // Bare number: "8", "9", "7"
    match = text.match(/^(\d{1,2})$/);
    if (match) {
        let h = parseInt(match[1], 10);
        if (h >= 1 && h <= 23) {
            h = guessAmPm(h);
            return formatResult(h, 0);
        }
    }

    return null;
}

/**
 * Convert 12h to 24h.
 */
function to24(hours, period) {
    if (period === 'am') {
        return hours === 12 ? 0 : hours;
    } else {
        return hours === 12 ? 12 : hours + 12;
    }
}

/**
 * For times given without AM/PM, guess based on typical check-in times.
 * People check in morning (6-11) or evening (5-10).
 * Heuristic: 1-6 → PM, 7-11 → AM, 12 → PM (noon).
 */
function guessAmPm(hours) {
    if (hours >= 1 && hours <= 6) return hours + 12;   // 1→13, 6→18
    if (hours >= 7 && hours <= 11) return hours;         // 7→7, 11→11
    if (hours === 12) return 12;                          // noon
    return hours;                                          // 13+ already 24h
}

function isValid(h, m) {
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/**
 * Format hours/minutes into the two formats we need.
 */
function formatResult(h, m) {
    const time24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

    // Display format: "8:00 AM"
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    const displayPeriod = h >= 12 ? 'PM' : 'AM';
    const display = `${displayH}:${String(m).padStart(2, '0')} ${displayPeriod}`;

    return { time24, display };
}

module.exports = { parseTime };

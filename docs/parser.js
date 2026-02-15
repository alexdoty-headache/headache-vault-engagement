/**
 * AI Parser — HV-FIS Classification Pipeline
 * 
 * Classifies natural language patient responses onto the 1–5 HV-FIS
 * functional impact scale using Claude 3.5 Haiku via tool_use.
 * 
 * Pipeline:
 *   1. Numeric check (bypass AI entirely for "1"–"5")
 *   2. Regex fallback (common patterns, used if API is down)
 *   3. Claude Haiku classification (structured output via tool_use)
 *   4. Confidence routing:
 *      - ≥0.80 → accept classification
 *      - 0.60–0.79 → return for clarification prompt
 *      - <0.60 → return for full re-prompt
 * 
 * This is the highest-risk component in the system.
 * Misclassification = wrong clinical data.
 * 
 * See: SMS System Implementation Spec §5 (AI Parsing Pipeline)
 *      Functional Scale Definition v1.0
 */

const Anthropic = require('@anthropic-ai/sdk').default;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIDENCE_ACCEPT = 0.80;
const CONFIDENCE_CLARIFY = 0.60;
const MODEL = 'claude-3-5-haiku-20241022';
const MAX_TOKENS = 200;
const API_TIMEOUT_MS = 5000;  // 5s hard timeout (target: <500ms)

// ---------------------------------------------------------------------------
// Anthropic Client (lazy singleton)
// ---------------------------------------------------------------------------

let _client = null;

function getClient() {
    if (!_client) {
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            throw new Error('Missing ANTHROPIC_API_KEY environment variable');
        }
        _client = new Anthropic({ apiKey });
    }
    return _client;
}

// ---------------------------------------------------------------------------
// System Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a medical response classifier for a headache tracking system.

The patient was asked "How's your head today?" and given a 1–5 scale:

1 = Didn't notice my head today (headache-free)
2 = Noticed it but didn't change what I did (present, no disability)
3 = Had to push through some things (reduced function)
4 = Had to skip or modify something (activity modification)
5 = Couldn't function (total disability)

Classify the patient's response. Key rules:
- If the patient mentions ANY head symptoms, never assign Level 1
- Default ambiguous "fine/okay" responses to Level 2, not Level 1
- Focus on FUNCTIONAL impact, not pain severity
- "Pushed through" = Level 3. "Cancelled/skipped" = Level 4
- "In bed" or "couldn't do anything" = Level 5
- If the patient embeds a number (e.g., "my head was a 3 today"), extract that number
- Acute medication use with continued activity = at least Level 3
- If a headache resolved partway through the day, consider impact on the full day

Always use the classify_response tool to return your classification.`;

// ---------------------------------------------------------------------------
// Tool Definition (Structured Output Schema)
// ---------------------------------------------------------------------------

const CLASSIFY_TOOL = {
    name: 'classify_response',
    description: 'Classify a patient headache response onto the HV-FIS 1-5 scale',
    input_schema: {
        type: 'object',
        properties: {
            level: {
                type: 'integer',
                minimum: 1,
                maximum: 5,
                description: 'HV-FIS functional impact level (1-5)',
            },
            confidence: {
                type: 'number',
                minimum: 0.0,
                maximum: 1.0,
                description: 'Classification confidence (0.0-1.0)',
            },
            reasoning: {
                type: 'string',
                description: 'One sentence explaining the classification',
            },
        },
        required: ['level', 'confidence', 'reasoning'],
    },
};

// ---------------------------------------------------------------------------
// Regex Fallback Parser
// ---------------------------------------------------------------------------

/**
 * Pattern-based classification for when the Anthropic API is unavailable.
 * Also catches embedded numbers that the AI parser would handle.
 * 
 * Returns { level, confidence, reasoning } or null if no match.
 */
function regexFallback(text) {
    const lower = text.toLowerCase().trim();

    // --- Embedded number: "my head was a 3 today", "it's a 4", "level 3" ---
    const embeddedNum = lower.match(/\b(?:level|a|was|it's|its)\s*([1-5])\b/);
    if (embeddedNum) {
        const level = parseInt(embeddedNum[1], 10);
        return {
            level,
            confidence: 0.90,
            reasoning: `Extracted embedded number: ${level}`,
        };
    }

    // --- Level 1: No headache (check BEFORE ambiguous "good/fine") ---
    if (/\b(no headache|headache.?free|didn.?t notice|clear(?:\s+head)?|perfect|amazing|great day|good day|no complaints|feeling good|all good)\b/.test(lower)) {
        return { level: 1, confidence: 0.85, reasoning: 'Regex: no headache keywords' };
    }

    // --- Level 5: Total disability ---
    if (/\b(in bed|couldn.?t function|couldn.?t do anything|worst|debilitating|bedridden|couldn.?t move|couldn.?t get up|terrible)\b/.test(lower)) {
        return { level: 5, confidence: 0.88, reasoning: 'Regex: total disability keywords' };
    }

    // --- Level 4: Skipped/cancelled ---
    if (/\b(cancel|skipped|skip\b|left.{0,10}early|couldn.?t go|had to leave|called (?:out|off|in sick)|went home|missed work|missed school)\b/.test(lower)) {
        return { level: 4, confidence: 0.85, reasoning: 'Regex: activity cancellation keywords' };
    }

    // --- Level 3: Pushed through ---
    if (/\b(push.?(?:ed)?\s*through|rough|managed|got through|tough day|struggled|hard day|powered through)\b/.test(lower)) {
        return { level: 3, confidence: 0.83, reasoning: 'Regex: reduced function keywords' };
    }

    // --- Level 3: Medication use implies at least headache presence ---
    if (/\b(took (?:an? )?(?:excedrin|tylenol|advil|ibuprofen|aleve|imitrex|sumatriptan|triptan|medication|medicine|pill|med))\b/.test(lower)) {
        return { level: 3, confidence: 0.75, reasoning: 'Regex: acute medication use implies ≥ Level 3' };
    }

    // --- Level 2: Present but no impact ---
    if (/\b(mild|background|there but|noticed but|slight|dull|low.?grade|lingering|nagging)\b/.test(lower)) {
        return { level: 2, confidence: 0.82, reasoning: 'Regex: present but no disability' };
    }

    // --- Level 2 (lower confidence): Ambiguous positive ---
    if (/\b(fine|okay|ok|not bad|decent|alright|good|so.?so|meh|not great)\b/.test(lower)) {
        return { level: 2, confidence: 0.65, reasoning: 'Regex: ambiguous response defaults to Level 2' };
    }

    return null;
}

// ---------------------------------------------------------------------------
// Claude Haiku Classification
// ---------------------------------------------------------------------------

/**
 * Classify a patient response using Claude 3.5 Haiku.
 * 
 * Uses tool_use for structured output. The model MUST call the
 * classify_response tool — we use tool_choice: { type: 'tool' }
 * to force it.
 * 
 * @param {string} text - Raw patient SMS text
 * @returns {Promise<{ level: number, confidence: number, reasoning: string }>}
 * @throws {Error} on API failure or timeout
 */
async function classifyWithAI(text) {
    const client = getClient();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

    try {
        const response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            tools: [CLASSIFY_TOOL],
            tool_choice: { type: 'tool', name: 'classify_response' },
            messages: [
                { role: 'user', content: text },
            ],
        }, {
            signal: controller.signal,
        });

        // Extract the tool_use block
        const toolUse = response.content.find(block => block.type === 'tool_use');

        if (!toolUse || toolUse.name !== 'classify_response') {
            throw new Error('Model did not return classify_response tool call');
        }

        const { level, confidence, reasoning } = toolUse.input;

        // Validate output
        if (!Number.isInteger(level) || level < 1 || level > 5) {
            throw new Error(`Invalid level from AI: ${level}`);
        }
        if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
            throw new Error(`Invalid confidence from AI: ${confidence}`);
        }

        return {
            level,
            confidence: Math.round(confidence * 100) / 100,  // Round to 2 decimal places
            reasoning: reasoning || 'No reasoning provided',
        };

    } finally {
        clearTimeout(timeout);
    }
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Parse a patient's daily check-in response and classify it on the HV-FIS scale.
 * 
 * Decision tree:
 *   1. If the text is exactly "1"–"5" → return numeric directly (no AI)
 *   2. Try Claude Haiku classification
 *   3. If API fails → try regex fallback
 *   4. If regex fails → return null (caller should send ERR-DAILY)
 * 
 * @param {string} text - Raw patient SMS text
 * @returns {Promise<ParseResult|null>}
 * 
 * @typedef {Object} ParseResult
 * @property {number} level - HV-FIS level 1-5
 * @property {number} confidence - 0.0-1.0
 * @property {string} reasoning - One sentence explanation
 * @property {'NUMERIC'|'AI_PARSED'|'REGEX_FALLBACK'} method - How the level was determined
 * @property {'ACCEPT'|'CLARIFY'|'REPROMPT'} action - What the caller should do
 */
async function parseResponse(text) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text.trim();
    if (!cleaned) return null;

    // --- Step 1: Numeric check ---
    const numericMatch = cleaned.match(/^([1-5])$/);
    if (numericMatch) {
        return {
            level: parseInt(numericMatch[1], 10),
            confidence: 1.0,
            reasoning: 'Direct numeric input',
            method: 'NUMERIC',
            action: 'ACCEPT',
        };
    }

    // --- Step 2: Try AI classification ---
    try {
        const aiResult = await classifyWithAI(cleaned);

        return {
            ...aiResult,
            method: 'AI_PARSED',
            action: routeByConfidence(aiResult.confidence),
        };

    } catch (err) {
        console.error('AI classification failed, falling back to regex:', err.message);

        // --- Step 3: Regex fallback ---
        const regexResult = regexFallback(cleaned);

        if (regexResult) {
            return {
                ...regexResult,
                method: 'REGEX_FALLBACK',
                action: routeByConfidence(regexResult.confidence),
            };
        }

        // --- Step 4: Unparseable ---
        return null;
    }
}

/**
 * Determine the action based on confidence level.
 * 
 * @param {number} confidence
 * @returns {'ACCEPT'|'CLARIFY'|'REPROMPT'}
 */
function routeByConfidence(confidence) {
    if (confidence >= CONFIDENCE_ACCEPT) return 'ACCEPT';
    if (confidence >= CONFIDENCE_CLARIFY) return 'CLARIFY';
    return 'REPROMPT';
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
    parseResponse,
    classifyWithAI,
    regexFallback,
    routeByConfidence,

    // Exported for testing
    SYSTEM_PROMPT,
    CLASSIFY_TOOL,
    CONFIDENCE_ACCEPT,
    CONFIDENCE_CLARIFY,
};

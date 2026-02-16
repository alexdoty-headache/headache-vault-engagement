/**
 * AI Parser Tests
 * 
 * Covers:
 *   1. Numeric passthrough (1-5)
 *   2. Regex fallback patterns (all known patterns from spec §5.4)
 *   3. Confidence routing logic
 *   4. Edge cases (empty input, whitespace, multi-line, emoji)
 *   5. Integration test structure for Claude Haiku (mocked)
 * 
 * Run: node --test tests/ai-parser.test.js
 * 
 * Source: SMS System Implementation Spec §5.4 (Known Classification Patterns)
 */

const { describe, it, mock, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseResponse,
    regexFallback,
    routeByConfidence,
    CONFIDENCE_ACCEPT,
    CONFIDENCE_CLARIFY,
} = require('../lib/ai/parser');

// ============================================================================
// Confidence Routing
// ============================================================================

describe('routeByConfidence', () => {
    it('returns ACCEPT at exactly 0.80', () => {
        assert.equal(routeByConfidence(0.80), 'ACCEPT');
    });

    it('returns ACCEPT above 0.80', () => {
        assert.equal(routeByConfidence(0.95), 'ACCEPT');
        assert.equal(routeByConfidence(1.0), 'ACCEPT');
    });

    it('returns CLARIFY between 0.60 and 0.79', () => {
        assert.equal(routeByConfidence(0.60), 'CLARIFY');
        assert.equal(routeByConfidence(0.70), 'CLARIFY');
        assert.equal(routeByConfidence(0.79), 'CLARIFY');
    });

    it('returns REPROMPT below 0.60', () => {
        assert.equal(routeByConfidence(0.59), 'REPROMPT');
        assert.equal(routeByConfidence(0.30), 'REPROMPT');
        assert.equal(routeByConfidence(0.0), 'REPROMPT');
    });
});

// ============================================================================
// Numeric Passthrough (no AI needed)
// ============================================================================

describe('parseResponse — numeric input', () => {
    it('parses "1" through "5" as numeric with confidence 1.0', async () => {
        for (let n = 1; n <= 5; n++) {
            const result = await parseResponse(String(n));
            assert.equal(result.level, n);
            assert.equal(result.confidence, 1.0);
            assert.equal(result.method, 'NUMERIC');
            assert.equal(result.action, 'ACCEPT');
        }
    });

    it('handles whitespace around numbers', async () => {
        const result = await parseResponse('  3  ');
        assert.equal(result.level, 3);
        assert.equal(result.method, 'NUMERIC');
    });

    it('does NOT treat "0", "6", "7" as valid numeric', async () => {
        // These should fall through to AI/regex, not return as NUMERIC
        const r0 = regexFallback('0');
        const r6 = regexFallback('6');
        assert.equal(r0, null);
        assert.equal(r6, null);
    });
});

// ============================================================================
// Regex Fallback — Known Classification Patterns (Spec §5.4)
// ============================================================================

describe('regexFallback — Level 1 (no headache)', () => {
    const level1Phrases = [
        'good day',
        'no headache',
        'headache free',
        "didn't notice",
        'clear head',
        'perfect',
        'amazing day',
    ];

    for (const phrase of level1Phrases) {
        it(`classifies "${phrase}" as Level 1`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 1);
            assert.ok(result.confidence >= 0.70);
        });
    }
});

describe('regexFallback — Level 2 (present, no disability)', () => {
    const level2Phrases = [
        'there but okay',
        'mild headache',
        'background noise',
        'noticed but fine',
        'slight headache',
        'dull ache',
        'low grade',
        'lingering',
    ];

    for (const phrase of level2Phrases) {
        it(`classifies "${phrase}" as Level 2`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 2);
        });
    }
});

describe('regexFallback — Level 2 ambiguous (lower confidence)', () => {
    const ambiguousPhrases = [
        'fine',
        'okay',
        'ok',
        'not bad',
        'meh',
        'not great',
        'alright',
        'so-so',
    ];

    for (const phrase of ambiguousPhrases) {
        it(`classifies "${phrase}" as Level 2 with lower confidence`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 2);
            assert.ok(result.confidence < CONFIDENCE_ACCEPT,
                `Expected confidence < ${CONFIDENCE_ACCEPT}, got ${result.confidence}`);
        });
    }
});

describe('regexFallback — Level 3 (reduced function)', () => {
    const level3Phrases = [
        'rough but got through it',
        'pushed through',
        'managed to get through the day',
        'tough day',
        'struggled today',
        'hard day',
        'powered through',
    ];

    for (const phrase of level3Phrases) {
        it(`classifies "${phrase}" as Level 3`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 3);
        });
    }
});

describe('regexFallback — Level 3 (medication use)', () => {
    const medPhrases = [
        'took an excedrin but kept going',
        'took tylenol',
        'took ibuprofen this morning',
        'took a triptan',
        'took advil',
    ];

    for (const phrase of medPhrases) {
        it(`classifies "${phrase}" as Level 3 (medication use)`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 3);
        });
    }
});

describe('regexFallback — Level 4 (activity modification)', () => {
    const level4Phrases = [
        'had to cancel dinner',
        'left work early',
        'skipped the gym',
        "couldn't go to the meeting",
        'had to leave early',
        'called in sick',
        'missed work today',
    ];

    for (const phrase of level4Phrases) {
        it(`classifies "${phrase}" as Level 4`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 4);
        });
    }
});

describe('regexFallback — Level 5 (total disability)', () => {
    const level5Phrases = [
        'in bed all day',
        'terrible',
        "couldn't function",
        "couldn't do anything",
        'worst day ever',
        'debilitating',
        "couldn't get up",
    ];

    for (const phrase of level5Phrases) {
        it(`classifies "${phrase}" as Level 5`, () => {
            const result = regexFallback(phrase);
            assert.notEqual(result, null, `Expected match for "${phrase}"`);
            assert.equal(result.level, 5);
        });
    }
});

describe('regexFallback — embedded numbers', () => {
    it('extracts "my head was a 3 today" as Level 3', () => {
        const result = regexFallback('my head was a 3 today');
        assert.notEqual(result, null);
        assert.equal(result.level, 3);
        assert.ok(result.confidence >= 0.85);
    });

    it('extracts "it\'s a 4" as Level 4', () => {
        const result = regexFallback("it's a 4");
        assert.notEqual(result, null);
        assert.equal(result.level, 4);
    });

    it('extracts "level 2" as Level 2', () => {
        const result = regexFallback('level 2');
        assert.notEqual(result, null);
        assert.equal(result.level, 2);
    });

    it('extracts "was a 5" as Level 5', () => {
        const result = regexFallback('was a 5');
        assert.notEqual(result, null);
        assert.equal(result.level, 5);
    });
});

// ============================================================================
// Regex Fallback — Edge Cases
// ============================================================================

describe('regexFallback — edge cases', () => {
    it('returns null for totally unrelated text', () => {
        assert.equal(regexFallback('call me back'), null);
        assert.equal(regexFallback('what time is it'), null);
        assert.equal(regexFallback('wrong number'), null);
        assert.equal(regexFallback('haha'), null);
    });

    it('returns null for empty string', () => {
        assert.equal(regexFallback(''), null);
    });

    it('handles mixed case', () => {
        const result = regexFallback('PUSHED THROUGH');
        assert.notEqual(result, null);
        assert.equal(result.level, 3);
    });

    it('handles extra whitespace', () => {
        const result = regexFallback('  in bed all day  ');
        assert.notEqual(result, null);
        assert.equal(result.level, 5);
    });
});

// ============================================================================
// parseResponse — Null/Invalid Input
// ============================================================================

describe('parseResponse — invalid input', () => {
    it('returns null for null', async () => {
        assert.equal(await parseResponse(null), null);
    });

    it('returns null for empty string', async () => {
        assert.equal(await parseResponse(''), null);
    });

    it('returns null for whitespace only', async () => {
        assert.equal(await parseResponse('   '), null);
    });

    it('returns null for non-string', async () => {
        assert.equal(await parseResponse(123), null);
        assert.equal(await parseResponse(undefined), null);
    });
});

// ============================================================================
// parseResponse — Full Pipeline (AI mocked, regex fallback active)
//
// When ANTHROPIC_API_KEY is not set, classifyWithAI will throw,
// and parseResponse falls back to regex. This tests the full
// fallback path without needing a live API key.
// ============================================================================

describe('parseResponse — fallback pipeline (no API key)', () => {
    it('falls back to regex for "pushed through today"', async () => {
        const result = await parseResponse('pushed through today');
        // Without API key, AI fails → regex catches it
        assert.notEqual(result, null);
        assert.equal(result.level, 3);
        assert.equal(result.method, 'REGEX_FALLBACK');
    });

    it('falls back to regex for "in bed all day"', async () => {
        const result = await parseResponse('in bed all day');
        assert.notEqual(result, null);
        assert.equal(result.level, 5);
        assert.equal(result.method, 'REGEX_FALLBACK');
    });

    it('returns null for unparseable text when AI is down', async () => {
        const result = await parseResponse('call me back please');
        assert.equal(result, null);
    });

    it('numeric input bypasses both AI and regex', async () => {
        const result = await parseResponse('3');
        assert.equal(result.level, 3);
        assert.equal(result.method, 'NUMERIC');
        // This should NOT hit AI or regex at all
    });
});

// ============================================================================
// Confidence Thresholds Validation
// ============================================================================

describe('confidence thresholds match spec', () => {
    it('ACCEPT threshold is 0.80', () => {
        assert.equal(CONFIDENCE_ACCEPT, 0.80);
    });

    it('CLARIFY threshold is 0.60', () => {
        assert.equal(CONFIDENCE_CLARIFY, 0.60);
    });
});

// ============================================================================
// Regression: Spec Table §5.4 Complete Coverage
//
// These are the exact patterns from the Implementation Spec that we
// must handle correctly. Run this suite as a regression gate.
// ============================================================================

describe('regression — spec §5.4 classification table', () => {
    const specPatterns = [
        // Level 1
        { input: 'good day', expectedLevel: 1 },
        { input: 'clear', expectedLevel: 1 },
        { input: 'no headache', expectedLevel: 1 },
        { input: "didn't notice", expectedLevel: 1 },

        // Level 2
        { input: 'there but okay', expectedLevel: 2 },
        { input: 'mild', expectedLevel: 2 },
        { input: 'background noise', expectedLevel: 2 },
        { input: 'noticed but fine', expectedLevel: 2 },

        // Level 2 (ambiguous, lower confidence)
        { input: 'not great', expectedLevel: 2 },
        { input: 'meh', expectedLevel: 2 },
        { input: 'okay I guess', expectedLevel: 2 },

        // Level 3
        { input: 'rough but got through it', expectedLevel: 3 },
        { input: 'pushed through', expectedLevel: 3 },

        // Level 3 (embedded number)
        { input: 'my head was a 3 today', expectedLevel: 3 },

        // Level 3 (medication)
        { input: 'took an Excedrin but kept going', expectedLevel: 3 },

        // Level 4
        { input: 'had to cancel dinner', expectedLevel: 4 },
        { input: 'left work early', expectedLevel: 4 },
        { input: 'skipped the gym', expectedLevel: 4 },

        // Level 5
        { input: 'in bed all day', expectedLevel: 5 },
        { input: 'terrible', expectedLevel: 5 },
        { input: 'worst', expectedLevel: 5 },
        { input: "couldn't do anything", expectedLevel: 5 },
    ];

    for (const { input, expectedLevel } of specPatterns) {
        it(`"${input}" → Level ${expectedLevel}`, () => {
            const result = regexFallback(input);
            assert.notEqual(result, null, `regexFallback returned null for "${input}"`);
            assert.equal(result.level, expectedLevel,
                `Expected Level ${expectedLevel} for "${input}", got Level ${result.level}`);
        });
    }
});

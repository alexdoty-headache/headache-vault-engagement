# Architecture Decision Records — Patient Engagement Engine

## ADR-001: Production Stack from Day One
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Could build a quick pilot with Landbot/Typeform, or go straight to production
**Decision:** Build with Next.js + Supabase + Twilio for production
**Rationale:** No throwaway code, HIPAA-compliant from start, supports publication
**Consequences:** Slower initial build, but no rewrite needed

## ADR-002: Structured SMS Input Only (No AI Parsing)
**Date:** 2026-02-12
**Status:** Accepted
**Context:** Could use Claude to parse free-text SMS responses
**Decision:** Use structured input validation (numbers, Y/N) for beta
**Rationale:** Simpler, more reliable, avoids hallucination risk with patient data
**Consequences:** Less natural conversation feel, but more trustworthy data

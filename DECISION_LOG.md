# Decision Log

## Goal And Scope

I prioritized one explainable end-to-end path over a broad analytics product: founder question -> validated plan -> live read-only monday.com data -> normalization -> deterministic calculation -> concise answer with insight, caveats, and source retrieval time.

The committed catalog is Open Deals pipeline/health, Work Order inclusive-GST financials, Work Order execution/billing exceptions, and exact-sector comparisons across both boards. Weighted forecasting, excluded-GST analysis, overdue logic, dashboards, durable chat history, and record-level cross-board journeys are deliberately incomplete.

## Assumptions

- `Open` defines active pipeline; On Hold is included only if a future explicit handler supports it.
- Pipeline time means Tentative Close Date. Calendar quarters use `Asia/Kolkata` and inclusive boundaries.
- Masked Deal value has unknown currency/scale, so it is never labeled INR or revenue.
- Work Order financials use the direct inclusive-GST source columns; blanks are unknown, not zero.
- Every monday item is retained by default. Totals are board-item totals because duplicate-looking records cannot safely be deleted without a business key.
- Exact normalized sector labels are comparable across boards, but rows are not joinable. `Energy` requires clarification to Renewables, Powerline, or both.
- Public evaluation requires server-side demo credentials. Runtime code remains query-only and exposes no token.

## Key Decisions And Trade-offs

| Decision | Rationale and trade-off |
|---|---|
| Next.js + TypeScript on Vercel | One codebase and one deployment for UI/API minimizes delivery time. It is less separated than independent services, which is acceptable at this scale. |
| monday.com GraphQL API, not MCP | Static queries, explicit cursor pagination, error handling, and deployment are easier to inspect in the time box. The client defines no mutations. |
| Groq GPT-OSS only for structured planning | Groq strict JSON Schema output keeps natural language flexible while all filters and arithmetic stay auditable. The trade-off is a deliberately narrow intent schema rather than arbitrary BI. |
| Deterministic TypeScript + decimal arithmetic | Prevents hallucinated totals and binary floating-point drift. Every displayed metric derives from fetched values and tested formulas. |
| Runtime title-to-column mapping | Imported monday column IDs vary, while supplied titles are stable and human-auditable. Missing required titles fail clearly instead of producing partial results. |
| Runtime normalization, no write-back | Preserves source evidence and read-only behavior. Invalid/missing coverage and malformed rows are disclosed instead of silently repaired. |
| No row-level cross-board join | Client/deal aliases and codes do not provide a trustworthy foreign key. Sector-level results remain independent to avoid false attribution. |
| Targeted clarifications | Material ambiguity is resolved instead of guessed. Revenue asks for a supported measure; Energy asks for a source-sector mapping. Unsupported follow-ups return a boundary rather than pretending they can run. |
| Uncached live reads for the prototype | Makes dynamic monday.com behavior easy to prove. It costs more API capacity than a production cache and should later gain a short TTL and clear invalidation. |
| Focused chat instead of dashboard | Meets the conversational requirement and keeps attention on answer quality. Charts/exports are deferred until the core is reliable. |
| Focused tests | Tests cover normalization, BI arithmetic, pagination/errors, clarification state, and a manual real-board flow. Broad UI automation was cut to protect the vertical slice. |

## Data Handling

Null/blank/NA values remain missing, zero remains zero, invalid numeric text never becomes zero, negatives are retained, and month-only values never receive an invented year. Embedded Deal header rows are excluded and counted. Possible duplicates remain included with an explicit no-deduplication caveat. Tender/DSP remain source sector-field values but are flagged as potentially non-sector labels. HTTP-200 GraphQL errors or incomplete pages invalidate the request; the application never aggregates partial monday data.

## Leadership Updates

I interpret “prepare data for leadership updates” as producing a short, defensible brief: summary, key numbers, one or two calculated observations, material data gaps, and source retrieval details. The normal response structure supports that interpretation. A separate slide/report generator was not built because it would add presentation breadth before metric reliability.

## With More Time

I would first establish governed metric definitions and an authoritative Deal-to-Work-Order key; then add authenticated multi-tenant access, short-lived caching, observability, data-change timestamps, richer cohort/trend analysis, and broader end-to-end/accessibility testing. Only after those foundations would I add dashboards and downloadable leadership reports.

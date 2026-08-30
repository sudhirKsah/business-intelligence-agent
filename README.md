# Skylark Drones Business Intelligence Agent

A focused, read-only conversational agent for founder-level questions over live monday.com Deals and Work Orders boards.

The LLM only converts natural language into a validated query plan or clarification. It never calculates metrics. All filtering, grouping, decimal aggregation, ratios, insights, and caveats come from deterministic TypeScript operating on data fetched from monday.com for the current request.

## Status

Implemented:

- Dynamic, cursor-paginated monday.com GraphQL reads with no mutations or source-data constants.
- Runtime column discovery by normalized title rather than generated monday column IDs.
- Deals and Work Orders normalization for BI-critical fields.
- Deterministic pipeline, financial, operations, billing-exception, and cross-board sector handlers.
- Missing/invalid coverage, malformed-header exclusion, no-deduplication disclosure, and source retrieval metadata.
- Structured LLM query planning, targeted Energy/revenue clarification, and explicit capability boundaries.
- Responsive chat with starter prompts, clarification buttons, loading/retry, facts, insights, caveats, and sources.
- Focused parser, BI, pagination/error, retry, and clarification tests.

Manual completion still required:

- Create/import the two monday.com boards and add credentials to `.env.local`.
- Reconcile the imported live board counts and run the real end-to-end demo.
- Deploy to Vercel and add the public URL here: **Not deployed yet**.
- Create the public GitHub remote, push the reviewed source, and submit the final links.

## Supported Questions

- Open pipeline count/value, optionally by exact sector or Tentative Close Date period.
- Open pipeline distribution by closure probability.
- Work Order contracted, billed, recorded collected, receivable, and still-to-bill values including GST.
- Work Order execution-status distribution and two explicit billing exceptions.
- Side-by-side Deals and Work Orders aggregates for exact source sectors.

Examples:

- `How many Open deals are there, and what is their known pipeline value?`
- `Using Tentative Close Date, what Open pipeline falls in Q1 2026?`
- `How is Open pipeline distributed by closure probability?`
- `Give me the all-time Work Order financial snapshot including GST.`
- `What is the Work Order execution-status distribution?`
- `Show billing-status exceptions.`
- `Compare Renewables pipeline and Work Order health across both boards.`
- `How is our energy pipeline this quarter?` (asks what Energy means)
- `What was revenue?` (asks which supported measure is intended)

Explicitly unsupported: weighted forecasts without probability weights, excluded-GST analysis, overdue calculations without payment terms/due dates, time-filtered Work Order/cross-board metrics without an agreed Work Order date basis, and record-level deal-to-delivery joins without a trustworthy key.

## Architecture

```text
Browser chat
    -> POST /api/chat (input and pending-clarification validation)
    -> Groq strict structured query plan OR deterministic clarification resolution
    -> static read-only monday.com GraphQL query with cursor pagination
    -> board-specific normalization and quality metadata
    -> deterministic BI handler using decimal arithmetic
    -> answer / insight / caveat / source response
```

The planner receives the user's question and a compact capability/metric catalog. It receives no board rows and cannot call monday.com. Generated GraphQL and generated calculation code are not used.

### Main files

```text
src/app/api/chat/route.ts  Validated API and safe error mapping
src/components/chat.tsx    Conversational UI and clarification state
src/lib/monday.ts          Read-only GraphQL, pagination, retry
src/lib/normalize.ts       Column mapping and typed data-quality rules
src/lib/planner.ts         Structured LLM planning and clarifications
src/lib/bi.ts              Deterministic calculations and answer sections
src/lib/*.test.ts          Focused high-value tests
```

## monday.com Setup

### 1. Create the boards

Import the supplied files as separate boards:

- `Deal funnel Data.xlsx` -> a Deals board. Use `Deal Name` as the item name where monday's import flow permits it.
- `Work_Order_Tracker Data.xlsx` -> a Work Orders board. Use `Serial #` as the item name where monday's import flow permits it.

Preserve every supplied column and row. Do not remove embedded headers, blanks, invalid values, negative amounts, or possible duplicates before import; the application handles or discloses them at read time.

Use Date/Number/Status types where import is lossless. Keep mixed fields such as quantities, month-only values, invoice numbers, or columns containing errors as Text so raw meaning is not erased.

### 2. Preserve required column titles

Punctuation and case are normalized, and a few documented aliases are accepted, but these source titles are the safest configuration.

Deals:

- `Deal Status`
- `Closure Probability`
- `Sector/service`
- `Tentative Close Date`
- `Masked Deal value`

Work Orders:

- `Sector`
- `Execution Status`
- `Invoice Status`
- `WO Status`
- `contract amount incl. GST`
- `billed value incl. GST`
- `collected amount`
- `amount still to bill incl. GST`
- `amount receivable`

The API reads all item column values, while only these BI-critical fields are typed. A missing required title returns a safe schema error instead of a misleading partial answer.

### 3. Obtain IDs and token

- Open each board and copy its numeric ID from the board URL.
- Create a monday.com API token with board-read access. A read-scoped credential is preferred.
- The application defines only GraphQL `query` operations. It has no mutation function, even if a personal token has broader account permissions.

## Local Setup

Requirements: Node.js 20.9 or newer, npm, both monday.com boards, and a Groq API key with access to a model that supports strict JSON Schema output.

1. Install dependencies:

   ```bash
   npm install
   ```

2. Open the already-created ignored `.env.local` and fill in:

   ```dotenv
   MONDAY_API_TOKEN=your_monday_token
   MONDAY_DEALS_BOARD_ID=1234567890
   MONDAY_WORK_ORDERS_BOARD_ID=1234567891
   MONDAY_API_VERSION=
   GROQ_API_KEY=your_groq_key
   GROQ_MODEL=openai/gpt-oss-120b
   ```

   `MONDAY_API_VERSION` is optional. Set it only if your monday account requires a pinned supported version. `.env.local` and all `.env*` files are ignored; `.env.example` contains names only.

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:3000` and run the demo prompts below.

The unrelated `.env.openaikey` file is not used by this project and must remain untouched.

## Metric And Data Rules

- **Open pipeline:** Deal Status exactly `Open`; On Hold is not included.
- **Pipeline time:** Tentative Close Date, inclusive calendar dates. `this quarter` uses the calendar quarter in `Asia/Kolkata` and the answer states the selected range.
- **Deal value:** only valid Masked Deal values are summed. Currency/scale was not supplied, so output says `masked-value units`, never INR or revenue.
- **Financials:** direct Work Order inclusive-GST columns. Invalid/missing cells are excluded from sums and reported as coverage; zero remains zero and negative values remain negative.
- **Recorded collections:** blanks are unknown, not zero. Recorded collections divided by total billed is clearly labeled a partial-data comparison, not a collection rate.
- **Sectors:** case/whitespace-normalized exact labels. `Energy` is never guessed; the user chooses Renewables, Powerline, or both. Tender/DSP remain source values but are caveated as non-sector-like.
- **Duplicates:** no item is automatically removed. Results are board-item totals and state that no deduplication was applied.
- **Malformed Deals:** embedded rows whose item name is `Deal Name` are excluded and counted as malformed headers.
- **Cross-board:** sector aggregates are shown side by side. Counts are never added together and rows are never joined because the files provide no trustworthy common key.
- **Dates/months:** strict full dates are parsed. Month-only text is not assigned an invented year.

## Error Handling

- Invalid/oversized requests -> `400`.
- Missing server settings -> safe `503` configuration message.
- monday authentication failure -> non-retryable configuration/access message.
- monday `429`, `5xx`, network failure, or timeout -> one read retry, then retryable `503`.
- HTTP-200 GraphQL errors, missing pages, missing boards, or missing required columns -> reject the incomplete result; never aggregate partial data.
- Invalid/empty planner output -> safe planner error; it cannot reach a BI handler.
- Empty query results -> factual zero-match response with active date/filter caveats.

Tokens, raw stack traces, and monday response bodies are never returned to the browser.

## Testing

```bash
npm test        # focused Vitest suite
npm run check   # TypeScript
npm run build   # production build
```

Current automated coverage is intentionally focused:

- Null/NA, zero, invalid, negative and decimal parsing.
- Strict dates and month-only rejection.
- Embedded Deal header handling and questionable sector labels.
- Pipeline, financial ratios/coverage, billing exceptions and independent cross-board BI.
- monday cursor pagination, HTTP-200 GraphQL errors, and one transient retry.
- Calendar-quarter calculation and Energy/financial clarification continuation.

### Real-board demo checklist

1. Ask the Open pipeline starter and reconcile item/value coverage with monday.com.
2. Ask the Work Order financial snapshot and inspect collection coverage/caveats.
3. Ask `How is our energy pipeline this quarter?`, choose `Renewables + Powerline`, and verify the original query resumes.
4. Ask the Renewables cross-board brief and verify Deals/Work Orders remain separate.
5. Change one valued Open Deal by exactly one unit in the monday UI, repeat the query, observe a `+1` result delta, then restore it. The app itself never writes.
6. Temporarily use an invalid board ID/token to confirm a safe error, then restore it.

## Vercel Deployment

1. Push the project to GitHub without `.env.local`, `.env.openaikey`, source spreadsheets, or build output.
2. Import the repository into Vercel as a Next.js project.
3. Add all variables from `.env.example` under Project Settings -> Environment Variables.
4. Deploy; no database or background service is required.
5. Test one direct prompt and one clarification flow from an incognito desktop window and a mobile viewport.
6. Confirm secrets are absent from browser source/network responses, then place the public URL in this README and the submission form.

The prototype has no end-user login so the evaluator can test it directly. For a longer-lived public deployment, set Groq usage limits and use Vercel rate limiting/firewall controls to reduce indirect API-key abuse.

## Assumptions And Trade-offs

- The imported boards retain source titles and values.
- Public demo credentials are held server-side so reviewers need no local setup.
- The narrow intent catalog is deliberate: accurate, explainable answers are preferred to broad unsupported claims.
- Live reads are uncached for a clear dynamic-data demonstration. A larger deployment should add short-lived caching with visible retrieval timestamps and invalidation rules.
- Conversation state exists only in the browser and resets on refresh.
- Styling is intentionally a single focused chat, not a dashboard.

## Challenges And Improvements

The main data constraint is the lack of a cross-board key, followed by missing collection values, malformed Deal rows, ambiguous sector labels, inconsistent statuses, and unknown Deal-value units. With more time, add a governed semantic layer, an authoritative deal/work-order key, source freshness metadata, authentication/RBAC, cached reads, observability, broader date/cohort analytics, and fuller end-to-end tests.

## AI Tools Used

OpenCode with GPT-5.6 was used for assignment analysis, dataset profiling, planning, implementation assistance, and code-review passes. Groq `openai/gpt-oss-120b` is the runtime query planner using strict non-streaming JSON Schema output. The implementation was checked with deterministic tests, TypeScript, and the Next.js production build. The runtime LLM is limited to validated query planning and clarification; it is not trusted for business calculations.

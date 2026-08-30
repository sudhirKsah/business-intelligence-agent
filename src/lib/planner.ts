import { z } from "zod";
import type { GroqConfig } from "./config";
import {
  dateRangeSchema,
  pendingClarificationSchema,
  queryPlanSchema,
  type Clarification,
  type PendingClarification,
  type QueryPlan,
} from "./query";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const modelOutputSchema = z.object({
  action: z.enum(["query", "clarify", "unsupported"]),
  intent: z.enum(["deals_pipeline", "work_order_financials", "work_order_operations", "sector_brief"]).nullable(),
  sectors: z.array(z.string()).max(10),
  timeframe: z.enum(["all_time", "this_quarter", "explicit"]),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  groupBy: z.enum(["none", "probability"]).nullable(),
  financialMetric: z.enum(["snapshot", "contracted", "billed", "collected", "receivable", "still_to_bill"]).nullable(),
  operationView: z.enum(["execution_status", "billing_exceptions"]).nullable(),
  clarificationType: z.enum(["energy_sector", "financial_metric"]).nullable(),
  reasonCode: z.enum(["weighted_pipeline", "excluded_gst", "record_join", "overdue", "missing_sector", "unsupported"]).nullable(),
}).strict();

type ModelOutput = z.infer<typeof modelOutputSchema>;

export type PlannerDecision =
  | { kind: "query"; plan: QueryPlan }
  | { kind: "clarification"; clarification: Clarification }
  | { kind: "unsupported"; message: string };

export class PlannerError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = "PlannerError";
  }
}

const OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["query", "clarify", "unsupported"] },
    intent: {
      anyOf: [
        { type: "string", enum: ["deals_pipeline", "work_order_financials", "work_order_operations", "sector_brief"] },
        { type: "null" },
      ],
    },
    sectors: { type: "array", maxItems: 10, items: { type: "string" } },
    timeframe: { type: "string", enum: ["all_time", "this_quarter", "explicit"] },
    startDate: { anyOf: [{ type: "string" }, { type: "null" }] },
    endDate: { anyOf: [{ type: "string" }, { type: "null" }] },
    groupBy: { anyOf: [{ type: "string", enum: ["none", "probability"] }, { type: "null" }] },
    financialMetric: {
      anyOf: [
        { type: "string", enum: ["snapshot", "contracted", "billed", "collected", "receivable", "still_to_bill"] },
        { type: "null" },
      ],
    },
    operationView: { anyOf: [{ type: "string", enum: ["execution_status", "billing_exceptions"] }, { type: "null" }] },
    clarificationType: { anyOf: [{ type: "string", enum: ["energy_sector", "financial_metric"] }, { type: "null" }] },
    reasonCode: {
      anyOf: [
        { type: "string", enum: ["weighted_pipeline", "excluded_gst", "record_join", "overdue", "missing_sector", "unsupported"] },
        { type: "null" },
      ],
    },
  },
  required: [
    "action",
    "intent",
    "sectors",
    "timeframe",
    "startDate",
    "endDate",
    "groupBy",
    "financialMetric",
    "operationView",
    "clarificationType",
    "reasonCode",
  ],
} as const;

const SYSTEM_PROMPT = `You plan read-only business intelligence queries. Never calculate a result and never invent data.

Supported intents:
- deals_pipeline: Open Deal count/value and closure-probability distribution. Pipeline time uses Tentative Close Date.
- work_order_financials: direct inclusive-GST contracted, billed, recorded collected, receivable, still-to-bill, or snapshot.
- work_order_operations: execution-status distribution or billing exceptions.
- sector_brief: independent Deals pipeline and Work Orders aggregates for one or more exact source sectors. Never request a row join.

Rules:
- Return only the required JSON schema.
- Extract exact named sectors without broadening them.
- "What is the Work Order execution-status distribution?" is work_order_operations with operationView=execution_status and no sectors.
- "Give me the Work Order financial snapshot" is work_order_financials with financialMetric=snapshot and no sectors.
- "Compare Renewables pipeline and Work Order health across both boards" is sector_brief with sectors=["Renewables"].
- Questions about Open Deal probability distribution are deals_pipeline with groupBy=probability.
- "this quarter" means timeframe=this_quarter. Explicit periods use ISO startDate/endDate.
- If "energy" is not explicitly defined as Renewables and/or Powerline, use action=clarify and clarificationType=energy_sector while retaining the likely intent.
- Unqualified "revenue" uses action=clarify and clarificationType=financial_metric.
- Weighted forecasts, excluded-GST requests, overdue analysis, and record-level cross-board journeys are unsupported.
- If no sector is supplied for sector_brief, return unsupported with reasonCode=missing_sector.
- Use all_time and null dates unless the user asks for a period.`;

function isoDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function currentQuarterRange(now = new Date()): { start: string; end: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
  const endDate = new Date(Date.UTC(year, quarterStartMonth + 2, 0));
  return {
    start: isoDate(year, quarterStartMonth, 1),
    end: isoDate(year, quarterStartMonth + 2, endDate.getUTCDate()),
  };
}

function dateRangeFromOutput(output: ModelOutput, now: Date) {
  if (output.timeframe === "all_time") return null;
  if (output.timeframe === "this_quarter") return currentQuarterRange(now);
  if (!output.startDate || !output.endDate) {
    throw new PlannerError("The requested period could not be understood. Please use explicit dates.", false);
  }
  const parsed = dateRangeSchema.safeParse({ start: output.startDate, end: output.endDate });
  if (!parsed.success) throw new PlannerError("The requested period contains an invalid calendar date.", false);
  return parsed.data;
}

function planFromOutput(output: ModelOutput, now: Date): QueryPlan {
  const dateRange = dateRangeFromOutput(output, now);
  switch (output.intent) {
    case "deals_pipeline":
      if (!output.groupBy) throw new PlannerError("The query planner omitted the pipeline grouping mode.", false);
      return queryPlanSchema.parse({
        intent: output.intent,
        sectors: output.sectors,
        dateRange,
        groupBy: output.groupBy,
      });
    case "work_order_financials":
      if (dateRange) throw new PlannerError("Time-filtered Work Order financials need a date basis that this MVP does not assume.", false);
      if (!output.financialMetric) throw new PlannerError("The query planner omitted the financial metric.", false);
      return queryPlanSchema.parse({
        intent: output.intent,
        sectors: output.sectors,
        dateRange: null,
        metric: output.financialMetric,
      });
    case "work_order_operations":
      if (dateRange) throw new PlannerError("Time-filtered Work Order operations need a date basis that this MVP does not assume.", false);
      if (!output.operationView) throw new PlannerError("The query planner omitted the operations view.", false);
      return queryPlanSchema.parse({
        intent: output.intent,
        sectors: output.sectors,
        dateRange: null,
        view: output.operationView,
      });
    case "sector_brief":
      if (dateRange) {
        throw new PlannerError("Time-bound cross-board briefs are unavailable because Work Orders have no agreed date basis.", false);
      }
      return queryPlanSchema.parse({
        intent: output.intent,
        sectors: output.sectors,
        dateRange,
      });
    default:
      throw new PlannerError("That question is outside the supported query set.", false);
  }
}

function clarificationFor(type: "energy_sector" | "financial_metric", basePlan: QueryPlan): Clarification {
  if (type === "energy_sector") {
    return {
      question: "What should Energy mean for this query?",
      options: ["Renewables", "Powerline", "Renewables + Powerline"],
      pending: { type, basePlan: { ...basePlan, sectors: ["Renewables", "Powerline"] } },
    };
  }
  return {
    question: "Which measure should I use? Work Order measures below include GST.",
    options: ["Open deal value", "Contracted", "Billed", "Recorded collected", "Receivable", "Still to bill"],
    pending: { type, sectors: basePlan.sectors, dateRange: basePlan.dateRange },
  };
}

function unsupportedMessage(reason: ModelOutput["reasonCode"]): string {
  switch (reason) {
    case "weighted_pipeline":
      return "Weighted pipeline is not available because numeric High/Medium/Low probability weights were not supplied.";
    case "excluded_gst":
      return "This MVP supports the direct Work Order financial columns including GST, not excluded-GST analysis.";
    case "record_join":
      return "A deal-to-delivery journey is not safe because the boards do not share a trustworthy record-level key.";
    case "overdue":
      return "Overdue receivables cannot be calculated because payment due dates or terms were not supplied.";
    case "missing_sector":
      return "Name a source sector such as Renewables, Powerline, Mining, or Railways for a cross-board brief.";
    default:
      return "I can answer Open pipeline, Work Order financial, execution-status, billing-exception, and exact-sector comparison questions.";
  }
}

async function requestModel(config: GroqConfig, question: string, fetchImpl: FetchLike): Promise<ModelOutput> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          max_completion_tokens: 2_048,
          reasoning_effort: "medium",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: question },
          ],
          response_format: {
            type: "json_schema",
            json_schema: { name: "business_query_plan", strict: true, schema: OUTPUT_JSON_SCHEMA },
          },
        }),
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt === 0) continue;
        throw new PlannerError("The query planner is unavailable.", retryable);
      }
      const body = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (!content) throw new PlannerError("The query planner returned an empty response.", false);
      return modelOutputSchema.parse(JSON.parse(content));
    } catch (error) {
      if (error instanceof PlannerError) throw error;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new PlannerError("The query planner returned an invalid plan.", false);
      }
      if (attempt === 0) continue;
      throw new PlannerError("The query planner is temporarily unavailable.", true);
    }
  }
  throw new PlannerError("The query planner is temporarily unavailable.", true);
}

function forcedBoundary(question: string): ModelOutput["reasonCode"] | null {
  const value = question.toLowerCase();
  if (/\bweighted\b|expected pipeline|probability[- ]adjusted|forecast.*probab/.test(value)) return "weighted_pipeline";
  if (/exclud(?:e|ed|ing) gst|without gst|excl\.? gst/.test(value)) return "excluded_gst";
  if (/\boverdue\b/.test(value)) return "overdue";
  if (/(deal|customer).*(delivery|work order|execution)|journey.*(deal|customer)/.test(value)) return "record_join";
  return null;
}

function sectorAppearsInQuestion(question: string, sector: string): boolean {
  const normalizedQuestion = question.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const normalizedSector = sector.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const singularSector = normalizedSector.endsWith("s") ? normalizedSector.slice(0, -1) : normalizedSector;
  return normalizedQuestion.includes(normalizedSector) || normalizedQuestion.includes(singularSector);
}

export async function planQuestion(
  question: string,
  config: GroqConfig,
  now = new Date(),
  fetchImpl: FetchLike = fetch,
): Promise<PlannerDecision> {
  const boundary = forcedBoundary(question);
  if (boundary) return { kind: "unsupported", message: unsupportedMessage(boundary) };

  const output = await requestModel(config, question, fetchImpl);
  if (output.action === "unsupported") {
    return { kind: "unsupported", message: unsupportedMessage(output.reasonCode) };
  }

  const ambiguousEnergy = /\benergy\b/i.test(question) && !/renewables?|powerline/i.test(question);
  const unqualifiedRevenue = /\brevenue\b/i.test(question)
    && !/deal value|contract|bill|collect|receiv|still to bill/i.test(question);
  const clarificationType = ambiguousEnergy
    ? "energy_sector"
    : unqualifiedRevenue
      ? "financial_metric"
      : output.action === "clarify"
        ? output.clarificationType
        : null;
  if (output.action === "clarify" && !clarificationType) {
    throw new PlannerError("The query planner requested an unsupported clarification.", false);
  }
  if (output.action === "query" && (output.clarificationType || output.reasonCode)) {
    throw new PlannerError("The query planner returned inconsistent instructions.", false);
  }
  if (!ambiguousEnergy && output.sectors.some((sector) => !sectorAppearsInQuestion(question, sector))) {
    throw new PlannerError("The query planner introduced a sector that was not in the question.", false);
  }
  let plan: QueryPlan;
  try {
    if (clarificationType === "financial_metric") {
      plan = {
        intent: "work_order_financials",
        sectors: output.sectors,
        dateRange: dateRangeFromOutput(output, now),
        metric: "snapshot",
      };
    } else if (clarificationType === "energy_sector") {
      const dateRange = dateRangeFromOutput(output, now);
      if (output.intent === "work_order_financials") {
        if (dateRange) throw new PlannerError("Time-filtered Work Order financials need an agreed date basis.", false);
        plan = {
          intent: "work_order_financials",
          sectors: ["Renewables", "Powerline"],
          dateRange: null,
          metric: output.financialMetric || "snapshot",
        };
      } else if (output.intent === "work_order_operations") {
        if (dateRange) throw new PlannerError("Time-filtered Work Order operations need an agreed date basis.", false);
        plan = {
          intent: "work_order_operations",
          sectors: ["Renewables", "Powerline"],
          dateRange: null,
          view: output.operationView || "execution_status",
        };
      } else if (output.intent === "sector_brief" || /across|both boards|work order/i.test(question)) {
        plan = { intent: "sector_brief", sectors: ["Renewables", "Powerline"], dateRange };
      } else {
        plan = {
          intent: "deals_pipeline",
          sectors: ["Renewables", "Powerline"],
          dateRange,
          groupBy: output.groupBy || "none",
        };
      }
    } else if (output.intent) {
      plan = planFromOutput(output, now);
    } else {
      throw new PlannerError("The query planner did not select a supported intent.", false);
    }
  } catch (error) {
    if (error instanceof PlannerError) throw error;
    if (error instanceof z.ZodError) throw new PlannerError("The query planner returned an invalid plan.", false);
    throw error;
  }
  if (plan.intent === "sector_brief" && plan.dateRange) {
    return { kind: "unsupported", message: "Time-bound cross-board briefs are unavailable because Work Orders have no agreed date basis." };
  }
  if (clarificationType) {
    return { kind: "clarification", clarification: clarificationFor(clarificationType, plan) };
  }
  return { kind: "query", plan };
}

function financialMetric(answer: string): Extract<QueryPlan, { intent: "work_order_financials" }>["metric"] | "deal_value" | null {
  const value = answer.toLowerCase();
  if (/deal/.test(value)) return "deal_value";
  if (/contract/.test(value)) return "contracted";
  if (/still.*bill|unbill/.test(value)) return "still_to_bill";
  if (/collect/.test(value)) return "collected";
  if (/receiv/.test(value)) return "receivable";
  if (/bill/.test(value)) return "billed";
  return null;
}

export function resolveClarification(pendingInput: PendingClarification, answer: string): PlannerDecision {
  const pending = pendingClarificationSchema.parse(pendingInput);
  if (pending.type === "energy_sector") {
    const value = answer.toLowerCase();
    const sectors = /both|renewables?.*(?:\+|and).*powerline|powerline.*(?:\+|and).*renewables?/.test(value)
      ? ["Renewables", "Powerline"]
      : /renewable/.test(value)
        ? ["Renewables"]
        : /powerline/.test(value)
          ? ["Powerline"]
          : null;
    if (!sectors) return { kind: "clarification", clarification: clarificationFor("energy_sector", pending.basePlan) };
    const plan = queryPlanSchema.parse({ ...pending.basePlan, sectors });
    if (plan.dateRange && plan.intent !== "deals_pipeline") {
      return {
        kind: "unsupported",
        message: "This time filter can only be applied to Deals pipeline because no Work Order date basis was agreed.",
      };
    }
    return { kind: "query", plan };
  }

  const metric = financialMetric(answer);
  if (!metric) {
    const basePlan = queryPlanSchema.parse({
      intent: "work_order_financials",
      sectors: pending.sectors,
      dateRange: pending.dateRange,
      metric: "snapshot",
    });
    return { kind: "clarification", clarification: clarificationFor("financial_metric", basePlan) };
  }
  if (metric === "deal_value") {
    return {
      kind: "query",
      plan: { intent: "deals_pipeline", sectors: pending.sectors, dateRange: pending.dateRange, groupBy: "none" },
    };
  }
  if (pending.dateRange) {
    return {
      kind: "unsupported",
      message: "Time-filtered Work Order financials are unavailable because no financial date basis was agreed. Ask for the all-time metric or choose Open deal value.",
    };
  }
  return {
    kind: "query",
    plan: { intent: "work_order_financials", sectors: pending.sectors, dateRange: null, metric },
  };
}

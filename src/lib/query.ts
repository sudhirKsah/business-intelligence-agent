import { z } from "zod";

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}, "Invalid calendar date");

export const dateRangeSchema = z.object({
  start: isoDateSchema,
  end: isoDateSchema,
}).refine((range) => range.start <= range.end, "Date range start must not follow its end");

const sharedPlanFields = {
  sectors: z.array(z.string().min(1)).max(10),
  dateRange: dateRangeSchema.nullable(),
};

export const queryPlanSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("deals_pipeline"),
    ...sharedPlanFields,
    groupBy: z.enum(["none", "probability"]),
  }),
  z.object({
    intent: z.literal("work_order_financials"),
    ...sharedPlanFields,
    metric: z.enum(["snapshot", "contracted", "billed", "collected", "receivable", "still_to_bill"]),
  }),
  z.object({
    intent: z.literal("work_order_operations"),
    ...sharedPlanFields,
    view: z.enum(["execution_status", "billing_exceptions"]),
  }),
  z.object({
    intent: z.literal("sector_brief"),
    sectors: z.array(z.string().min(1)).min(1).max(10),
    dateRange: dateRangeSchema.nullable(),
  }),
]);

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const pendingClarificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("energy_sector"),
    basePlan: queryPlanSchema,
  }),
  z.object({
    type: z.literal("financial_metric"),
    sectors: z.array(z.string().min(1)).max(10),
    dateRange: dateRangeSchema.nullable(),
  }),
]);

export type PendingClarification = z.infer<typeof pendingClarificationSchema>;

export type Clarification = {
  question: string;
  options: string[];
  pending: PendingClarification;
};

export type AnswerSection = {
  label: string;
  value: string;
  detail?: string;
};

export type SourceMeta = {
  board: string;
  rawItems: number;
  analyzedItems: number;
  retrievedAt: string;
};

export type BiAnswer = {
  summary: string;
  numbers: AnswerSection[];
  insights: string[];
  caveats: string[];
  sources: SourceMeta[];
};

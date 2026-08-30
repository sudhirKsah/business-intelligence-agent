import { z } from "zod";

const mondaySchema = z.object({
  token: z.string().min(1, "MONDAY_API_TOKEN is missing"),
  dealsBoardId: z.string().regex(/^\d+$/, "MONDAY_DEALS_BOARD_ID must be numeric"),
  workOrdersBoardId: z.string().regex(/^\d+$/, "MONDAY_WORK_ORDERS_BOARD_ID must be numeric"),
  apiVersion: z.string().optional(),
});

const groqSchema = z.object({
  apiKey: z.string().min(1, "GROQ_API_KEY is missing"),
  model: z.string().min(1),
});

export type MondayConfig = z.infer<typeof mondaySchema>;
export type GroqConfig = z.infer<typeof groqSchema>;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseConfig<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ConfigurationError(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

export function getMondayConfig(): MondayConfig {
  return parseConfig(mondaySchema, {
    token: process.env.MONDAY_API_TOKEN,
    dealsBoardId: process.env.MONDAY_DEALS_BOARD_ID,
    workOrdersBoardId: process.env.MONDAY_WORK_ORDERS_BOARD_ID,
    apiVersion: process.env.MONDAY_API_VERSION || undefined,
  });
}

export function getGroqConfig(): GroqConfig {
  return parseConfig(groqSchema, {
    apiKey: process.env.GROQ_API_KEY,
    model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  });
}

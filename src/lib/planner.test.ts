import { describe, expect, it, vi } from "vitest";
import type { GroqConfig } from "./config";
import { currentQuarterRange, planQuestion, resolveClarification } from "./planner";

const config: GroqConfig = { apiKey: "test-key", model: "test-model" };

function modelResponse(output: Record<string, unknown>) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const energyOutput = {
  action: "clarify",
  intent: "deals_pipeline",
  sectors: [],
  timeframe: "this_quarter",
  startDate: null,
  endDate: null,
  groupBy: null,
  financialMetric: null,
  operationView: null,
  clarificationType: "energy_sector",
  reasonCode: null,
};

describe("query planner and clarification state", () => {
  it("calculates calendar quarters in Asia/Kolkata deterministically", () => {
    expect(currentQuarterRange(new Date("2026-02-15T10:00:00Z"))).toEqual({ start: "2026-01-01", end: "2026-03-31" });
  });

  it("preserves the planned query through an Energy clarification", async () => {
    const fetchMock = vi.fn().mockResolvedValue(modelResponse(energyOutput));
    const decision = await planQuestion(
      "How is our energy pipeline this quarter?",
      config,
      new Date("2026-02-15T10:00:00Z"),
      fetchMock,
    );

    expect(decision.kind).toBe("clarification");
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.groq.com/openai/v1/chat/completions");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(requestBody).toMatchObject({
      model: "test-model",
      temperature: 0,
      reasoning_effort: "medium",
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(requestBody.stream).toBeUndefined();
    if (decision.kind !== "clarification") throw new Error("Expected clarification");
    const resolved = resolveClarification(decision.clarification.pending, "Renewables + Powerline");
    expect(resolved).toEqual({
      kind: "query",
      plan: {
        intent: "deals_pipeline",
        sectors: ["Renewables", "Powerline"],
        dateRange: { start: "2026-01-01", end: "2026-03-31" },
        groupBy: "none",
      },
    });
  });

  it("resolves a financial clarification only to supported deterministic metrics", () => {
    const result = resolveClarification({ type: "financial_metric", sectors: [], dateRange: null }, "Recorded collected");
    expect(result).toEqual({
      kind: "query",
      plan: { intent: "work_order_financials", sectors: [], dateRange: null, metric: "collected" },
    });
  });

  it("blocks unsupported weighted pipeline before calling the LLM", async () => {
    const fetchMock = vi.fn();
    const decision = await planQuestion("What is our weighted pipeline?", config, new Date(), fetchMock);
    expect(decision).toMatchObject({ kind: "unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves a revenue period when the user selects Open deal value", async () => {
    const output = {
      ...energyOutput,
      intent: "work_order_financials",
      clarificationType: "financial_metric",
      timeframe: "explicit",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    };
    const decision = await planQuestion("What was revenue in Q1 2026?", config, new Date(), vi.fn().mockResolvedValue(modelResponse(output)));
    expect(decision.kind).toBe("clarification");
    if (decision.kind !== "clarification") throw new Error("Expected clarification");
    expect(resolveClarification(decision.clarification.pending, "Open deal value")).toEqual({
      kind: "query",
      plan: {
        intent: "deals_pipeline",
        sectors: [],
        dateRange: { start: "2026-01-01", end: "2026-03-31" },
        groupBy: "none",
      },
    });
  });

  it("rejects invalid calendar dates from the model", async () => {
    const output = {
      ...energyOutput,
      action: "query",
      clarificationType: null,
      timeframe: "explicit",
      startDate: "2026-02-30",
      endDate: "2026-03-31",
    };
    await expect(planQuestion("Open pipeline from February 30 to March 31 2026", config, new Date(), vi.fn().mockResolvedValue(modelResponse(output))))
      .rejects.toMatchObject({ name: "PlannerError", retryable: false });
  });

  it("rejects a query plan that omits its intent-specific metric", async () => {
    const output = {
      ...energyOutput,
      action: "query",
      intent: "work_order_financials",
      timeframe: "all_time",
      clarificationType: null,
      financialMetric: null,
    };
    await expect(planQuestion("Give me the Work Order financial snapshot", config, new Date(), vi.fn().mockResolvedValue(modelResponse(output))))
      .rejects.toMatchObject({ name: "PlannerError", retryable: false });
  });

  it("does not let client clarification state apply Deal dates to Work Orders", () => {
    const result = resolveClarification({
      type: "energy_sector",
      basePlan: {
        intent: "work_order_operations",
        sectors: ["Renewables", "Powerline"],
        dateRange: { start: "2026-01-01", end: "2026-03-31" },
        view: "execution_status",
      },
    }, "Renewables");
    expect(result).toMatchObject({ kind: "unsupported" });
  });
});

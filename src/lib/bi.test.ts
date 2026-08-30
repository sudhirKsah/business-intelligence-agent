import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  calculateDealsPipeline,
  calculateSectorBrief,
  calculateWorkOrderFinancials,
  calculateWorkOrderOperations,
} from "./bi";
import type { DealRecord, FieldValue, NormalizedBoard, WorkOrderRecord } from "./normalize";

function field<T>(value: T | null, state: "valid" | "missing" | "invalid" = value === null ? "missing" : "valid"): FieldValue<T> {
  return { value, state, raw: value === null ? null : String(value) };
}

function deal(id: string, value: string | null, sector = "Renewables", probability: string | null = "High"): DealRecord {
  return {
    itemId: id,
    name: id,
    status: field("Open"),
    probability: field(probability),
    sector: field(sector),
    tentativeCloseDate: field("2026-02-01"),
    maskedValue: field(value === null ? null : new Decimal(value)),
  };
}

function workOrder(id: string, overrides: Partial<WorkOrderRecord> = {}): WorkOrderRecord {
  return {
    itemId: id,
    name: id,
    sector: field("Renewables"),
    executionStatus: field("Completed"),
    invoiceStatus: field("Fully Billed"),
    workOrderStatus: field("Open"),
    contractIncludingGst: field(new Decimal(200)),
    billedIncludingGst: field(new Decimal(100)),
    collectedAmount: field(new Decimal(50)),
    stillToBillIncludingGst: field(new Decimal(100)),
    receivable: field(new Decimal(50)),
    ...overrides,
  };
}

function board<T>(name: string, records: T[]): NormalizedBoard<T> {
  return { records, issues: [], rawCount: records.length, excludedCount: 0, retrievedAt: "2026-01-01T00:00:00.000Z", boardName: name };
}

describe("deterministic BI calculations", () => {
  it("sums only valid Deal values and reports coverage", () => {
    const answer = calculateDealsPipeline(board("Deals", [deal("1", "100.1", "Renewables", "High"), deal("2", "200.2", "Renewables", "HIGH"), deal("3", null)]), {
      intent: "deals_pipeline",
      sectors: [],
      dateRange: null,
      groupBy: "probability",
    });

    expect(answer.numbers[0].value).toBe("3");
    expect(answer.numbers[1]).toMatchObject({ value: "300.30 masked-value units", detail: "2/3 values present, 1 missing" });
    expect(answer.numbers.filter((number) => number.label.toLowerCase() === "high probability")).toHaveLength(1);
    expect(answer.caveats.join(" ")).toContain("no deduplication");
  });

  it("calculates financial totals and ratios without floating-point drift", () => {
    const answer = calculateWorkOrderFinancials(board("Work Orders", [
      workOrder("1"),
      workOrder("2", { collectedAmount: field<Decimal>(null) }),
    ]), {
      intent: "work_order_financials",
      sectors: [],
      dateRange: null,
      metric: "snapshot",
    });

    expect(answer.numbers.find((number) => number.label === "Contracted")?.value).toBe("INR 400.00");
    expect(answer.insights).toContain("Billed value is 50.00% of contracted value.");
    expect(answer.insights.join(" ")).toContain("not a collection rate");
    expect(answer.caveats.join(" ")).toContain("1/2 values present");
  });

  it("does not present entirely missing financial fields as real zeroes", () => {
    const answer = calculateWorkOrderFinancials(board("Work Orders", [
      workOrder("1", { contractIncludingGst: field<Decimal>(null) }),
    ]), {
      intent: "work_order_financials",
      sectors: [],
      dateRange: null,
      metric: "snapshot",
    });

    expect(answer.numbers.find((number) => number.label === "Contracted")?.value).toBe("Unavailable");
    expect(answer.insights.join(" ")).not.toContain("Billed value is");
    expect(answer.caveats.join(" ")).toContain("Contracted coverage is incomplete");
  });

  it("keeps blank invoice status out of explicit billing exceptions", () => {
    const answer = calculateWorkOrderOperations(board("Work Orders", [
      workOrder("1"),
      workOrder("2", { invoiceStatus: field("Not billed yet") }),
      workOrder("3", { invoiceStatus: field<string>(null) }),
    ]), {
      intent: "work_order_operations",
      sectors: [],
      dateRange: null,
      view: "billing_exceptions",
    });

    expect(answer.numbers).toEqual([
      { label: "Fully Billed + WO Open", value: "1" },
      { label: "Completed + Not billed yet", value: "1" },
    ]);
  });

  it("returns separate cross-board sector aggregates", () => {
    const answer = calculateSectorBrief(
      board("Deals", [deal("d1", "75")]),
      board("Work Orders", [workOrder("w1")]),
      { intent: "sector_brief", sectors: ["Renewables"], dateRange: null },
    );

    expect(answer.summary).toContain("separate Deals and Work Orders aggregates");
    expect(answer.numbers.find((number) => number.label === "Open Deals")?.value).toBe("1");
    expect(answer.numbers.find((number) => number.label === "Work Order items")?.value).toBe("1");
    expect(answer.caveats.join(" ")).toContain("no trustworthy record-level key");
  });
});

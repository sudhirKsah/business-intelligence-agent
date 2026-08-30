import { describe, expect, it } from "vitest";
import { normalizeDeals, parseDate, parseDecimal, parseText } from "./normalize";
import type { MondayBoard, MondayColumn, MondayItem } from "./types";

function dealBoard(items: MondayItem[]): MondayBoard {
  const titles = ["Deal Status", "Closure Probability", "Sector/service", "Tentative Close Date", "Masked Deal value"];
  const columns: MondayColumn[] = titles.map((title, index) => ({ id: `c${index}`, title, type: "text" }));
  return { id: "1", name: "Deals", columns, items, retrievedAt: "2026-01-01T00:00:00.000Z" };
}

function item(id: string, name: string, values: Array<string | null>): MondayItem {
  return {
    id,
    name,
    column_values: values.map((text, index) => ({ id: `c${index}`, type: "text", text, value: null })),
  };
}

describe("normalization rules", () => {
  it("distinguishes missing, zero, invalid, and negative values", () => {
    expect(parseText(" NA ").state).toBe("missing");
    expect(parseDecimal("0").value?.toString()).toBe("0");
    expect(parseDecimal("#VALUE!").state).toBe("invalid");
    expect(parseDecimal("-1.25").value?.toString()).toBe("-1.25");
    expect(parseDecimal("INR 1,234.50").value?.toString()).toBe("1234.5");
  });

  it("parses full dates but never invents a year for month-only text", () => {
    expect(parseDate("2026-02-28").value).toBe("2026-02-28");
    expect(parseDate("31/01/2026").value).toBe("2026-01-31");
    expect(parseDate("2026-02-30").state).toBe("invalid");
    expect(parseDate("July").state).toBe("invalid");
  });

  it("excludes an embedded Deal header and retains questionable sector labels", () => {
    const normalized = normalizeDeals(dealBoard([
      item("1", "Deal Name", ["Deal Status", "Closure Probability", "Sector/service", "Tentative Close Date", "Masked Deal value"]),
      item("2", "Example", ["Open", "High", "Tender", "2026-02-01", "100"]),
    ]));

    expect(normalized.rawCount).toBe(2);
    expect(normalized.records).toHaveLength(1);
    expect(normalized.excludedCount).toBe(1);
    expect(normalized.issues.map((issue) => issue.code)).toEqual(["malformed_row", "non_sector_label"]);
  });

  it("reads monday Date JSON and detects repeated headers even with a different item name", () => {
    const board = dealBoard([
      item("1", "Imported row", ["Deal Status", "Closure Probability", "Sector/service", "Tentative Close Date", "Masked Deal value"]),
      item("2", "Real deal", ["Open", "High", "Mining", null, "5"]),
    ]);
    board.items[1].column_values[3] = {
      id: "c3",
      type: "date",
      text: null,
      value: JSON.stringify({ date: "2026-03-10", changed_at: "2026-01-01" }),
    };

    const normalized = normalizeDeals(board);
    expect(normalized.records).toHaveLength(1);
    expect(normalized.records[0].tentativeCloseDate.value).toBe("2026-03-10");
    expect(normalized.excludedCount).toBe(1);
  });
});

import Decimal from "decimal.js";
import type { DataIssue, MondayBoard, MondayColumn, MondayItem } from "./types";

export type FieldState = "valid" | "missing" | "invalid";

export type FieldValue<T> = {
  value: T | null;
  state: FieldState;
  raw: string | null;
};

export type DealRecord = {
  itemId: string;
  name: string;
  status: FieldValue<string>;
  probability: FieldValue<string>;
  sector: FieldValue<string>;
  tentativeCloseDate: FieldValue<string>;
  maskedValue: FieldValue<Decimal>;
};

export type WorkOrderRecord = {
  itemId: string;
  name: string;
  sector: FieldValue<string>;
  executionStatus: FieldValue<string>;
  invoiceStatus: FieldValue<string>;
  workOrderStatus: FieldValue<string>;
  contractIncludingGst: FieldValue<Decimal>;
  billedIncludingGst: FieldValue<Decimal>;
  collectedAmount: FieldValue<Decimal>;
  stillToBillIncludingGst: FieldValue<Decimal>;
  receivable: FieldValue<Decimal>;
};

export type NormalizedBoard<T> = {
  records: T[];
  issues: DataIssue[];
  rawCount: number;
  excludedCount: number;
  retrievedAt: string;
  boardName: string;
};

type FieldIds<T extends string> = Record<T, string>;

const MISSING_VALUES = new Set(["", "na", "n/a", "none", "null"]);

export class BoardSchemaError extends Error {
  constructor(public readonly missingColumns: string[]) {
    super(`Missing required monday.com columns: ${missingColumns.join(", ")}`);
    this.name = "BoardSchemaError";
  }
}

export function normalizeColumnTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function resolveFieldIds<T extends string>(
  columns: MondayColumn[],
  definitions: Record<T, { label: string; aliases: string[] }>,
): FieldIds<T> {
  const byTitle = new Map(columns.map((column) => [normalizeColumnTitle(column.title), column.id]));
  const resolved = {} as FieldIds<T>;
  const missing: string[] = [];

  for (const [key, definition] of Object.entries(definitions) as Array<[
    T,
    { label: string; aliases: string[] },
  ]>) {
    const columnId = definition.aliases
      .map(normalizeColumnTitle)
      .map((alias) => byTitle.get(alias))
      .find(Boolean);
    if (columnId) resolved[key] = columnId;
    else missing.push(definition.label);
  }

  if (missing.length) throw new BoardSchemaError(missing);
  return resolved;
}

function readCell(item: MondayItem, columnId: string): string | null {
  const cell = item.column_values.find((value) => value.id === columnId);
  if (!cell) return null;
  if (cell.text?.trim()) return cell.text;
  if (!cell.value) return cell.text ?? null;
  try {
    const parsed = JSON.parse(cell.value) as unknown;
    if (typeof parsed === "string" || typeof parsed === "number") return String(parsed);
    if (parsed && typeof parsed === "object" && "date" in parsed && typeof parsed.date === "string") {
      return parsed.date;
    }
  } catch {
    // Some Text/Number column values are returned as plain strings rather than JSON.
  }
  return cell.value;
}

function cleanedRaw(raw: string | null): string | null {
  if (raw === null) return null;
  return raw.trim().replace(/\s+/g, " ");
}

export function parseText(raw: string | null): FieldValue<string> {
  const cleaned = cleanedRaw(raw);
  if (cleaned === null || MISSING_VALUES.has(cleaned.toLowerCase())) {
    return { value: null, state: "missing", raw: cleaned };
  }
  return { value: cleaned, state: "valid", raw: cleaned };
}

export function parseDecimal(raw: string | null): FieldValue<Decimal> {
  const text = parseText(raw);
  if (text.state !== "valid" || text.value === null) {
    return { value: null, state: text.state, raw: text.raw };
  }

  const cleaned = text.value
    .replace(/,/g, "")
    .replace(/^(?:inr|rs\.?|\u20b9)\s*/i, "")
    .trim();
  try {
    const value = new Decimal(cleaned);
    if (!value.isFinite()) throw new Error("not finite");
    return { value, state: "valid", raw: text.raw };
  } catch {
    return { value: null, state: "invalid", raw: text.raw };
  }
}

export function parseDate(raw: string | null): FieldValue<string> {
  const text = parseText(raw);
  if (text.state !== "valid" || text.value === null) {
    return { value: null, state: text.state, raw: text.raw };
  }

  const iso = text.value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  const dayFirst = text.value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  const parts = iso
    ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : dayFirst
      ? [Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1])]
      : null;
  if (!parts) return { value: null, state: "invalid", raw: text.raw };

  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    return { value: null, state: "invalid", raw: text.raw };
  }
  const value = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { value, state: "valid", raw: text.raw };
}

function canonicalCategory(field: FieldValue<string>, aliases: Record<string, string>): FieldValue<string> {
  if (field.value === null) return field;
  const key = field.value.toLowerCase().replace(/\s+/g, " ");
  return { ...field, value: aliases[key] || field.value };
}

const STATUS_ALIASES: Record<string, string> = {
  open: "Open",
  won: "Won",
  dead: "Dead",
  "on hold": "On Hold",
  completed: "Completed",
  ongoing: "Ongoing",
  "not started": "Not Started",
  "not billed yet": "Not billed yet",
  "fully billed": "Fully Billed",
  "partially billed": "Partially Billed",
  billed: "Billed",
  closed: "Closed",
};

function parseCategory(raw: string | null): FieldValue<string> {
  return canonicalCategory(parseText(raw), STATUS_ALIASES);
}

function isMalformedDealRow(item: MondayItem, fields: FieldIds<keyof typeof DEAL_FIELDS>): boolean {
  if (normalizeColumnTitle(item.name) === "dealname") return true;
  const repeatedHeaders = [
    [readCell(item, fields.status), "dealstatus"],
    [readCell(item, fields.probability), "closureprobability"],
    [readCell(item, fields.sector), "sectorservice"],
    [readCell(item, fields.tentativeCloseDate), "tentativeclosedate"],
    [readCell(item, fields.maskedValue), "maskeddealvalue"],
  ];
  return repeatedHeaders.filter(([value, expected]) => (
    typeof value === "string" && normalizeColumnTitle(value) === expected
  )).length >= 3;
}

const DEAL_FIELDS = {
  status: { label: "Deal Status", aliases: ["Deal Status"] },
  probability: { label: "Closure Probability", aliases: ["Closure Probability"] },
  sector: { label: "Sector/service", aliases: ["Sector/service", "Sector service"] },
  tentativeCloseDate: { label: "Tentative Close Date", aliases: ["Tentative Close Date"] },
  maskedValue: { label: "Masked Deal value", aliases: ["Masked Deal value"] },
};

const WORK_ORDER_FIELDS = {
  sector: { label: "Sector", aliases: ["Sector"] },
  executionStatus: { label: "Execution Status", aliases: ["Execution Status"] },
  invoiceStatus: { label: "Invoice Status", aliases: ["Invoice Status"] },
  workOrderStatus: { label: "WO Status", aliases: ["WO Status", "WO Status (billed)", "Work Order Status"] },
  contractIncludingGst: {
    label: "contract amount incl. GST",
    aliases: ["contract amount incl. GST", "contract amount including GST", "Amount in Rupees (Incl of GST) (Masked)"],
  },
  billedIncludingGst: {
    label: "billed value incl. GST",
    aliases: ["billed value incl. GST", "billed value including GST", "Billed Value in Rupees (Incl of GST.) (Masked)"],
  },
  collectedAmount: {
    label: "collected amount",
    aliases: ["collected amount", "collected amount incl. GST", "amount collected incl. GST", "Collected Amount in Rupees (Incl of GST.) (Masked)"],
  },
  stillToBillIncludingGst: {
    label: "amount still to bill incl. GST",
    aliases: ["amount still to bill incl. GST", "amount to bill incl. GST", "Amount to be billed in Rs. (Incl. of GST) (Masked)"],
  },
  receivable: { label: "amount receivable", aliases: ["amount receivable", "Amount Receivable (Masked)", "receivable"] },
};

export function normalizeDeals(board: MondayBoard): NormalizedBoard<DealRecord> {
  const fields = resolveFieldIds(board.columns, DEAL_FIELDS);
  const issues: DataIssue[] = [];
  const records: DealRecord[] = [];

  for (const item of board.items) {
    if (isMalformedDealRow(item, fields)) {
      issues.push({
        itemId: item.id,
        code: "malformed_row",
        message: "Embedded header row excluded from analytics",
      });
      continue;
    }
    const sector = parseCategory(readCell(item, fields.sector));
    if (sector.value === "Tender" || sector.value === "DSP") {
      issues.push({
        itemId: item.id,
        field: "sector",
        code: "non_sector_label",
        message: `${sector.value} appears in the source sector field but may not be a sector`,
      });
    }
    records.push({
      itemId: item.id,
      name: item.name,
      status: parseCategory(readCell(item, fields.status)),
      probability: parseCategory(readCell(item, fields.probability)),
      sector,
      tentativeCloseDate: parseDate(readCell(item, fields.tentativeCloseDate)),
      maskedValue: parseDecimal(readCell(item, fields.maskedValue)),
    });
  }

  return {
    records,
    issues,
    rawCount: board.items.length,
    excludedCount: board.items.length - records.length,
    retrievedAt: board.retrievedAt,
    boardName: board.name,
  };
}

export function normalizeWorkOrders(board: MondayBoard): NormalizedBoard<WorkOrderRecord> {
  const fields = resolveFieldIds(board.columns, WORK_ORDER_FIELDS);
  const issues: DataIssue[] = [];
  const records = board.items.map((item): WorkOrderRecord => ({
    itemId: item.id,
    name: item.name,
    sector: parseCategory(readCell(item, fields.sector)),
    executionStatus: parseCategory(readCell(item, fields.executionStatus)),
    invoiceStatus: parseCategory(readCell(item, fields.invoiceStatus)),
    workOrderStatus: parseCategory(readCell(item, fields.workOrderStatus)),
    contractIncludingGst: parseDecimal(readCell(item, fields.contractIncludingGst)),
    billedIncludingGst: parseDecimal(readCell(item, fields.billedIncludingGst)),
    collectedAmount: parseDecimal(readCell(item, fields.collectedAmount)),
    stillToBillIncludingGst: parseDecimal(readCell(item, fields.stillToBillIncludingGst)),
    receivable: parseDecimal(readCell(item, fields.receivable)),
  }));

  return {
    records,
    issues,
    rawCount: board.items.length,
    excludedCount: 0,
    retrievedAt: board.retrievedAt,
    boardName: board.name,
  };
}

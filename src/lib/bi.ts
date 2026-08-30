import Decimal from "decimal.js";
import type { DealRecord, FieldValue, NormalizedBoard, WorkOrderRecord } from "./normalize";
import type { BiAnswer, QueryPlan, SourceMeta } from "./query";

type DealsBoard = NormalizedBoard<DealRecord>;
type WorkOrdersBoard = NormalizedBoard<WorkOrderRecord>;

type FieldSummary = {
  sum: Decimal;
  valid: number;
  missing: number;
  invalid: number;
  total: number;
};

function sourceMeta<T>(board: NormalizedBoard<T>): SourceMeta {
  return {
    board: board.boardName,
    rawItems: board.rawCount,
    analyzedItems: board.records.length,
    retrievedAt: board.retrievedAt,
  };
}

function sameLabel(value: string | null, expected: string): boolean {
  return value?.trim().toLowerCase() === expected.trim().toLowerCase();
}

function inSectors(value: string | null, sectors: string[]): boolean {
  return sectors.length === 0 || sectors.some((sector) => sameLabel(value, sector));
}

function inDateRange(value: string | null, range: { start: string; end: string } | null): boolean {
  if (!range) return true;
  return value !== null && value >= range.start && value <= range.end;
}

function countGroups<T>(records: T[], select: (record: T) => string | null): Array<[string, number]> {
  const groups = new Map<string, { label: string; count: number }>();
  for (const record of records) {
    const label = select(record) || "Missing";
    const key = label.toLowerCase();
    const current = groups.get(key);
    if (current) current.count += 1;
    else groups.set(key, { label, count: 1 });
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .map((group) => [group.label, group.count]);
}

function summarizeField<T>(records: T[], select: (record: T) => FieldValue<Decimal>): FieldSummary {
  let sum = new Decimal(0);
  let valid = 0;
  let missing = 0;
  let invalid = 0;
  for (const record of records) {
    const field = select(record);
    if (field.state === "valid" && field.value !== null) {
      sum = sum.plus(field.value);
      valid += 1;
    } else if (field.state === "missing") {
      missing += 1;
    } else {
      invalid += 1;
    }
  }
  return { sum, valid, missing, invalid, total: records.length };
}

function formatDecimal(value: Decimal, places = 2): string {
  const [whole, fraction] = value.toFixed(places).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return places > 0 ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
}

function money(value: Decimal): string {
  return `INR ${formatDecimal(value)}`;
}

function masked(value: Decimal): string {
  return `${formatDecimal(value)} masked-value units`;
}

function coverageDetail(summary: FieldSummary): string {
  const parts = [`${summary.valid}/${summary.total} values present`];
  if (summary.missing) parts.push(`${summary.missing} missing`);
  if (summary.invalid) parts.push(`${summary.invalid} invalid`);
  return parts.join(", ");
}

function displayedMoney(summary: FieldSummary): string {
  return summary.total > 0 && summary.valid === 0 ? "Unavailable" : money(summary.sum);
}

function dedupe(values: string[]): string[] {
  return [...new Map(values.map((value) => [value.toLowerCase(), value])).values()];
}

function filteredDeals(board: DealsBoard, plan: Extract<QueryPlan, { intent: "deals_pipeline" }> | Extract<QueryPlan, { intent: "sector_brief" }>) {
  return board.records.filter((record) => (
    sameLabel(record.status.value, "Open")
    && inSectors(record.sector.value, plan.sectors)
    && inDateRange(record.tentativeCloseDate.value, plan.dateRange)
  ));
}

function pipelineCaveats(board: DealsBoard, records: DealRecord[], valueSummary: FieldSummary, hasDateFilter: boolean): string[] {
  const caveats = [
    "Deal values have no supplied currency or scale and are reported as masked-value units.",
    "Totals are monday.com board-item totals; no deduplication was applied.",
  ];
  if (valueSummary.missing || valueSummary.invalid) {
    caveats.push(`Pipeline value is partial: ${coverageDetail(valueSummary)}.`);
  }
  if (hasDateFilter) {
    caveats.push("Pipeline timing uses Tentative Close Date; records without a valid date do not match the period.");
  }
  if (board.excludedCount) {
    caveats.push(`${board.excludedCount} embedded header row(s) were excluded from analytics.`);
  }
  const questionable = dedupe(
    records
      .map((record) => record.sector.value)
      .filter((value): value is string => value === "Tender" || value === "DSP"),
  );
  if (questionable.length) {
    caveats.push(`${questionable.join(" and ")} occur in the source sector field but may not be sectors.`);
  }
  return caveats;
}

function dealFilterCaveats(
  board: DealsBoard,
  sectors: string[],
  hasDateFilter: boolean,
): string[] {
  const caveats: string[] = [];
  const unknownStatus = board.records.filter((record) => record.status.state !== "valid").length;
  if (unknownStatus) caveats.push(`${unknownStatus} Deal item(s) could not be classified by status.`);
  if (sectors.length) {
    const unknownSector = board.records.filter((record) => record.sector.state !== "valid").length;
    if (unknownSector) caveats.push(`${unknownSector} Deal item(s) with missing/invalid sector could not match the sector filter.`);
  }
  if (hasDateFilter) {
    const unknownDate = board.records.filter((record) => record.tentativeCloseDate.state !== "valid").length;
    if (unknownDate) caveats.push(`${unknownDate} Deal item(s) with missing/invalid Tentative Close Date could not match the period.`);
  }
  return caveats;
}

function workOrderFilterCaveats(board: WorkOrdersBoard, sectors: string[]): string[] {
  if (!sectors.length) return [];
  const unknownSector = board.records.filter((record) => record.sector.state !== "valid").length;
  return unknownSector
    ? [`${unknownSector} Work Order item(s) with missing/invalid sector could not match the sector filter.`]
    : [];
}

export function calculateDealsPipeline(
  board: DealsBoard,
  plan: Extract<QueryPlan, { intent: "deals_pipeline" }>,
): BiAnswer {
  const records = filteredDeals(board, plan);
  const values = summarizeField(records, (record) => record.maskedValue);
  const scope = plan.sectors.length ? ` for ${plan.sectors.join(" + ")}` : "";
  const period = plan.dateRange ? ` from ${plan.dateRange.start} to ${plan.dateRange.end}` : "";
  const numbers = [
    { label: "Open deals", value: String(records.length) },
    { label: "Known pipeline value", value: masked(values.sum), detail: coverageDetail(values) },
  ];

  if (plan.groupBy === "probability") {
    for (const [label, count] of countGroups(records, (record) => record.probability.value)) {
      numbers.push({ label: `${label} probability`, value: String(count) });
    }
  }

  const insights = records.length === 0
    ? ["No Open deals match the selected filters."]
    : [`${values.valid} of ${records.length} matching Open deals have a usable value.`];

  return {
    summary: `${records.length} Open deal(s)${scope}${period}, with ${masked(values.sum)} in known pipeline value.`,
    numbers,
    insights,
    caveats: [
      ...pipelineCaveats(board, records, values, Boolean(plan.dateRange)),
      ...dealFilterCaveats(board, plan.sectors, Boolean(plan.dateRange)),
    ],
    sources: [sourceMeta(board)],
  };
}

const WORK_ORDER_METRICS = {
  contracted: { label: "Contracted", select: (record: WorkOrderRecord) => record.contractIncludingGst },
  billed: { label: "Billed", select: (record: WorkOrderRecord) => record.billedIncludingGst },
  collected: { label: "Recorded collected", select: (record: WorkOrderRecord) => record.collectedAmount },
  receivable: { label: "Receivable", select: (record: WorkOrderRecord) => record.receivable },
  still_to_bill: { label: "Still to bill", select: (record: WorkOrderRecord) => record.stillToBillIncludingGst },
} as const;

function filteredWorkOrders(board: WorkOrdersBoard, sectors: string[]): WorkOrderRecord[] {
  return board.records.filter((record) => inSectors(record.sector.value, sectors));
}

function financialCaveats(fields: Array<{ label: string; summary: FieldSummary }>): string[] {
  const caveats = [
    "Work Order money uses direct source columns including GST; values are reported in INR.",
    "Totals are monday.com board-item totals; no deduplication was applied.",
  ];
  for (const field of fields) {
    if (field.summary.valid !== field.summary.total) {
      caveats.push(`${field.label} coverage is incomplete: ${coverageDetail(field.summary)}. Missing is not treated as zero.`);
    }
  }
  return caveats;
}

export function calculateWorkOrderFinancials(
  board: WorkOrdersBoard,
  plan: Extract<QueryPlan, { intent: "work_order_financials" }>,
): BiAnswer {
  const records = filteredWorkOrders(board, plan.sectors);
  const requested = plan.metric === "snapshot"
    ? Object.keys(WORK_ORDER_METRICS) as Array<keyof typeof WORK_ORDER_METRICS>
    : [plan.metric];
  const summaries = Object.fromEntries(
    Object.entries(WORK_ORDER_METRICS).map(([key, definition]) => [key, summarizeField(records, definition.select)]),
  ) as Record<keyof typeof WORK_ORDER_METRICS, FieldSummary>;
  const numbers = requested.map((key) => {
    const definition = WORK_ORDER_METRICS[key];
    const summary = summaries[key];
    return { label: definition.label, value: displayedMoney(summary), detail: coverageDetail(summary) };
  });

  const insights: string[] = [];
  const contract = summaries.contracted.sum;
  const billed = summaries.billed.sum;
  if (plan.metric === "snapshot" && summaries.contracted.valid === records.length && summaries.billed.valid === records.length && !contract.isZero()) {
    insights.push(`Billed value is ${billed.div(contract).times(100).toFixed(2)}% of contracted value.`);
  }
  if (plan.metric === "snapshot" && summaries.collected.valid > 0 && summaries.billed.valid === records.length && !billed.isZero()) {
    insights.push(
      `Recorded collections are ${summaries.collected.sum.div(billed).times(100).toFixed(2)}% of total billed value; this is not a collection rate because collection coverage is ${summaries.collected.valid}/${summaries.collected.total}.`,
    );
  }

  const scope = plan.sectors.length ? ` for ${plan.sectors.join(" + ")}` : "";
  return {
    summary: `${records.length} Work Order item(s)${scope}; ${numbers.map((item) => `${item.label.toLowerCase()} ${item.value}`).join(", ")}.`,
    numbers: [{ label: "Work Order items", value: String(records.length) }, ...numbers],
    insights,
    caveats: [
      ...financialCaveats(requested.map((key) => ({ label: WORK_ORDER_METRICS[key].label, summary: summaries[key] }))),
      ...workOrderFilterCaveats(board, plan.sectors),
    ],
    sources: [sourceMeta(board)],
  };
}

export function calculateWorkOrderOperations(
  board: WorkOrdersBoard,
  plan: Extract<QueryPlan, { intent: "work_order_operations" }>,
): BiAnswer {
  const records = filteredWorkOrders(board, plan.sectors);
  const scope = plan.sectors.length ? ` for ${plan.sectors.join(" + ")}` : "";

  if (plan.view === "billing_exceptions") {
    const fullyBilledOpen = records.filter((record) => (
      sameLabel(record.invoiceStatus.value, "Fully Billed")
      && sameLabel(record.workOrderStatus.value, "Open")
    ));
    const completedNotBilled = records.filter((record) => (
      sameLabel(record.executionStatus.value, "Completed")
      && sameLabel(record.invoiceStatus.value, "Not billed yet")
    ));
    return {
      summary: `${fullyBilledOpen.length} Fully Billed item(s) remain Open, and ${completedNotBilled.length} Completed item(s) are explicitly Not billed yet${scope}.`,
      numbers: [
        { label: "Fully Billed + WO Open", value: String(fullyBilledOpen.length) },
        { label: "Completed + Not billed yet", value: String(completedNotBilled.length) },
      ],
      insights: ["Blank Invoice Status is kept separate and is not classified as Not billed yet."],
      caveats: [
        "Counts are board-item totals; no deduplication was applied.",
        ...workOrderFilterCaveats(board, plan.sectors),
      ],
      sources: [sourceMeta(board)],
    };
  }

  const sorted = countGroups(records, (record) => record.executionStatus.value);
  return {
    summary: `${records.length} Work Order item(s)${scope}, grouped by Execution Status.`,
    numbers: sorted.map(([label, count]) => ({ label, value: String(count) })),
    insights: sorted.length ? [`${sorted[0][0]} is the largest status group at ${sorted[0][1]} item(s).`] : ["No items match the selected filters."],
    caveats: [
      "Missing statuses are shown explicitly. Counts are board-item totals; no deduplication was applied.",
      ...workOrderFilterCaveats(board, plan.sectors),
    ],
    sources: [sourceMeta(board)],
  };
}

export function calculateSectorBrief(
  deals: DealsBoard,
  workOrders: WorkOrdersBoard,
  plan: Extract<QueryPlan, { intent: "sector_brief" }>,
): BiAnswer {
  const dealRecords = filteredDeals(deals, plan);
  const workOrderRecords = filteredWorkOrders(workOrders, plan.sectors);
  const dealValues = summarizeField(dealRecords, (record) => record.maskedValue);
  const contracted = summarizeField(workOrderRecords, (record) => record.contractIncludingGst);
  const billed = summarizeField(workOrderRecords, (record) => record.billedIncludingGst);
  const collected = summarizeField(workOrderRecords, (record) => record.collectedAmount);
  const receivable = summarizeField(workOrderRecords, (record) => record.receivable);

  const executionText = countGroups(workOrderRecords, (record) => record.executionStatus.value)
    .map(([label, count]) => `${label} ${count}`)
    .join(", ");

  const insights: string[] = [];
  if (contracted.valid === workOrderRecords.length && billed.valid === workOrderRecords.length && !contracted.sum.isZero()) {
    insights.push(`Billed value is ${billed.sum.div(contracted.sum).times(100).toFixed(2)}% of contracted value for these Work Orders.`);
  }
  if (executionText) insights.push(`Work Order execution mix: ${executionText}.`);

  return {
    summary: `${plan.sectors.join(" + ")} is shown as separate Deals and Work Orders aggregates; no record-level join was attempted.`,
    numbers: [
      { label: "Open Deals", value: String(dealRecords.length) },
      { label: "Known Open pipeline", value: masked(dealValues.sum), detail: coverageDetail(dealValues) },
      { label: "Work Order items", value: String(workOrderRecords.length) },
      { label: "Contracted", value: displayedMoney(contracted), detail: coverageDetail(contracted) },
      { label: "Billed", value: displayedMoney(billed), detail: coverageDetail(billed) },
      { label: "Recorded collected", value: displayedMoney(collected), detail: coverageDetail(collected) },
      { label: "Receivable", value: displayedMoney(receivable), detail: coverageDetail(receivable) },
    ],
    insights,
    caveats: [
      ...pipelineCaveats(deals, dealRecords, dealValues, Boolean(plan.dateRange)),
      ...dealFilterCaveats(deals, plan.sectors, Boolean(plan.dateRange)),
      ...financialCaveats([
        { label: "Contracted", summary: contracted },
        { label: "Billed", summary: billed },
        { label: "Recorded collected", summary: collected },
        { label: "Receivable", summary: receivable },
      ]),
      ...workOrderFilterCaveats(workOrders, plan.sectors),
      "The two boards have no trustworthy record-level key; counts and values must remain independent.",
      ...(plan.dateRange ? ["The date range applies only to Deals; Work Orders are all-time because no Work Order date basis was agreed."] : []),
    ],
    sources: [sourceMeta(deals), sourceMeta(workOrders)],
  };
}

export function runBiQuery(
  plan: QueryPlan,
  boards: { deals?: DealsBoard; workOrders?: WorkOrdersBoard },
): BiAnswer {
  switch (plan.intent) {
    case "deals_pipeline":
      if (!boards.deals) throw new Error("Deals board data is required");
      return calculateDealsPipeline(boards.deals, plan);
    case "work_order_financials":
      if (!boards.workOrders) throw new Error("Work Orders board data is required");
      return calculateWorkOrderFinancials(boards.workOrders, plan);
    case "work_order_operations":
      if (!boards.workOrders) throw new Error("Work Orders board data is required");
      return calculateWorkOrderOperations(boards.workOrders, plan);
    case "sector_brief":
      if (!boards.deals || !boards.workOrders) throw new Error("Both boards are required");
      return calculateSectorBrief(boards.deals, boards.workOrders, plan);
  }
}

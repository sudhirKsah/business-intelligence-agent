export type BoardKind = "deals" | "workOrders";

export type MondayColumn = {
  id: string;
  title: string;
  type: string;
};

export type MondayColumnValue = {
  id: string;
  type: string;
  text: string | null;
  value: string | null;
};

export type MondayItem = {
  id: string;
  name: string;
  group?: { id: string; title: string } | null;
  column_values: MondayColumnValue[];
};

export type MondayBoard = {
  id: string;
  name: string;
  columns: MondayColumn[];
  items: MondayItem[];
  retrievedAt: string;
};

export type DataIssue = {
  itemId?: string;
  field?: string;
  code: "missing" | "invalid" | "malformed_row" | "non_sector_label";
  message: string;
};

export type Coverage = {
  valid: number;
  missing: number;
  invalid: number;
  total: number;
};

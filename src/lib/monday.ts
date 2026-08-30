import type { MondayConfig } from "./config";
import type { MondayBoard, MondayColumn, MondayItem } from "./types";
import { z } from "zod";

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const PAGE_SIZE = 500;
const REQUEST_TIMEOUT_MS = 20_000;

const FIRST_PAGE_QUERY = `
  query ReadBoard($boardIds: [ID!]!, $limit: Int!) {
    boards(ids: $boardIds) {
      id
      name
      columns { id title type }
      items_page(limit: $limit) {
        cursor
        items {
          id
          name
          group { id title }
          column_values { id type text value }
        }
      }
    }
  }
`;

const NEXT_PAGE_QUERY = `
  query ReadNextBoardPage($cursor: String!, $limit: Int!) {
    next_items_page(cursor: $cursor, limit: $limit) {
      cursor
      items {
        id
        name
        group { id title }
        column_values { id type text value }
      }
    }
  }
`;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const columnSchema: z.ZodType<MondayColumn> = z.object({
  id: z.string(),
  title: z.string(),
  type: z.string(),
});

const itemSchema: z.ZodType<MondayItem> = z.object({
  id: z.string(),
  name: z.string(),
  group: z.object({ id: z.string(), title: z.string() }).nullable().optional(),
  column_values: z.array(z.object({
    id: z.string(),
    type: z.string(),
    text: z.string().nullable(),
    value: z.string().nullable(),
  })),
});

const itemsPageSchema = z.object({
  cursor: z.string().nullable(),
  items: z.array(itemSchema),
});

const firstPageDataSchema = z.object({
  boards: z.array(z.object({
    id: z.string(),
    name: z.string(),
    columns: z.array(columnSchema),
    items_page: itemsPageSchema,
  })),
});

const nextPageDataSchema = z.object({ next_items_page: itemsPageSchema });

const envelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string().optional() }).passthrough()).optional(),
}).passthrough();

export class MondayApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "authentication" | "rate_limit" | "transient" | "graphql" | "invalid_response",
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MondayApiError";
  }
}

async function requestMonday<T>(
  config: MondayConfig,
  query: string,
  variables: Record<string, unknown>,
  dataSchema: z.ZodType<T>,
  fetchImpl: FetchLike,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const headers: Record<string, string> = {
        Authorization: config.token,
        "Content-Type": "application/json",
      };
      if (config.apiVersion) headers["API-Version"] = config.apiVersion;

      const response = await fetchImpl(MONDAY_ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const kind = response.status === 401 || response.status === 403
          ? "authentication"
          : response.status === 429
            ? "rate_limit"
            : "transient";
        if (retryable && attempt === 0) {
          const retryAfter = Number(response.headers.get("Retry-After"));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1_000, 5_000)
            : 1_500;
          await wait(delayMs);
          continue;
        }
        throw new MondayApiError("monday.com request failed", kind, retryable, response.status);
      }

      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        if (attempt === 0) {
          await wait(2_000);
          continue;
        }
        throw new MondayApiError("monday.com returned a non-JSON protection response", "rate_limit", true, response.status);
      }
      const envelopeResult = envelopeSchema.safeParse(responseBody);
      if (!envelopeResult.success) {
        throw new MondayApiError("monday.com returned an invalid response", "invalid_response", false, response.status);
      }
      const envelope = envelopeResult.data;
      if (envelope.errors?.length) {
        throw new MondayApiError(
          envelope.errors[0]?.message || "monday.com returned a GraphQL error",
          "graphql",
          false,
          response.status,
        );
      }
      if (!envelope.data) {
        throw new MondayApiError("monday.com returned no data", "invalid_response", false, response.status);
      }
      const data = dataSchema.safeParse(envelope.data);
      if (!data.success) {
        throw new MondayApiError("monday.com returned incomplete board data", "invalid_response", false, response.status);
      }
      return data.data;
    } catch (error) {
      if (error instanceof MondayApiError) throw error;
      if (attempt === 0) {
        await wait(1_500);
        continue;
      }
      throw new MondayApiError("monday.com is temporarily unavailable", "transient", true);
    }
  }
  throw new MondayApiError("monday.com is temporarily unavailable", "transient", true);
}

export async function fetchMondayBoard(
  config: MondayConfig,
  boardId: string,
  fetchImpl: FetchLike = fetch,
): Promise<MondayBoard> {
  const first = await requestMonday(
    config,
    FIRST_PAGE_QUERY,
    { boardIds: [boardId], limit: PAGE_SIZE },
    firstPageDataSchema,
    fetchImpl,
  );
  const board = first.boards[0];
  if (!board || board.id !== boardId) {
    throw new MondayApiError("Configured monday.com board was not found", "invalid_response", false);
  }

  const items = [...board.items_page.items];
  let cursor = board.items_page.cursor;
  const seenCursors = new Set<string>();
  while (cursor) {
    if (seenCursors.has(cursor)) {
      throw new MondayApiError("monday.com repeated a page cursor", "invalid_response", false);
    }
    seenCursors.add(cursor);
    const next = await requestMonday(
      config,
      NEXT_PAGE_QUERY,
      { cursor, limit: PAGE_SIZE },
      nextPageDataSchema,
      fetchImpl,
    );
    items.push(...next.next_items_page.items);
    cursor = next.next_items_page.cursor;
  }

  return {
    id: board.id,
    name: board.name,
    columns: board.columns,
    items,
    retrievedAt: new Date().toISOString(),
  };
}

export async function fetchBothBoards(config: MondayConfig, fetchImpl: FetchLike = fetch) {
  const [deals, workOrders] = await Promise.all([
    fetchMondayBoard(config, config.dealsBoardId, fetchImpl),
    fetchMondayBoard(config, config.workOrdersBoardId, fetchImpl),
  ]);
  return { deals, workOrders };
}

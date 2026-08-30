import { describe, expect, it, vi } from "vitest";
import type { MondayConfig } from "./config";
import { fetchMondayBoard } from "./monday";

const config: MondayConfig = {
  token: "test-token",
  dealsBoardId: "1",
  workOrdersBoardId: "2",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const firstItem = { id: "i1", name: "One", group: null, column_values: [] };
const secondItem = { id: "i2", name: "Two", group: null, column_values: [] };

describe("monday.com client", () => {
  it("follows cursors until all board items are read", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { boards: [{
        id: "1",
        name: "Deals",
        columns: [{ id: "c1", title: "Deal Status", type: "text" }],
        items_page: { cursor: "next-cursor", items: [firstItem] },
      }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        next_items_page: { cursor: null, items: [secondItem] },
      } }));

    const board = await fetchMondayBoard(config, "1", fetchMock);

    expect(board.items.map((item) => item.id)).toEqual(["i1", "i2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).variables.cursor).toBe("next-cursor");
  });

  it("rejects HTTP-200 GraphQL errors without aggregating partial data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: { boards: [] },
      errors: [{ message: "Complexity limit" }],
    }));

    await expect(fetchMondayBoard(config, "1", fetchMock)).rejects.toMatchObject({
      kind: "graphql",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries one transient HTTP failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse({ data: { boards: [{
        id: "1",
        name: "Deals",
        columns: [],
        items_page: { cursor: null, items: [] },
      }] } }));

    await expect(fetchMondayBoard(config, "1", fetchMock)).resolves.toMatchObject({ id: "1", items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a malformed page instead of silently truncating data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { boards: [{
      id: "1",
      name: "Deals",
      columns: [],
      items_page: { items: [firstItem] },
    }] } }));

    await expect(fetchMondayBoard(config, "1", fetchMock)).rejects.toMatchObject({
      kind: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a repeated cursor instead of looping forever", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: { boards: [{
        id: "1",
        name: "Deals",
        columns: [],
        items_page: { cursor: "same", items: [firstItem] },
      }] } }))
      .mockResolvedValueOnce(jsonResponse({ data: {
        next_items_page: { cursor: "same", items: [secondItem] },
      } }));

    await expect(fetchMondayBoard(config, "1", fetchMock)).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

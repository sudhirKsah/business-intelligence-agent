import { NextResponse } from "next/server";
import { z } from "zod";
import { ConfigurationError } from "@/lib/config";
import { MondayApiError } from "@/lib/monday";
import { BoardSchemaError } from "@/lib/normalize";
import { answerChat } from "@/lib/orchestrator";
import { PlannerError } from "@/lib/planner";
import { pendingClarificationSchema } from "@/lib/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  message: z.string().trim().min(1).max(600),
  pending: pendingClarificationSchema.nullish(),
}).strict();

function errorResponse(message: string, code: string, retryable: boolean, status: number) {
  return NextResponse.json({ type: "error", error: { message, code, retryable } }, { status });
}

export async function POST(request: Request) {
  try {
    const input = requestSchema.parse(await request.json());
    return NextResponse.json(await answerChat(input));
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return errorResponse("Enter a question of 600 characters or fewer.", "INVALID_REQUEST", false, 400);
    }
    if (error instanceof BoardSchemaError) {
      console.error("monday.com board schema mismatch", error.missingColumns);
      return errorResponse(
        `The monday.com board is missing required columns: ${error.missingColumns.join(", ")}.`,
        "BOARD_SCHEMA",
        false,
        422,
      );
    }
    if (error instanceof MondayApiError) {
      console.error("monday.com request error", { kind: error.kind, status: error.status });
      if (error.kind === "authentication") {
        return errorResponse("monday.com authentication failed. Check the server token and board access.", "MONDAY_AUTH", false, 502);
      }
      if (error.kind === "rate_limit") {
        return errorResponse("monday.com temporarily rate-limited this connection. Wait a minute, then retry once.", "MONDAY_RATE_LIMIT", true, 503);
      }
      if (error.kind === "graphql" || error.kind === "invalid_response") {
        return errorResponse("monday.com returned an incomplete or invalid board response.", "MONDAY_DATA", false, 502);
      }
      return error.retryable
        ? errorResponse("monday.com is temporarily unavailable. Please retry.", "MONDAY_UNAVAILABLE", true, 503)
        : errorResponse("monday.com rejected the board request. Check the API version and board access.", "MONDAY_REQUEST", false, 502);
    }
    if (error instanceof PlannerError) {
      console.error("query planner error", { retryable: error.retryable, message: error.message });
      return errorResponse(error.message, "PLANNER_ERROR", error.retryable, error.retryable ? 503 : 422);
    }
    if (error instanceof ConfigurationError) {
      console.error("server configuration error", error.message);
      return errorResponse("Server configuration is incomplete.", "SERVER_CONFIG", false, 503);
    }
    console.error("Unexpected chat error", error);
    return errorResponse("The request could not be completed.", "INTERNAL_ERROR", true, 500);
  }
}

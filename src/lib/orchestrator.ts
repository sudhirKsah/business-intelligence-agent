import { getGroqConfig, getMondayConfig } from "./config";
import { runBiQuery } from "./bi";
import { fetchBothBoards, fetchMondayBoard } from "./monday";
import { normalizeDeals, normalizeWorkOrders } from "./normalize";
import { planQuestion, resolveClarification } from "./planner";
import type { PendingClarification, QueryPlan } from "./query";

export type ChatResult =
  | { type: "answer"; answer: ReturnType<typeof runBiQuery> }
  | { type: "clarification"; question: string; options: string[]; pending: PendingClarification }
  | { type: "unsupported"; message: string };

async function executePlan(plan: QueryPlan): Promise<ChatResult> {
  const config = getMondayConfig();

  if (plan.intent === "deals_pipeline") {
    const board = await fetchMondayBoard(config, config.dealsBoardId);
    return { type: "answer", answer: runBiQuery(plan, { deals: normalizeDeals(board) }) };
  }
  if (plan.intent === "work_order_financials" || plan.intent === "work_order_operations") {
    const board = await fetchMondayBoard(config, config.workOrdersBoardId);
    return { type: "answer", answer: runBiQuery(plan, { workOrders: normalizeWorkOrders(board) }) };
  }

  const boards = await fetchBothBoards(config);
  return {
    type: "answer",
    answer: runBiQuery(plan, {
      deals: normalizeDeals(boards.deals),
      workOrders: normalizeWorkOrders(boards.workOrders),
    }),
  };
}

export async function answerChat(input: {
  message: string;
  pending?: PendingClarification | null;
  now?: Date;
}): Promise<ChatResult> {
  const decision = input.pending
    ? resolveClarification(input.pending, input.message)
    : await planQuestion(input.message, getGroqConfig(), input.now);

  if (decision.kind === "unsupported") {
    return { type: "unsupported", message: decision.message };
  }
  if (decision.kind === "clarification") {
    return {
      type: "clarification",
      question: decision.clarification.question,
      options: decision.clarification.options,
      pending: decision.clarification.pending,
    };
  }
  return executePlan(decision.plan);
}

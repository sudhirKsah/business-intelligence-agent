"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BiAnswer, PendingClarification } from "@/lib/query";

const STARTERS = [
  "How many Open deals are there, and what is their known pipeline value?",
  "Give me the all-time Work Order financial snapshot including GST.",
  "What is the Work Order execution-status distribution?",
  "Compare Renewables pipeline and Work Order health across both boards.",
  "How is our energy pipeline this quarter?",
];

type Message =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "assistant"; text: string; tone?: "normal" | "error" }
  | { id: number; role: "assistant"; answer: BiAnswer }
  | { id: number; role: "assistant"; question: string; options: string[]; pending: PendingClarification };

type ApiResponse =
  | { type: "answer"; answer: BiAnswer }
  | { type: "clarification"; question: string; options: string[]; pending: PendingClarification }
  | { type: "unsupported"; message: string }
  | { type: "error"; error: { message: string; code: string; retryable: boolean } };

let nextMessageId = 1;

function SourceLine({ answer }: { answer: BiAnswer }) {
  return (
    <div className="sources" aria-label="Sources">
      {answer.sources.map((source) => (
        <span key={`${source.board}-${source.retrievedAt}`}>
          {source.board}: {source.analyzedItems}/{source.rawItems} items analyzed, retrieved {new Date(source.retrievedAt).toLocaleString()}
        </span>
      ))}
    </div>
  );
}

function AnswerCard({ answer }: { answer: BiAnswer }) {
  return (
    <article className="answer-card">
      <p className="answer-summary">{answer.summary}</p>
      <div className="number-grid">
        {answer.numbers.map((item) => (
          <div className="number" key={`${item.label}-${item.value}`}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            {item.detail && <small>{item.detail}</small>}
          </div>
        ))}
      </div>
      {answer.insights.length > 0 && (
        <section className="answer-section insight-section">
          <h3>Insight</h3>
          {answer.insights.map((insight) => <p key={insight}>{insight}</p>)}
        </section>
      )}
      {answer.caveats.length > 0 && (
        <details className="caveats" open>
          <summary>Data caveats</summary>
          <ul>{answer.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
        </details>
      )}
      <SourceLine answer={answer} />
    </article>
  );
}

export function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<PendingClarification | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryRequest, setRetryRequest] = useState<{ question: string; pending: PendingClarification | null } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const requestInFlightRef = useRef(false);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, loading]);

  async function ask(question: string, pendingOverride: PendingClarification | null = pending) {
    const trimmed = question.trim();
    if (!trimmed || requestInFlightRef.current) return;

    requestInFlightRef.current = true;
    setMessages((current) => [...current, { id: nextMessageId++, role: "user", text: trimmed }]);
    setInput("");
    setLoading(true);
    setRetryRequest(null);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, pending: pendingOverride }),
      });
      const result = await response.json() as ApiResponse;
      if (!response.ok || result.type === "error") {
        const error = result.type === "error" ? result.error : { message: "The request failed.", retryable: true };
        setMessages((current) => [...current, {
          id: nextMessageId++,
          role: "assistant",
          text: error.message,
          tone: "error",
        }]);
        if (error.retryable) setRetryRequest({ question: trimmed, pending: pendingOverride });
        return;
      }

      if (result.type === "answer") {
        setPending(null);
        setMessages((current) => [...current, { id: nextMessageId++, role: "assistant", answer: result.answer }]);
      } else if (result.type === "clarification") {
        setPending(result.pending);
        setMessages((current) => [...current, {
          id: nextMessageId++,
          role: "assistant",
          question: result.question,
          options: result.options,
          pending: result.pending,
        }]);
      } else {
        setPending(null);
        setMessages((current) => [...current, { id: nextMessageId++, role: "assistant", text: result.message }]);
      }
    } catch {
      setMessages((current) => [...current, {
        id: nextMessageId++,
        role: "assistant",
        text: "The service could not be reached. Check the connection and retry.",
        tone: "error",
      }]);
      setRetryRequest({ question: trimmed, pending: pendingOverride });
    } finally {
      requestInFlightRef.current = false;
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(input);
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">SKYLARK / EXECUTIVE INTELLIGENCE</p>
          <h1>Ask the boards.</h1>
          <p className="deck">Deterministic business answers from live Deals and Work Orders data.</p>
        </div>
        <div className="read-only"><span /> READ-ONLY</div>
      </header>

      <div className="workspace">
        <aside className="briefing-panel">
          <p className="panel-index">01 / SCOPE</p>
          <h2>Founder briefing</h2>
          <p>Ask about Open pipeline, Work Order financials, execution status, billing exceptions, or exact-sector performance.</p>
          <p className="boundary">The agent clarifies ambiguous terms and never guesses cross-board record links.</p>
          <div className="starter-list">
            <span>STARTER QUESTIONS</span>
            {STARTERS.map((starter) => (
              <button key={starter} type="button" disabled={loading} onClick={() => void ask(starter, null)}>
                {starter}
              </button>
            ))}
          </div>
        </aside>

        <section className="conversation" aria-label="Business intelligence conversation">
          <div className="messages" aria-live="polite">
            {messages.length === 0 && (
              <div className="empty-state">
                <span>LIVE BOARD QUERY</span>
                <h2>What needs attention?</h2>
                <p>Choose a starter or ask a focused business question. Values are fetched when you submit.</p>
              </div>
            )}
            {messages.map((message) => (
              <div className={`message ${message.role}`} key={message.id}>
                <div className="message-label">{message.role === "user" ? "YOU" : "BRIEFING"}</div>
                {"answer" in message ? <AnswerCard answer={message.answer} /> : "question" in message ? (
                  <div className="clarification">
                    <p>{message.question}</p>
                    <div className="option-row">
                      {message.options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          disabled={loading || pending !== message.pending}
                          onClick={() => void ask(option, message.pending)}
                        >
                          {option}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : <p className={"tone" in message && message.tone === "error" ? "error-text" : undefined}>{message.text}</p>}
              </div>
            ))}
            {loading && (
              <div className="message assistant loading-message">
                <div className="message-label">BRIEFING</div>
                <div className="loading-dots" aria-label="Reading monday.com boards"><i /><i /><i /></div>
              </div>
            )}
            {retryRequest && !loading && (
              <button
                className="retry"
                type="button"
                onClick={() => void ask(retryRequest.question, retryRequest.pending)}
              >
                Retry last question
              </button>
            )}
            <div ref={endRef} />
          </div>

          <form className="composer" onSubmit={submit}>
            <label htmlFor="question">Business question</label>
            <div>
              <textarea
                id="question"
                maxLength={600}
                rows={2}
                placeholder={pending ? "Answer the clarification..." : "Ask about pipeline, revenue, operations, or a sector..."}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    if (input.trim()) void ask(input);
                  }
                }}
              />
              <button type="submit" disabled={loading || !input.trim()}>{loading ? "Reading" : "Ask"}</button>
            </div>
            <small>Enter to send. Shift + Enter for a new line. Conversation resets on refresh.</small>
          </form>
        </section>
      </div>
    </main>
  );
}

// Supabase Edge Function: ask-budget
//
// Pipeline: user's question (plain English)
//   -> LLM call #1: question -> SQL (against the known schema)
//   -> server-side validation of that SQL (defense in depth; the real
//      enforcement lives in the run_readonly_query Postgres function)
//   -> run the SQL via run_readonly_query RPC
//   -> LLM call #2: question + real rows -> plain-English answer
//   -> return { answer, sql, rows } to the frontend
//
// Deploy with: supabase functions deploy ask-budget
// Secrets needed (set once): supabase secrets set GEMINI_API_KEY=your-key-here
//   Get a free key (no billing required) at https://aistudio.google.com
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically by
// the Supabase runtime — do not set them yourself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_MODEL = "gemini-3.5-flash-lite"; // Google's direct replacement for gemini-2.0-flash-lite (now retired) — a "lite" model, so should keep a generous free-tier quota

const SCHEMA_DESCRIPTION = `
Table: transactions
  id          bigint, primary key
  date        date        -- transaction date
  amount      numeric      -- always positive, dollars spent
  category    text         -- e.g. 'Food', 'Rent', 'Groceries', 'Entertainment',
                            --      'Transportation', 'Subscriptions', 'Shopping',
                            --      'Utilities', 'Health'
  description text         -- free-text note, may be null
  created_at  timestamptz
`.trim();

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

async function callGemini(system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  // Gemini's servers occasionally return 503 "high demand" — transient, not
  // a real failure. Retry a couple of times with a short backoff before
  // giving up, instead of failing the whole request on one bad moment.
  const maxAttempts = 3;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    }

    const text = await res.text();
    lastError = `Gemini API error (${res.status}): ${text}`;

    // Only retry on transient server-side errors, not on real problems
    // (bad API key, bad request, etc.) — those would just fail the same
    // way every time, so retrying wastes time instead of helping.
    const isRetryable = res.status === 503 || res.status === 429;
    if (!isRetryable || attempt === maxAttempts) {
      throw new Error(lastError);
    }

    const backoffMs = attempt * 1000; // 1s, then 2s
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  throw new Error(lastError);
}

// Server-side guardrail, in addition to the DB-level one in
// run_readonly_query. Two independent checks; either one alone would be
// enough, but a single point of failure is how these things get bypassed.
function assertSafeSelect(sql: string) {
  const normalized = sql.trim().toLowerCase();
  if (!normalized.startsWith("select")) {
    throw new Error("Generated query is not a SELECT statement");
  }
  if (normalized.includes(";")) {
    throw new Error("Generated query contains multiple statements");
  }
  const forbidden = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|call|copy|vacuum)\b/;
  if (forbidden.test(normalized)) {
    throw new Error("Generated query contains a disallowed keyword");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  try {
    const { question } = await req.json();
    if (!question || typeof question !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'question' string in request body" }), {
        status: 400,
        headers: { ...corsHeaders(), "content-type": "application/json" },
      });
    }

    // --- LLM call #1: natural language -> SQL ---
    const sqlSystemPrompt = `You translate a user's question about their personal spending into a single PostgreSQL SELECT query.

Schema:
${SCHEMA_DESCRIPTION}

Rules:
- Output ONLY the raw SQL query, nothing else — no markdown fences, no explanation.
- SELECT statements only. Never write, alter, or delete data.
- Exactly one statement, no semicolon-separated chaining.
- Use standard PostgreSQL date functions (date_trunc, current_date, etc.) for relative dates like "this month" or "last 30 days".
- Some questions are advice-style rather than a direct lookup (e.g. "how can I save the most?", "what should I cut back on?", "where am I overspending?"). These are NOT unanswerable — write a query that surfaces the data someone would need to answer them, most often: SELECT category, SUM(amount) AS total FROM transactions GROUP BY category ORDER BY total DESC. A second step will turn those numbers into an actual suggestion, so your job is just to get the right numbers, not to answer the advice question yourself.
- Only use SELECT 'unanswerable' AS note LIMIT 0; when the question is about something this schema genuinely has no data for at all (e.g. income, savings goals, account balances) — not just because it sounds subjective.`;

    const rawSql = (await callGemini(sqlSystemPrompt, question)).trim();

    // Gemini doesn't always follow "output only raw SQL" perfectly — it may
    // wrap it in a code fence with any language tag (```sql, ```postgresql,
    // plain ```), or add a line of commentary before it. Rather than guess
    // every format it might use, just find the first "select" keyword
    // anywhere in the response and start the query there, discarding
    // whatever came before it.
    let sql = rawSql;
    const selectMatch = sql.match(/\bselect\b/i);
    if (selectMatch) {
      sql = sql.slice(selectMatch.index);
    }
    // Strip any trailing code fence and a single trailing semicolon — both
    // are normal, valid formatting, not multi-statement chaining.
    // assertSafeSelect below still catches a REAL second statement (a
    // semicolon anywhere except the very end).
    sql = sql.replace(/```[\s\S]*$/, "").trim();
    sql = sql.replace(/;+\s*$/, "").trim();

    assertSafeSelect(sql);

    // --- Run it against the real data ---
    const { data: rows, error: rpcError } = await supabase.rpc("run_readonly_query", { query: sql });
    if (rpcError) {
      throw new Error(`Query execution failed: ${rpcError.message}`);
    }

    // --- LLM call #2: real rows -> plain-English answer ---
    const answerSystemPrompt = `You are a helpful budgeting assistant. You'll get the user's original question and the actual query results (JSON) that back it up. Write a short, plain-English answer using only these numbers, never invent or round figures that aren't present in the data. If the user asked an advice-style question ("how can I save the most?", "what should I cut back on?"), give a real, specific suggestion based on the actual numbers (e.g. name the biggest category and say cutting it back would have the most impact) rather than generic advice. If the result set is empty, say so plainly and suggest a reason (e.g. no transactions in that period) rather than guessing.`;

    const answerUserPrompt = `Question: ${question}\n\nQuery results (JSON):\n${JSON.stringify(rows)}`;

    const answer = await callGemini(answerSystemPrompt, answerUserPrompt);

    return new Response(
      JSON.stringify({ answer: answer.trim(), sql, rows }),
      { headers: { ...corsHeaders(), "content-type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders(), "content-type": "application/json" } },
    );
  }
});

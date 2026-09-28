# Budget Tracker + AI Chat

Ask plain-English questions about a year of spending data and get real answers, pulled from the actual numbers, not guessed by the AI.

Try it live: [add your Netlify URL here]

## How it works

This is a text-to-SQL pipeline, not a single AI call:

1. Your question goes to Gemini, which turns it into a SQL query against the known schema
2. That query is checked, then run against the real Postgres data
3. The actual result rows go back to Gemini, which turns them into a plain-English answer

Doing it in two separate steps, instead of asking one AI call to "just answer the question," is what keeps the numbers honest. The model never gets to make up a figure, it can only describe numbers that actually came out of the database.

## Stack

- **Supabase** — Postgres database + an Edge Function (`ask-budget`) that runs the pipeline above
- **Gemini API** (`gemini-3.5-flash-lite`, free tier) — the two LLM calls
- Plain HTML/CSS/JS frontend, no framework, deployed on **Netlify**

## Keeping AI-generated SQL safe

The part that took the most work wasn't the chat UI, it was making sure a query the AI writes can never do anything destructive (delete, edit, or wipe data). Three independent checks enforce that, so even if two of them somehow failed, the third still holds:

1. The prompt only ever asks for a single `SELECT` statement
2. The Edge Function re-validates the SQL text before running it (`assertSafeSelect`)
3. The Postgres function that actually executes it (`run_readonly_query`) independently blocks anything that isn't a single read-only `SELECT`, regardless of what the first two layers did

## Repo structure

```
supabase/
  schema.sql          -- creates the transactions table + RLS policy
  seed_year.sql        -- a year of generated sample transactions (238 rows)
  rpc_run_query.sql    -- the read-only SQL execution guardrail
  functions/
    ask-budget/
      index.ts         -- the Edge Function: question -> SQL -> real data -> answer
index.html              -- the frontend, self-contained, no build step
```

## Setting it up yourself

1. **Database**: in Supabase's SQL Editor, run `schema.sql`, then `seed_year.sql`, then `rpc_run_query.sql`, in that order.
2. **Grant read access**: also run `grant select on transactions to anon, authenticated;` — needed so the frontend's overview panel can read the table directly with the public key (separate from the Edge Function, which uses the service role key and bypasses this).
3. **Deploy the Edge Function**:
   ```bash
   npm install -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase secrets set GEMINI_API_KEY=your-key-here   # free key at aistudio.google.com
   supabase functions deploy ask-budget
   ```
4. **Frontend**: open `index.html`, update `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` near the top of the `<script>` tag with your own project's values (these are meant to be public, safe to commit). Deploy the file to Netlify (drag-and-drop works fine, no build step needed).

## Sample data

The demo runs on a year of generated sample transactions (Oct 2025–Sep 2026), not real spending data.

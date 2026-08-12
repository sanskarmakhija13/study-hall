# Study Hall — shared AI backend

## What changed

The browser no longer asks students for API keys.

The frontend sends quiz-generation/grading requests to `/api/quiz`.
The Vercel serverless function keeps the owner's API keys in environment variables
and rotates through the configured providers/models.

Default pool:

- Cerebras — `gpt-oss-120b`
- Groq — `openai/gpt-oss-120b`
- Groq — `openai/gpt-oss-20b`
- Groq — `llama-3.1-8b-instant`
- Gemini — `gemini-2.5-flash-lite`
- Gemini — `gemini-2.5-flash`

A provider/model returning a retryable error (including 429) is skipped and the
next configured option is tried.

## Deploy on Vercel

1. Put `index.html`, `api/quiz.js`, `package.json`, and `.env.example` in one repo.
2. Import the repo into Vercel.
3. In Vercel Project Settings → Environment Variables, add:
   - `CEREBRAS_API_KEYS`
   - `GROQ_API_KEYS`
   - `GEMINI_API_KEYS`
4. Redeploy.
5. Open the production URL.

Vercel environment variables are available to server-side functions and are not
embedded in the browser bundle.

## Important

This does NOT multiply a provider's quota simply by adding more keys from the
same provider/project/organization. The app uses multiple providers so their
independent quotas can be used. Provider limits still apply.

For a public deployment, add authentication/rate limiting before sharing the URL
widely. Otherwise strangers can consume your API quotas.

The app deliberately sends only the selected source section(s), not the whole
document, for each question.


## Quiz-generation behavior

- The browser indexes source pages locally.
- The first pass prioritizes **coverage**: each source section is tested before deliberate reinforcement/repetition.
- Within a section, the model is instructed to prioritize the most important/exam-worthy concept rather than minor details.
- After coverage, the quiz enters reinforcement mode and prioritizes high-yield concepts, especially ones previously missed.
- Application questions are a mix of:
  - **Case application** — a short mini-case followed by an application question.
  - **Direct application** — no caselet; the student must diagnose, compare, choose, predict, or apply a concept.
- Groq JSON-generation failures are retried without JSON mode, then the provider pool can fall through to another provider/model.
- HTTP 400/402/429 and other transient provider failures can trigger provider fallback.


## Concept-level coverage and reinforcement

The app now uses a token-efficient two-stage learning planner:

1. The first question generated from a source section also returns a compact inventory of its 3–6 most important concepts. This avoids a separate full-document indexing call.
2. The quiz then tests each important concept once.
3. Only after concept coverage is complete does it switch to reinforcement.
4. Reinforcement prioritizes higher-importance concepts, concepts answered incorrectly/partially, and concepts that have had more spacing since the last attempt.

This deliberately favors **coverage first, reinforcement second**, while avoiding the token cost of a separate concept-indexing pass.

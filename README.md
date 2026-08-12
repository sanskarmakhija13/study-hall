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

// Study Hall server-side AI gateway.
// API keys are read from environment variables and NEVER sent to the browser.
//
// Configure:
// CEREBRAS_API_KEYS=key1,key2
// GROQ_API_KEYS=key1,key2
// GEMINI_API_KEYS=key1,key2
//
// Optional model overrides:
// CEREBRAS_MODEL=gpt-oss-120b
// GROQ_MODELS=openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.1-8b-instant
// GEMINI_MODELS=gemini-2.5-flash-lite,gemini-2.5-flash

let cursor = 0;

function splitKeys(name) {
  return String(process.env[name] || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function splitModels(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value ? value.split(",").map(x => x.trim()).filter(Boolean) : fallback;
}

function providers() {
  const list = [];

  for (const key of splitKeys("CEREBRAS_API_KEYS")) {
    list.push({
      provider: "cerebras",
      key,
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b"
    });
  }

  const groqModels = splitModels("GROQ_MODELS", [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant"
  ]);
  for (const key of splitKeys("GROQ_API_KEYS")) {
    for (const model of groqModels) {
      list.push({ provider: "groq", key, model });
    }
  }

  const geminiModels = splitModels("GEMINI_MODELS", [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash"
  ]);
  for (const key of splitKeys("GEMINI_API_KEYS")) {
    for (const model of geminiModels) {
      list.push({ provider: "gemini", key, model });
    }
  }

  return list;
}

async function callCerebras(item, system, userPrompt) {
  const r = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${item.key}`
    },
    body: JSON.stringify({
      model: item.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_completion_tokens: 900,
      response_format: { type: "json_object" }
    })
  });

  const data = await safeJson(r);
  if (!r.ok) throw providerError("Cerebras", r.status, data);
  return data?.choices?.[0]?.message?.content || "";
}

async function callGroq(item, system, userPrompt) {
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${item.key}`
    },
    body: JSON.stringify({
      model: item.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_completion_tokens: 900,
      response_format: { type: "json_object" }
    })
  });

  const data = await safeJson(r);
  if (!r.ok) throw providerError("Groq", r.status, data);
  return data?.choices?.[0]?.message?.content || "";
}

async function callGemini(item, system, userPrompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(item.model)}:generateContent?key=${encodeURIComponent(item.key)}`;

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: system }]
      },
      contents: [{
        role: "user",
        parts: [{ text: userPrompt }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 900,
        responseMimeType: "application/json"
      }
    })
  });

  const data = await safeJson(r);
  if (!r.ok) throw providerError("Gemini", r.status, data);

  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}

async function safeJson(r) {
  try { return await r.json(); }
  catch (_) { return {}; }
}

function providerError(name, status, data) {
  const msg =
    data?.error?.message ||
    data?.error?.status ||
    data?.message ||
    `HTTP ${status}`;

  const e = new Error(`${name} ${status}: ${msg}`);
  e.status = status;
  e.provider = name;
  return e;
}

function isRetryable(err) {
  return [401, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(err?.status);
}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only." });
  }

  const pool = providers();
  if (!pool.length) {
    return res.status(500).json({
      error:
        "No AI provider keys are configured on the server. Add CEREBRAS_API_KEYS, GROQ_API_KEYS, or GEMINI_API_KEYS in your deployment environment."
    });
  }

  const body = req.body || {};
  const system = String(body.system || "");
  const userPrompt = String(body.userPrompt || "");

  if (!system || !userPrompt) {
    return res.status(400).json({ error: "Missing AI request content." });
  }

  // Hard guard against accidentally turning this endpoint into a giant proxy.
  if (system.length > 20000 || userPrompt.length > 30000) {
    return res.status(413).json({ error: "Request is too large." });
  }

  // Rotate starting point on every request. If a provider/model is exhausted,
  // move on to the next configured option.
  const start = cursor++ % pool.length;
  let lastError = null;

  for (let offset = 0; offset < pool.length; offset++) {
    const item = pool[(start + offset) % pool.length];

    try {
      let content = "";
      if (item.provider === "cerebras") {
        content = await callCerebras(item, system, userPrompt);
      } else if (item.provider === "groq") {
        content = await callGroq(item, system, userPrompt);
      } else if (item.provider === "gemini") {
        content = await callGemini(item, system, userPrompt);
      }

      if (!content) throw new Error(`${item.provider} returned an empty response.`);

      return res.status(200).json({
        content,
        provider: item.provider,
        model: item.model
      });
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) break;
    }
  }

  return res.status(503).json({
    error:
      "All configured AI providers are currently unavailable or rate-limited." +
      (lastError?.message ? ` Last error: ${lastError.message}` : "")
  });
}

export default handler;

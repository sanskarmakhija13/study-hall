// Study Hall — server-side AI gateway
// API keys stay on Vercel and are NEVER sent to the browser.
//
// Supported Vercel environment variables:
//
//   GROQ_API_KEYS
//   GROQ_API_KEYS2
//   GROQ_API_KEYS_3
//   CEREBRAS_API_KEYS
//   GEMINI_API_KEY
//   MISTRAL_API_KEY_1
//   MISTRAL_API_KEY_2
//   ZAI_KEY_1
//   ZAI_KEY_2
//   NIM_API_KEY
//
// Optional model overrides:
//
//   GROQ_MODEL
//   CEREBRAS_MODEL
//   GEMINI_MODEL
//   MISTRAL_MODEL
//   ZAI_MODEL
//   NIM_MODEL

let cursor = 0;
const providerHealth = new Map();

const DEFAULTS = {
  groq: "openai/gpt-oss-20b",
  cerebras: "gpt-oss-120b",
  gemini: "gemini-2.5-flash-lite",
  mistral: "mistral-small-latest",
  zai: "glm-4.7-flash",
  nim: "nvidia/nemotron-3-super-120b-a12b"
};

function splitValue(value) {
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function envKeys(names) {
  const out = [];
  const seen = new Set();

  for (const name of names) {
    for (const key of splitValue(process.env[name])) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }

  return out;
}

// Supports numbered variables such as:
// MISTRAL_API_KEY_1
// MISTRAL_API_KEY_2
// ZAI_KEY_1
// ZAI_KEY_2
function numberedKeys(prefix) {
  const out = [];
  const seen = new Set();

  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(prefix)) continue;
    if (!value) continue;

    for (const key of splitValue(value)) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key);
      }
    }
  }

  return out;
}

function model(name, fallback) {
  return String(process.env[name] || fallback).trim();
}

function addProvider(list, provider, keys, modelName) {
  for (const key of keys) {
    list.push({
      provider,
      key,
      model: modelName
    });
  }
}

function providers() {
  const list = [];

  // --------------------------------------------------
  // GROQ
  // --------------------------------------------------

  addProvider(
    list,
    "groq",
    envKeys([
      "GROQ_API_KEYS",
      "GROQ_API_KEYS2",
      "GROQ_API_KEYS_3"
    ]),
    model("GROQ_MODEL", DEFAULTS.groq)
  );

  // --------------------------------------------------
  // CEREBRAS
  // --------------------------------------------------

  addProvider(
    list,
    "cerebras",
    envKeys([
      "CEREBRAS_API_KEYS"
    ]).concat(
      numberedKeys("CEREBRAS_API_KEY_")
    ),
    model("CEREBRAS_MODEL", DEFAULTS.cerebras)
  );

  // --------------------------------------------------
  // GEMINI
  // --------------------------------------------------

  addProvider(
    list,
    "gemini",
    envKeys([
      "GEMINI_API_KEY",
      "GEMINI_API_KEYS"
    ]).concat(
      numberedKeys("GEMINI_API_KEY_")
    ),
    model("GEMINI_MODEL", DEFAULTS.gemini)
  );

  // --------------------------------------------------
  // MISTRAL
  // --------------------------------------------------

  addProvider(
    list,
    "mistral",
    envKeys([
      "MISTRAL_API_KEYS"
    ]).concat(
      numberedKeys("MISTRAL_API_KEY_")
    ),
    model("MISTRAL_MODEL", DEFAULTS.mistral)
  );

  // --------------------------------------------------
  // Z.AI
  // --------------------------------------------------

  addProvider(
    list,
    "zai",
    envKeys([
      "ZAI_KEYS",
      "ZAI_API_KEYS"
    ]).concat(
      numberedKeys("ZAI_KEY_")
    ),
    model("ZAI_MODEL", DEFAULTS.zai)
  );

  // --------------------------------------------------
  // NVIDIA NIM
  // --------------------------------------------------

  addProvider(
    list,
    "nim",
    envKeys([
      "NIM_API_KEY",
      "NIM_API_KEYS"
    ]).concat(
      numberedKeys("NIM_API_KEY_")
    ),
    model("NIM_MODEL", DEFAULTS.nim)
  );

  // Deduplicate provider/key/model combinations.
  const seen = new Set();

  return list.filter(item => {
    const id =
      `${item.provider}:${item.model}:${item.key}`;

    if (seen.has(id)) return false;

    seen.add(id);
    return true;
  });
}


// --------------------------------------------------
// PROVIDER HEALTH / COOLDOWN
// --------------------------------------------------

function providerId(item) {
  return `${item.provider}:${item.model}:${item.key.slice(-8)}`;
}

function isTemporarilyBlocked(item) {
  const until = providerHealth.get(providerId(item));

  return Boolean(
    until &&
    until > Date.now()
  );
}

function markProvider(item, err) {
  const status = Number(err?.status || 0);
  const id = providerId(item);

  if (status === 429) {
    providerHealth.set(
      id,
      Date.now() + 45_000
    );
  }

  else if (status === 402) {
    providerHealth.set(
      id,
      Date.now() + 60_000
    );
  }

  else if (status === 401) {
    providerHealth.set(
      id,
      Date.now() + 90_000
    );
  }

  else if (status === 403) {
    providerHealth.set(
      id,
      Date.now() + 120_000
    );
  }

  else if (
    [408, 409, 500, 502, 503, 504]
      .includes(status)
  ) {
    providerHealth.set(
      id,
      Date.now() + 15_000
    );
  }
}

function isRetryable(err) {
  return [
    400,
    401,
    402,
    403,
    404,
    408,
    409,
    429,
    500,
    502,
    503,
    504
  ].includes(
    Number(err?.status || 0)
  );
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


// --------------------------------------------------
// FETCH WITH TIMEOUT
// --------------------------------------------------

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = 18_000
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(
      url,
      {
        ...options,
        signal: controller.signal
      }
    );
  }

  catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(
        "Provider request timed out."
      );

      e.status = 408;

      throw e;
    }

    throw err;
  }

  finally {
    clearTimeout(timer);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  }

  catch (_) {
    return {};
  }
}

function providerError(
  name,
  status,
  data
) {
  const msg =
    data?.error?.message ||
    data?.error?.type ||
    data?.error?.status ||
    data?.message ||
    `HTTP ${status}`;

  const e = new Error(
    `${name} ${status}: ${msg}`
  );

  e.status = Number(status);
  e.provider = name;

  return e;
}

function ensureContent(
  name,
  content
) {
  if (
    !content ||
    !String(content).trim()
  ) {
    const e = new Error(
      `${name} returned an empty response.`
    );

    e.status = 502;
    e.provider = name;

    throw e;
  }

  return String(content);
}


// --------------------------------------------------
// OPENAI-COMPATIBLE PROVIDERS
// Cerebras / Mistral / Z.AI / NVIDIA
// --------------------------------------------------

async function callOpenAICompatible({
  providerName,
  url,
  key,
  modelName,
  system,
  userPrompt,
  extraHeaders = {},
  extraBody = {}
}) {

  const response =
    await fetchWithTimeout(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            `Bearer ${key}`,

          ...extraHeaders
        },

        body: JSON.stringify({
          model: modelName,

          messages: [
            {
              role: "system",
              content: system
            },

            {
              role: "user",
              content: userPrompt
            }
          ],

          temperature: 0.55,

          max_tokens: 800,

          stream: false,

          ...extraBody
        })
      }
    );

  const data =
    await safeJson(response);

  if (!response.ok) {
    throw providerError(
      providerName,
      response.status,
      data
    );
  }

  return ensureContent(
    providerName,
    data?.choices?.[0]
      ?.message
      ?.content
  );
}


// --------------------------------------------------
// GROQ
// --------------------------------------------------

async function callGroq(
  item,
  system,
  userPrompt
) {

  const url =
    "https://api.groq.com/openai/v1/chat/completions";

  // First attempt: JSON mode.
  const first =
    await fetchWithTimeout(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Authorization":
            `Bearer ${item.key}`
        },

        body: JSON.stringify({
          model: item.model,

          messages: [
            {
              role: "system",
              content: system
            },

            {
              role: "user",
              content: userPrompt
            }
          ],

          temperature: 0.55,

          max_completion_tokens: 800,

          response_format: {
            type: "json_object"
          }
        })
      }
    );

  let data =
    await safeJson(first);

  const failedJsonGeneration =
    first.status === 400 &&
    (
      String(
        data?.error?.message || ""
      )
        .toLowerCase()
        .includes(
          "failed to validate json"
        )

      ||

      String(
        data?.error?.message || ""
      )
        .toLowerCase()
        .includes(
          "failed_generation"
        )

      ||

      String(
        data?.error?.code || ""
      )
        .toLowerCase()
        .includes(
          "failed_generation"
        )
    );

  // Important:
  // We've repeatedly seen this exact Groq failure.
  // Don't make the user press Try Again.
  // Retry the same provider without JSON mode.
  if (failedJsonGeneration) {

    const retry =
      await fetchWithTimeout(
        url,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "Authorization":
              `Bearer ${item.key}`
          },

          body: JSON.stringify({
            model: item.model,

            messages: [
              {
                role: "system",
                content: system
              },

              {
                role: "user",
                content: userPrompt
              }
            ],

            temperature: 0.45,

            max_completion_tokens: 800
          })
        }
      );

    data =
      await safeJson(retry);

    if (!retry.ok) {
      throw providerError(
        "Groq",
        retry.status,
        data
      );
    }

    return ensureContent(
      "Groq",
      data?.choices?.[0]
        ?.message
        ?.content
    );
  }

  if (!first.ok) {
    throw providerError(
      "Groq",
      first.status,
      data
    );
  }

  return ensureContent(
    "Groq",
    data?.choices?.[0]
      ?.message
      ?.content
  );
}


// --------------------------------------------------
// CEREBRAS
// --------------------------------------------------

async function callCerebras(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({
    providerName: "Cerebras",

    url:
      "https://api.cerebras.ai/v1/chat/completions",

    key: item.key,

    modelName: item.model,

    system,

    userPrompt
  });
}


// --------------------------------------------------
// MISTRAL
// --------------------------------------------------

async function callMistral(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({
    providerName: "Mistral",

    url:
      "https://api.mistral.ai/v1/chat/completions",

    key: item.key,

    modelName: item.model,

    system,

    userPrompt
  });
}


// --------------------------------------------------
// Z.AI
// --------------------------------------------------

async function callZai(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({
    providerName: "Z.AI",

    url:
      "https://api.z.ai/api/paas/v4/chat/completions",

    key: item.key,

    modelName: item.model,

    system,

    userPrompt,

    extraHeaders: {
      "Accept-Language":
        "en-US,en"
    }
  });
}


// --------------------------------------------------
// NVIDIA NIM
// --------------------------------------------------

async function callNim(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({
    providerName:
      "NVIDIA NIM",

    url:
      "https://integrate.api.nvidia.com/v1/chat/completions",

    key: item.key,

    modelName: item.model,

    system,

    userPrompt
  });
}


// --------------------------------------------------
// GEMINI
// --------------------------------------------------

async function callGemini(
  item,
  system,
  userPrompt
) {

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(item.model)}:generateContent`;

  const response =
    await fetchWithTimeout(
      url,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            item.key
        },

        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: system
              }
            ]
          },

          contents: [
            {
              role: "user",

              parts: [
                {
                  text: userPrompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature: 0.55,

            maxOutputTokens: 800,

            responseMimeType:
              "application/json"
          }
        })
      }
    );

  const data =
    await safeJson(response);

  if (!response.ok) {
    throw providerError(
      "Gemini",
      response.status,
      data
    );
  }

  const text =
    data?.candidates?.[0]
      ?.content?.parts
      ?.map(
        part => part?.text || ""
      )
      .join("");

  return ensureContent(
    "Gemini",
    text
  );
}


// --------------------------------------------------
// PROVIDER DISPATCH
// --------------------------------------------------

async function callProvider(
  item,
  system,
  userPrompt
) {

  switch (item.provider) {

    case "groq":
      return callGroq(
        item,
        system,
        userPrompt
      );

    case "cerebras":
      return callCerebras(
        item,
        system,
        userPrompt
      );

    case "gemini":
      return callGemini(
        item,
        system,
        userPrompt
      );

    case "mistral":
      return callMistral(
        item,
        system,
        userPrompt
      );

    case "zai":
      return callZai(
        item,
        system,
        userPrompt
      );

    case "nim":
      return callNim(
        item,
        system,
        userPrompt
      );

    default:
      throw new Error(
        `Unsupported provider: ${item.provider}`
      );
  }
}


// --------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------

async function handler(
  req,
  res
) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "POST only."
    });
  }

  const pool =
    providers();

  if (!pool.length) {

    return res.status(500).json({
      error:
        "No AI provider keys are configured. Add your provider keys to Vercel Environment Variables."
    });
  }

  const body =
    req.body || {};

  const system =
    String(body.system || "");

  const userPrompt =
    String(body.userPrompt || "");

  if (!system || !userPrompt) {

    return res.status(400).json({
      error:
        "Missing AI request content."
    });
  }

  // Hard protection against accidentally
  // turning this into an unrestricted proxy.

  if (
    system.length > 20_000 ||
    userPrompt.length > 30_000
  ) {

    return res.status(413).json({
      error:
        "Request is too large."
    });
  }

  const start =
    cursor++ % pool.length;

  let lastError =
    null;

  let attemptedAny =
    false;

  // --------------------------------------------------
  // PASS 1 + PASS 2
  // --------------------------------------------------

  for (
    let round = 0;
    round < 2;
    round++
  ) {

    for (
      let offset = 0;
      offset < pool.length;
      offset++
    ) {

      const item =
        pool[
          (start + offset) %
          pool.length
        ];

      // Skip providers currently known
      // to be rate-limited/unavailable.

      if (
        round === 0 &&
        isTemporarilyBlocked(item)
      ) {
        continue;
      }

      attemptedAny =
        true;

      try {

        const content =
          await callProvider(
            item,
            system,
            userPrompt
          );

        return res.status(200).json({
          content,

          provider:
            item.provider,

          model:
            item.model
        });

      }

      catch (err) {

        lastError =
          err;

        markProvider(
          item,
          err
        );

        // Provider errors → fail over.
        // Unexpected application errors →
        // don't blindly hammer every provider.

        if (
          !isRetryable(err)
        ) {
          break;
        }
      }
    }

    if (
      round === 0 &&
      attemptedAny
    ) {
      await sleep(150);
    }
  }


  // --------------------------------------------------
  // FINAL PROBE
  // --------------------------------------------------

  // This catches cases where every provider was
  // temporarily marked unavailable on a warm
  // Vercel instance.

  for (
    const item of pool
  ) {

    try {

      const content =
        await callProvider(
          item,
          system,
          userPrompt
        );

      return res.status(200).json({
        content,

        provider:
          item.provider,

        model:
          item.model
      });

    }

    catch (err) {

      lastError =
        err;
    }
  }


  // --------------------------------------------------
  // EVERYTHING FAILED
  // --------------------------------------------------

  const detail =
    lastError?.message
      ? ` Last provider error: ${lastError.message}`
      : "";

  return res.status(503).json({
    error:
      "All configured AI providers are currently unavailable, rate-limited, or temporarily rejecting generation." +
      detail
  });
}


// --------------------------------------------------
// TOP-LEVEL SAFETY WRAPPER
// --------------------------------------------------

export default async function safeHandler(
  req,
  res
) {

  try {

    return await handler(
      req,
      res
    );

  }

  catch (err) {

    console.error(
      "Study Hall API unhandled error:",
      err
    );

    return res.status(500).json({
      error:
        "Server-side quiz engine error: " +
        (
          err?.message ||
          "Unknown error"
        )
    });
  }
}

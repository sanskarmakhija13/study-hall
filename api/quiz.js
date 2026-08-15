// api/quiz.js
// Study Hall — Multi-provider AI gateway
//
// Provider priority:
//   Groq key 1 → Groq key 2 → Groq key 3
//   → Cerebras key 1 → Cerebras key 2
//   → Gemini
//   → Mistral key 1 → Mistral key 2
//   → Z.AI key 1 → Z.AI key 2
//   → NVIDIA NIM
//
// Each API key is treated as an independent account/quota.
//
// Supported Vercel environment variables:
//
// GROQ_API_KEYS
// GROQ_API_KEYS2
// GROQ_API_KEYS_3
//
// CEREBRAS_API_KEYS
// CEREBRAS_API_KEY_1
// CEREBRAS_API_KEY_2
//
// GEMINI_API_KEY
//
// MISTRAL_API_KEY_1
// MISTRAL_API_KEY_2
//
// ZAI_KEY_1
// ZAI_KEY_2
//
// NIM_API_KEY
//
// Optional model overrides:
// GROQ_MODEL
// CEREBRAS_MODEL
// GEMINI_MODEL
// MISTRAL_MODEL
// ZAI_MODEL
// NIM_MODEL


// ============================================================
// DEFAULT MODELS
// ============================================================

const DEFAULTS = {
  groq: "openai/gpt-oss-20b",
  cerebras: "gpt-oss-120b",
  gemini: "gemini-2.5-flash-lite",
  mistral: "mistral-small-latest",
  zai: "glm-4.7-flash",
  nim: "nvidia/nemotron-3-super-120b-a12b"
};


// ============================================================
// TEMPORARY ACCOUNT COOLDOWNS
// ============================================================

const providerHealth = new Map();

function accountId(item) {
  return `${item.provider}:${item.key.slice(-12)}`;
}

function isTemporarilyBlocked(item) {
  const until = providerHealth.get(
    accountId(item)
  );

  return Boolean(
    until &&
    until > Date.now()
  );
}

function markProvider(item, error) {
  const status = Number(
    error?.status || 0
  );

  let cooldown = 0;

  if (status === 429) {
    cooldown = 45_000;
  } else if (status === 402) {
    cooldown = 60_000;
  } else if (status === 401) {
    cooldown = 90_000;
  } else if (status === 403) {
    cooldown = 120_000;
  } else if (
    [408, 409, 500, 502, 503, 504]
      .includes(status)
  ) {
    cooldown = 15_000;
  }

  if (cooldown) {
    providerHealth.set(
      accountId(item),
      Date.now() + cooldown
    );
  }
}


// ============================================================
// ENVIRONMENT VARIABLE HELPERS
// ============================================================

function splitValue(value) {
  return String(value || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function envKeys(names) {
  const keys = [];
  const seen = new Set();

  for (const name of names) {
    for (const key of splitValue(
      process.env[name]
    )) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys;
}

function numberedKeys(prefix) {
  const keys = [];
  const seen = new Set();

  for (
    const [name, value]
    of Object.entries(process.env)
  ) {
    if (!name.startsWith(prefix)) {
      continue;
    }

    if (!value) {
      continue;
    }

    for (
      const key
      of splitValue(value)
    ) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }

  return keys;
}

function getModel(
  envName,
  fallback
) {
  return String(
    process.env[envName] ||
    fallback
  ).trim();
}


// ============================================================
// PROVIDER GROUPS
// ============================================================
//
// IMPORTANT:
//
// Every key is preserved as its own account.
//
// We do NOT round-robin between providers.
//
// We exhaust all Groq accounts first,
// then move to Cerebras, etc.
// ============================================================

function getProviderGroups() {
  return [

    // --------------------------------------------------------
    // GROQ
    // --------------------------------------------------------

    {
      provider: "groq",

      keys: envKeys([
        "GROQ_API_KEYS",
        "GROQ_API_KEYS2",
        "GROQ_API_KEYS_3"
      ]),

      model: getModel(
        "GROQ_MODEL",
        DEFAULTS.groq
      )
    },


    // --------------------------------------------------------
    // CEREBRAS
    // --------------------------------------------------------

    {
      provider: "cerebras",

      keys: envKeys([
        "CEREBRAS_API_KEYS"
      ]).concat(
        numberedKeys(
          "CEREBRAS_API_KEY_"
        )
      ),

      model: getModel(
        "CEREBRAS_MODEL",
        DEFAULTS.cerebras
      )
    },


    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    {
      provider: "gemini",

      keys: envKeys([
        "GEMINI_API_KEY",
        "GEMINI_API_KEYS"
      ]).concat(
        numberedKeys(
          "GEMINI_API_KEY_"
        )
      ),

      model: getModel(
        "GEMINI_MODEL",
        DEFAULTS.gemini
      )
    },


    // --------------------------------------------------------
    // MISTRAL
    // --------------------------------------------------------

    {
      provider: "mistral",

      keys: envKeys([
        "MISTRAL_API_KEYS"
      ]).concat(
        numberedKeys(
          "MISTRAL_API_KEY_"
        )
      ),

      model: getModel(
        "MISTRAL_MODEL",
        DEFAULTS.mistral
      )
    },


    // --------------------------------------------------------
    // Z.AI
    // --------------------------------------------------------

    {
      provider: "zai",

      keys: envKeys([
        "ZAI_KEYS",
        "ZAI_API_KEYS"
      ]).concat(
        numberedKeys(
          "ZAI_KEY_"
        )
      ),

      model: getModel(
        "ZAI_MODEL",
        DEFAULTS.zai
      )
    },


    // --------------------------------------------------------
    // NVIDIA NIM
    // --------------------------------------------------------

    {
      provider: "nim",

      keys: envKeys([
        "NIM_API_KEY",
        "NIM_API_KEYS"
      ]).concat(
        numberedKeys(
          "NIM_API_KEY_"
        )
      ),

      model: getModel(
        "NIM_MODEL",
        DEFAULTS.nim
      )
    }

  ].filter(
    group =>
      group.keys.length > 0
  );
}


// ============================================================
// UTILITIES
// ============================================================

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(
      resolve,
      ms
    )
  );
}

async function fetchWithTimeout(
  url,
  options,
  timeoutMs = 9_000
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
        signal:
          controller.signal
      }
    );

  } catch (error) {

    if (
      error?.name ===
      "AbortError"
    ) {
      const timeoutError =
        new Error(
          "Provider request timed out."
        );

      timeoutError.status = 408;

      throw timeoutError;
    }

    throw error;

  } finally {
    clearTimeout(timer);
  }
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function providerError(
  provider,
  status,
  data
) {
  const message =
    data?.error?.message ||
    data?.error?.type ||
    data?.error?.status ||
    data?.message ||
    `HTTP ${status}`;

  const error =
    new Error(
      `${provider} ${status}: ${message}`
    );

  error.status =
    Number(status);

  error.provider =
    provider;

  return error;
}

function ensureContent(
  provider,
  content
) {
  if (
    !content ||
    !String(content).trim()
  ) {
    const error =
      new Error(
        `${provider} returned an empty response.`
      );

    error.status = 502;
    error.provider =
      provider;

    throw error;
  }

  return String(content);
}


// ============================================================
// OPENAI-COMPATIBLE PROVIDERS
// ============================================================

async function callOpenAICompatible({
  providerName,
  url,
  key,
  modelName,
  system,
  userPrompt
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
            `Bearer ${key}`
        },

        body: JSON.stringify({

          model:
            modelName,

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

          temperature:
            0.5,

          max_tokens:
            800,

          stream:
            false
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


// ============================================================
// GROQ
// ============================================================

async function callGroq(
  item,
  system,
  userPrompt
) {

  const url =
    "https://api.groq.com/openai/v1/chat/completions";


  // ----------------------------------------------------------
  // FIRST ATTEMPT — JSON MODE
  // ----------------------------------------------------------

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

          model:
            item.model,

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

          temperature:
            0.5,

          max_completion_tokens:
            800,

          response_format: {
            type:
              "json_object"
          }
        })
      }
    );

  let data =
    await safeJson(first);


  // ----------------------------------------------------------
  // GROQ JSON VALIDATION FAILURE
  // ----------------------------------------------------------
  // Do not spend a second full network round-trip on the same
  // account. The caller can fail over to another account/provider.
  // This is intentionally a fast-fail path.

  // ----------------------------------------------------------
  // NORMAL GROQ ERROR
  // ----------------------------------------------------------

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


// ============================================================
// CEREBRAS
// ============================================================

async function callCerebras(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({

    providerName:
      "Cerebras",

    url:
      "https://api.cerebras.ai/v1/chat/completions",

    key:
      item.key,

    modelName:
      item.model,

    system,

    userPrompt
  });
}


// ============================================================
// MISTRAL
// ============================================================

async function callMistral(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({

    providerName:
      "Mistral",

    url:
      "https://api.mistral.ai/v1/chat/completions",

    key:
      item.key,

    modelName:
      item.model,

    system,

    userPrompt
  });
}


// ============================================================
// Z.AI
// ============================================================

async function callZai(
  item,
  system,
  userPrompt
) {

  return callOpenAICompatible({

    providerName:
      "Z.AI",

    url:
      "https://api.z.ai/api/paas/v4/chat/completions",

    key:
      item.key,

    modelName:
      item.model,

    system,

    userPrompt
  });
}


// ============================================================
// NVIDIA NIM
// ============================================================

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

    key:
      item.key,

    modelName:
      item.model,

    system,

    userPrompt
  });
}


// ============================================================
// GEMINI
// ============================================================

async function callGemini(
  item,
  system,
  userPrompt
) {

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      item.model
    )}:generateContent`;

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
                text:
                  system
              }
            ]
          },

          contents: [
            {
              role:
                "user",

              parts: [
                {
                  text:
                    userPrompt
                }
              ]
            }
          ],

          generationConfig: {
            temperature:
              0.5,

            maxOutputTokens:
              800,

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
        part =>
          part?.text || ""
      )
      .join("");

  return ensureContent(
    "Gemini",
    text
  );
}


// ============================================================
// PROVIDER DISPATCH
// ============================================================

async function callProvider(
  item,
  system,
  userPrompt
) {

  switch (
    item.provider
  ) {

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

    default: {
      const error =
        new Error(
          `Unsupported provider: ${item.provider}`
        );

      error.status = 500;

      throw error;
    }
  }
}


// ============================================================
// MAIN ROUTER
// ============================================================
//
// THIS IS THE IMPORTANT PART:
//
// Provider 1:
//   Groq account 1
//   Groq account 2
//   Groq account 3
//
// THEN:
//
// Provider 2:
//   Cerebras account 1
//   Cerebras account 2
//
// THEN:
//
// Gemini
//
// THEN:
//
// Mistral account 1
// Mistral account 2
//
// etc.
// ============================================================

async function callAI(
  system,
  userPrompt
) {

  const groups = getProviderGroups();

  if (!groups.length) {
    throw new Error(
      "No AI provider API keys are configured."
    );
  }

  // Fast path: race one account from the first three configured
  // providers. This avoids waiting through a slow/dead provider.
  // Only three requests are started in parallel; the remaining
  // accounts are used as a bounded fallback pool.
  const candidates = [];
  for (const group of groups) {
    for (let i = 0; i < group.keys.length; i++) {
      const item = { provider: group.provider, key: group.keys[i], model: group.model };
      if (!isTemporarilyBlocked(item)) {
        candidates.push({ item, keyIndex: i + 1 });
        break;
      }
    }
    if (candidates.length >= 3) break;
  }

  const attempted = new Set();
  let lastError = null;

  async function attempt(candidate) {
    const { item, keyIndex } = candidate;
    const id = accountId(item);
    attempted.add(id);
    console.log(`[Study Hall] Fast path: ${item.provider} account ${keyIndex}`);
    try {
      const content = await callProvider(item, system, userPrompt);
      console.log(`[Study Hall] SUCCESS — ${item.provider} account ${keyIndex}`);
      return { content, provider: item.provider, model: item.model, keyIndex };
    } catch (error) {
      lastError = error;
      markProvider(item, error);
      console.warn(`[Study Hall] FAILED — ${item.provider} account ${keyIndex}: ${error?.message || error}`);
      throw error;
    }
  }

  if (candidates.length) {
    try {
      return await Promise.any(candidates.map(attempt));
    } catch (_) {
      // Fall through to the remaining bounded pool.
    }
  }

  // Fallback: one attempt per remaining healthy account, with the
  // same short timeout. No nested retries here.
  for (const group of groups) {
    for (let keyIndex = 0; keyIndex < group.keys.length; keyIndex++) {
      const item = { provider: group.provider, key: group.keys[keyIndex], model: group.model };
      if (attempted.has(accountId(item)) || isTemporarilyBlocked(item)) continue;

      try {
        const content = await callProvider(item, system, userPrompt);
        console.log(`[Study Hall] SUCCESS — fallback ${group.provider} account ${keyIndex + 1}`);
        return { content, provider: group.provider, model: group.model, keyIndex: keyIndex + 1 };
      } catch (error) {
        lastError = error;
        markProvider(item, error);
        console.warn(`[Study Hall] FAILED — fallback ${group.provider} account ${keyIndex + 1}: ${error?.message || error}`);
      }
    }
  }

  const error = new Error(
    "All configured AI providers are currently unavailable, rate-limited, or temporarily rejecting generation."
  );
  error.status = 503;
  error.lastProviderError = lastError?.message || null;
  throw error;
}

// ============================================================
// VERCEL HANDLER
// ============================================================

async function handler(
  req,
  res
) {

  if (
    req.method !==
    "POST"
  ) {

    return res
      .status(405)
      .json({
        error:
          "POST only."
      });
  }


  const body =
    req.body || {};


  const system =
    String(
      body.system || ""
    );

  const userPrompt =
    String(
      body.userPrompt || ""
    );


  if (
    !system ||
    !userPrompt
  ) {

    return res
      .status(400)
      .json({
        error:
          "Missing AI request content."
      });
  }


  // Prevent accidentally sending enormous
  // requests to every provider.

  if (
    system.length >
      20_000 ||
    userPrompt.length >
      30_000
  ) {

    return res
      .status(413)
      .json({
        error:
          "Request is too large."
      });
  }


  try {

    const result =
      await callAI(
        system,
        userPrompt
      );


    return res
      .status(200)
      .json({

        content:
          result.content,

        provider:
          result.provider,

        model:
          result.model,

        // Useful for debugging.
        // This does NOT expose the API key.
        keyIndex:
          result.keyIndex
      });

  }

  catch (error) {

    console.error(
      "[Study Hall] AI generation failed:",
      error
    );


    return res
      .status(
        error?.status === 503
          ? 503
          : 500
      )
      .json({

        error:
          error?.message ||
          "AI generation failed.",

        lastProviderError:
          error?.lastProviderError ||
          null
      });
  }
}


// ============================================================
// TOP-LEVEL SAFETY WRAPPER
// ============================================================

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

  catch (error) {

    console.error(
      "[Study Hall] Unhandled API error:",
      error
    );

    return res
      .status(500)
      .json({

        error:
          "Server-side quiz engine error.",

        detail:
          error?.message ||
          "Unknown error."
      });
  }
}

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
let providerHealth = new Map();

function splitKeys(name) {
  return String(process.env[name] || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean);
}

function splitModels(name, fallback) {
  let value = String(process.env[name] || "").trim();
  return value ? value.split(",").map(x => x.trim()).filter(Boolean) : fallback;
}

function providers() {
  let list = [];

  for (let key of splitKeys("CEREBRAS_API_KEYS")) {
    list.push({
      provider: "cerebras",
      key,
      model: process.env.CEREBRAS_MODEL || "gpt-oss-120b"
    });
  }

  let groqModels = splitModels("GROQ_MODELS", [
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "llama-3.1-8b-instant"
  ]);
  for (let key of splitKeys("GROQ_API_KEYS")) {
    for (let model of groqModels) {
      list.push({ provider: "groq", key, model });
    }
  }

  let geminiModels = splitModels("GEMINI_MODELS", [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash"
  ]);
  for (let key of splitKeys("GEMINI_API_KEYS")) {
    for (let model of geminiModels) {
      list.push({ provider: "gemini", key, model });
    }
  }

  return list;
}

async function callCerebras(item, system, userPrompt) {
  let r = await fetch("https://api.cerebras.ai/v1/chat/completions", {
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
      max_completion_tokens: 800,
      response_format: { type: "json_object" }
    })
  });

  let data = await safeJson(r);
  if (!r.ok) throw providerError("Cerebras", r.status, data);
  return data?.choices?.[0]?.message?.content || "";
}

async function callGroq(item, system, userPrompt) {
  let base = {
    model: item.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.65,
    max_completion_tokens: 800
  };

  async function request(body) {
    return fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${item.key}`
      },
      body: JSON.stringify(body)
    });
  }

  // First try Groq JSON mode.
  let r = await request({
    ...base,
    response_format: { type: "json_object" }
  });

  let data = await safeJson(r);

  // Some Groq models occasionally return 400 "Failed to validate JSON"
  // even though the request itself is valid. Retry that SAME provider/model
  // once without JSON mode; the system prompt still requires raw JSON and
  // the browser parser validates it.
  let failedJsonGeneration =
    r.status === 400 &&
    (
      String(data?.error?.message || "").toLowerCase().includes("failed to validate json") ||
      String(data?.error?.code || "").toLowerCase().includes("failed_generation")
    );

  if (failedJsonGeneration) {
    r = await request(base);
    data = await safeJson(r);
  }

  if (!r.ok) throw providerError("Groq", r.status, data);
  return data?.choices?.[0]?.message?.content || "";
}

async function callGemini(item, system, userPrompt) {
  let url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(item.model)}:generateContent?key=${encodeURIComponent(item.key)}`;

  let r = await fetch(url, {
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
        maxOutputTokens: 800,
        responseMimeType: "application/json"
      }
    })
  });

  let data = await safeJson(r);
  if (!r.ok) throw providerError("Gemini", r.status, data);

  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}

async function safeJson(r) {
  try { return await r.json(); }
  catch (_) { return {}; }
}

function providerError(name, status, data) {
  let msg =
    data?.error?.message ||
    data?.error?.status ||
    data?.message ||
    `HTTP ${status}`;

  let e = new Error(`${name} ${status}: ${msg}`);
  e.status = status;
  e.provider = name;
  return e;
}

function isRetryable(err) {
  return [400, 401, 402, 403, 404, 408, 409, 429, 500, 502, 503, 504].includes(err?.status);
}

function providerId(item) {
  return `${item.provider}:${item.model}:${item.key.slice(-8)}`;
}
function isTemporarilyBlocked(item) {
  let until = providerHealth.get(providerId(item));
  return until && until > Date.now();
}
function markProvider(item, err) {
  let id=providerId(item);
  // Keep cooldowns short because Vercel functions can recover between requests
  // and provider limits/billing responses can be transient.
  if(err?.status===429) providerHealth.set(id,Date.now()+45*1000);
  else if(err?.status===402) providerHealth.set(id,Date.now()+20*1000);
  else if(err?.status===401) providerHealth.set(id,Date.now()+90*1000);
  else if(err?.status===403) providerHealth.set(id,Date.now()+120*1000);
  else if([500,502,503,504].includes(err?.status)) providerHealth.set(id,Date.now()+15*1000);
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only." });
  }

  let pool = providers();
  if (!pool.length) {
    return res.status(500).json({
      error:
        "No AI provider keys are configured on the server. Add CEREBRAS_API_KEYS, GROQ_API_KEYS, or GEMINI_API_KEYS in your deployment environment."
    });
  }

  let body = req.body || {};
  let system = String(body.system || "");
  let userPrompt = String(body.userPrompt || "");

  if (!system || !userPrompt) {
    return res.status(400).json({ error: "Missing AI request content." });
  }

  // Hard guard against accidentally turning this endpoint into a giant proxy.
  if (system.length > 20000 || userPrompt.length > 30000) {
    return res.status(413).json({ error: "Request is too large." });
  }

  // Try healthy providers in rotation. If every provider has a transient failure,
  // make one additional pass so users do not have to press Try again themselves.
  let start = cursor++ % pool.length;
  let lastError = null;

  for (let round=0; round<3; round++) {
    let attempted=0;
    for (let offset=0; offset<pool.length; offset++) {
      let item=pool[(start+offset)%pool.length];
      if(isTemporarilyBlocked(item)) continue;
      attempted++;
      try{
        let content="";
        if(item.provider==="cerebras") content=await callCerebras(item,system,userPrompt);
        else if(item.provider==="groq") content=await callGroq(item,system,userPrompt);
        else if(item.provider==="gemini") content=await callGemini(item,system,userPrompt);
        if(!content) throw new Error(`${item.provider} returned an empty response.`);
        return res.status(200).json({content,provider:item.provider,model:item.model});
      }catch(err){
        lastError=err;
        markProvider(item,err);
        if(!isRetryable(err)) break;
      }
    }
    if(round<2 && attempted>0) await sleep(200 + round*150);
  }

  // A warm Vercel instance may have temporarily cooled every provider.
  // Probe each configured provider once before giving up, so a transient 402/429
  // does not force the learner to press Try Again manually.
  for (let item of pool) {
    try {
      let content="";
      if(item.provider==="cerebras") content=await callCerebras(item,system,userPrompt);
      else if(item.provider==="groq") content=await callGroq(item,system,userPrompt);
      else if(item.provider==="gemini") content=await callGemini(item,system,userPrompt);
      if(content) return res.status(200).json({content,provider:item.provider,model:item.model});
    } catch(err) {
      lastError=err;
      // Do not extend the cooldown during the final probe.
    }
  }

  let detail=lastError?.message ? ` Last provider error: ${lastError.message}` : "";
  return res.status(503).json({
    error:
      "All configured AI providers failed this request. The gateway tried every configured key/model multiple times." +
      detail
  });
}

async function safeHandler(req, res) {
  try {
    return await handler(req, res);
  } catch (err) {
    console.error("Study Hall API unhandled error:", err);
    return res.status(500).json({
      error: "Server-side quiz engine error: " + (err?.message || "Unknown error")
    });
  }
}

export default safeHandler;

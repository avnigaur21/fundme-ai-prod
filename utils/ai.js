const fs = require('fs');
const path = require('path');

function parseKeyFile(keyName) {
  try {
    const keyFilePath = ['keys.txt', 'key.txt']
      .map(file => path.join(__dirname, '..', file))
      .find(file => fs.existsSync(file));

    if (!keyFilePath) return "";

    const content = fs.readFileSync(keyFilePath, 'utf-8');
    const lines = content.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(keyName + '=')) {
        const sameLine = lines[i].split('=')[1]?.trim();
        if (sameLine) return sameLine;
        if (i + 1 < lines.length) return lines[i + 1].trim();
      }
    }

    return lines[0] || "";
  } catch (err) {
    console.warn(`⚠️  Could not read key.txt for ${keyName}.`);
    return "";
  }
}

function getGroqKey() {
  return process.env.GROQ_API_KEY || process.env.GROQ_KEY || parseKeyFile('GROQ_API_KEY') || parseKeyFile('GROQ_KEY');
}

function getOpenRouterKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || parseKeyFile('OPENROUTER_API_KEY') || parseKeyFile('OPENROUTER_KEY');
}

function getGoogleKey() {
  return process.env.GOOGLE_API_KEY || parseKeyFile('GOOGLE_API_KEY');
}

// ─── Raw provider helpers ──────────────────────────────────────────────────────

async function callGroq(prompt, model) {
  const groqKey = getGroqKey();
  if (!groqKey) return null;
  try {
    console.log(`✨ AI: Trying Groq (${model})...`);
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1 })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }
    const errText = await res.text().catch(() => "");
    if (res.status === 403) {
      console.warn(`⚠️ Groq (${model}) blocked at project level (403). Skipping.`);
      return null;
    }
    if (res.status === 413) {
      console.warn(`⚠️ Groq (${model}) prompt too large (413). Skipping.`);
      return null;
    }
    console.warn(`⚠️ Groq (${model}) failed: ${res.status}. ${errText.substring(0, 120)}`);
    return null;
  } catch (err) {
    console.warn(`⚠️ Groq (${model}) error: ${err.message}`);
    return null;
  }
}

async function callOpenRouterModel(prompt, model) {
  const orKey = getOpenRouterKey();
  if (!orKey) return null;
  try {
    console.log(`✨ AI: Trying OpenRouter (${model})...`);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${orKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "FundMe v8"
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0.1 })
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content;
    }
    const errText = await res.text().catch(() => "");
    if (res.status === 404) {
      console.warn(`⚠️ OpenRouter (${model}) not found (404). Skipping.`);
      return null;
    }
    console.warn(`⚠️ OpenRouter (${model}) failed: ${res.status}. ${errText.substring(0, 120)}`);
    return null;
  } catch (err) {
    console.warn(`⚠️ OpenRouter (${model}) error: ${err.message}`);
    return null;
  }
}

/**
 * Google AI Studio (Gemini API) helper.
 * Uses the generateContent endpoint which is NOT OpenAI-compatible.
 * Model IDs: gemma-4-26b-a4b-it, gemma-4-31b-it, gemini-2.0-flash, etc.
 */
async function callGoogleAI(prompt, model) {
  const googleKey = getGoogleKey();
  if (!googleKey) return null;
  try {
    console.log(`✨ AI: Trying Google AI Studio (${model})...`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${googleKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          response_mime_type: "application/json"  // Force pure JSON output — prevents markdown/explanatory responses
        }
      })
    });
    if (res.ok) {
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) return text;
      console.warn(`⚠️ Google AI (${model}) returned empty response.`);
      return null;
    }
    const errText = await res.text().catch(() => "");
    if (res.status === 429) {
      console.warn(`⚠️ Google AI (${model}) rate limited (429). Skipping.`);
      return null;
    }
    console.warn(`⚠️ Google AI (${model}) failed: ${res.status}. ${errText.substring(0, 120)}`);
    return null;
  } catch (err) {
    console.warn(`⚠️ Google AI (${model}) error: ${err.message}`);
    return null;
  }
}

// ─── General Purpose LLM (Scraping, Matching, Formatting) ─────────────────────
// Tier 1: Groq Llama 3.3 70B  — fast & smart
// Tier 2: Groq Llama 3.1 8B   — high daily limit (14,400 req/day) safety net
// Tier 3: OpenRouter Llama 8B  — last resort

async function callLLM(prompt, retries = 1) {
  const r70b = await callGroq(prompt, 'llama-3.3-70b-versatile');
  if (r70b) return r70b;

  const r8b = await callGroq(prompt, 'llama-3.1-8b-instant');
  if (r8b) return r8b;

  const rOR = await callOpenRouterModel(prompt, 'meta-llama/llama-3.1-8b-instruct:free');
  if (rOR) return rOR;

  if (retries > 0) {
    console.warn(`⚠️ All general providers failed. Retrying in 3s... (${retries} left)`);
    await new Promise(r => setTimeout(r, 3000));
    return callLLM(prompt, retries - 1);
  }

  throw new Error("All AI providers (Groq 70B, Groq 8B, OpenRouter) failed or are missing keys.");
}

// ─── Draft Writing LLM (High-Quality Reasoning) ───────────────────────────────
// Tier 1: Google AI Studio — Gemma 4 26B (free, best for JSON & reasoning)
// Tier 2: Groq             — Llama 3.3 70B (fast, smart, 1,000 req/day)
// Tier 3: OpenRouter       — Llama 3.1 8B free (global shared pool)
// Tier 4: Groq             — Llama 3.1 8B (14,400 req/day safety net)

async function callLLMForDraft(prompt, retries = 1) {
  // Tier 1: Gemma 4 via Google AI Studio (most generous free limits)
  const rGemma4 = await callGoogleAI(prompt, 'gemma-4-26b-a4b-it');
  if (rGemma4) return rGemma4;

  // Tier 2: Llama 3.3 70B on Groq (fast, reliable)
  const r70b = await callGroq(prompt, 'llama-3.3-70b-versatile');
  if (r70b) return r70b;

  // Tier 3: Llama 3.1 8B on OpenRouter (global free pool)
  const rOR8b = await callOpenRouterModel(prompt, 'meta-llama/llama-3.1-8b-instruct:free');
  if (rOR8b) return rOR8b;

  // Tier 4: Llama 3.1 8B on Groq (14,400 req/day — almost impossible to exhaust)
  const r8b = await callGroq(prompt, 'llama-3.1-8b-instant');
  if (r8b) return r8b;

  if (retries > 0) {
    console.warn(`⚠️ All draft providers failed. Retrying in 3s... (${retries} left)`);
    await new Promise(r => setTimeout(r, 3000));
    return callLLMForDraft(prompt, retries - 1);
  }

  throw new Error("All draft AI providers exhausted. Check your API keys and model permissions.");
}

module.exports = {
  callOpenRouter: callLLM, // Backward compat alias
  callLLM,
  callLLMForDraft,
  callGoogleAI,
  getOpenRouterKey,
  getGroqKey,
  getGoogleKey,
  parseKeyFile
};

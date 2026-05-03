const fs = require('fs');
const path = require('path');

/**
 * Parse a named key from key.txt
 * Format: KEY_NAME=\n actual_key_value
 */
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
        // Check if key is on the same line after '='
        const sameLine = lines[i].split('=')[1]?.trim();
        if (sameLine) return sameLine;
        // Otherwise key is on the next line
        if (i + 1 < lines.length) return lines[i + 1].trim();
      }
    }

    // Fallback: if no labels found, return first line (backwards compat)
    return lines[0] || "";
  } catch (err) {
    console.warn(`⚠️  Could not read key.txt for ${keyName}. AI features will fail.`);
    return "";
  }
}

/**
 * Get the Groq API key (Prefers process.env for production)
 */
function getGroqKey() {
  return process.env.GROQ_API_KEY || process.env.GROQ_KEY || parseKeyFile('GROQ_API_KEY') || parseKeyFile('GROQ_KEY');
}

/**
 * Get the OpenRouter API key (Prefers process.env for production)
 */
function getOpenRouterKey() {
  return process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY || parseKeyFile('OPENROUTER_API_KEY') || parseKeyFile('OPENROUTER_KEY');
}

/**
 * Core AI fetch wrapper with Groq -> OpenRouter fallback
 */
async function callLLM(prompt, retries = 2, useFallback = true) {
  const groqKey = getGroqKey();
  const orKey = getOpenRouterKey();

  // 1. Try Groq First (Primary)
  if (groqKey) {
    try {
      console.log('✨ AI System: Attempting Groq (Primary)...');
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${groqKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.1-8b-instant",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
      
      const errorBody = await response.text().catch(() => "could not read body");
      console.warn(`⚠️ Groq failed with status ${response.status} ${response.statusText}. Body: ${errorBody}`);
    } catch (err) {
      console.warn(`⚠️ Groq error: ${err.message}`);
    }
  }

  // 2. Try OpenRouter Fallback
  if (useFallback && orKey) {
    try {
      console.log('✨ AI System: Attempting OpenRouter Fallback...');
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "FundMe v8"
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.1-8b-instruct",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        })
      });

      if (response.ok) {
        const data = await response.json();
        return data.choices[0].message.content;
      }
      
      const errorBody = await response.text().catch(() => "could not read body");
      console.warn(`⚠️ OpenRouter failed with status ${response.status} ${response.statusText}. Body: ${errorBody}`);
    } catch (err) {
      console.warn(`⚠️ OpenRouter error: ${err.message}`);
    }
  }

  // 3. Retry loop if all failed
  if (retries > 0) {
    console.warn(`⚠️ All AI providers failed. Retrying in 3s... (${retries} left)`);
    await new Promise(r => setTimeout(r, 3000));
    return callLLM(prompt, retries - 1, useFallback);
  }

  throw new Error("All AI providers (Groq & OpenRouter) failed or are missing keys.");
}

module.exports = { 
  callOpenRouter: callLLM, // Keep export name for compatibility
  callLLM,
  getOpenRouterKey,
  getGroqKey,
  parseKeyFile 
};

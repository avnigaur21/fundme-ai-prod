const { parseKeyFile } = require('../utils/ai');

/**
 * Get the OpenRouter API key from key.txt
 */
function getOpenRouterKey() {
  const key = parseKeyFile('OPENROUTER_API_KEY');
  if (!key) {
    console.error("❌ Could not find OPENROUTER_API_KEY in key.txt. Judge AI will fail.");
  }
  return key;
}

/**
 * Judge AI — evaluates actual output vs expected output using OpenRouter.
 * Uses a separate provider from the production Groq API to avoid self-evaluation bias.
 * 
 * @param {any} input - The original test input
 * @param {any} output - The actual output from the API
 * @param {any} expected - The expected output from the dataset
 * @returns {{ score: number, reason: string }}
 */
async function judgeOutput(input, output, expected) {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error("Missing OpenRouter API Key for Judge");

  const prompt = `
You are a senior AI Quality Engineer. Your job is to score an ACTUAL OUTPUT against an EXPECTED OUTPUT.

  EVALUATION RULES:
  1. JSON LENIENCE: If both are objects, score based on the presence and correctness of the EXPECTED fields. 
     - Do NOT penalize for extra fields (like "target_customers" or "business_model") if they look logically correct and follow the startup's context.
     - Look for "semantic" matches (e.g., "Agri-Tech" is the same as "Agricultural Technology").
  
  2. MATCH SCORING (Array of scores): 
     - Both actual and expected are arrays of { opportunity_id, score }.
     - Compare the RELATIVE RANKING. 
     - Does the AI score the relevant opportunities high (matching the expected trend) and irrelevant ones low? 
     - Give a high score if the AI correctly identifies the top matches, even if the absolute number differs.
  
  3. ELIGIBILITY SENTIMENT: 
     - The first priority is the boolean sentiment (Eligible vs Not Eligible). 
     - If the AI gets the eligibility status wrong, score it 0-2.
     - If the status is right but reasoning is slightly different, score it 7-10.

  Input:
  ${JSON.stringify(input, null, 2)}
  
  Expected Output Pattern:
  ${JSON.stringify(expected, null, 2)}
  
  Actual Output:
  ${JSON.stringify(output, null, 2)}
  
  CRITICAL: Return ONLY a valid JSON object. No markdown.
  {
    "score": <number 1-10>,
    "reason": "<short 1-sentence explanation of why you gave this score>"
  }
  `.trim();

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.0,
      response_format: { type: "json_object" },
      max_tokens: 500
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Judge API Error (HTTP ${response.status}): ${errText}`);
  }

  const data = await response.json();
  const raw = data.choices[0].message.content;

  // Robust JSON extraction
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("⚠️  Judge returned non-JSON:", raw);
    return { score: 0, reason: "Judge failed to return valid JSON" };
  }

  try {
    const cleaned = jsonMatch[0].replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(cleaned);
  } catch (e) {
    console.warn("⚠️  Judge JSON parse failed:", raw);
    return { score: 0, reason: "Judge JSON parsing error" };
  }
}

module.exports = { judgeOutput };

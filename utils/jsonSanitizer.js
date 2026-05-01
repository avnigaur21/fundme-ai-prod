/**
 * Robust JSON extraction and sanitization for AI-generated strings.
 * Handles markdown blocks, common LLM chatter, and formatting errors.
 */
function extractJSON(text) {
  if (!text) return null;

  try {
    // 1. Precise check for Markdown JSON blocks
    let raw = text.trim();
    if (raw.includes('```json')) {
      raw = raw.split('```json')[1].split('```')[0].trim();
    } else if (raw.includes('```')) {
      raw = raw.split('```')[1].split('```')[0].trim();
    }

    // 2. Fallback: Find first '{' or '[' and last matching '}' or ']'
    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      const firstCurly = raw.indexOf('{');
      const firstSquare = raw.indexOf('[');
      
      let startIdx = -1;
      let endIdx = -1;

      // Determine which starts first
      if (firstCurly !== -1 && (firstSquare === -1 || firstCurly < firstSquare)) {
        startIdx = firstCurly;
        endIdx = raw.lastIndexOf('}');
      } else if (firstSquare !== -1) {
        startIdx = firstSquare;
        endIdx = raw.lastIndexOf(']');
      }

      if (startIdx !== -1 && endIdx !== -1) {
        raw = raw.substring(startIdx, endIdx + 1);
      }
    }

    // 3. Final sanitization (trailing commas etc)
    // Remove trailing commas before closing braces/brackets
    raw = raw.replace(/,\s*([\]}])/g, '$1');
    
    // Attempt parsing
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[jsonSanitizer] Parse failed for text:", text.substring(0, 100) + "...");
    return null;
  }
}

module.exports = { extractJSON };

const pdfParse = require('pdf-parse');

/**
 * Robustly extracts text from a PDF buffer, supporting multiple versions
 * of the pdf-parse library (classic function vs modern object-oriented v2+).
 */
async function extractTextFromPDF(dataBuffer) {
  try {
    if (!dataBuffer) return "";
    
    // Explicitly convert Buffer to Uint8Array (required by pdf-parse v2+)
    const uint8Array = new Uint8Array(dataBuffer.buffer, dataBuffer.byteOffset, dataBuffer.byteLength);

    let result = null;

    // 1. Check for modern object-oriented API (e.g., pdf-parse v2+)
    if (pdfParse.PDFParse) {
      const parser = new pdfParse.PDFParse(uint8Array);
      if (typeof parser.load === 'function') {
        await parser.load();
      }
      result = await parser.getText();
    } 
    // 2. Check for classic function API (e.g., pdf-parse v1)
    else if (typeof pdfParse === 'function') {
      result = await pdfParse(dataBuffer);
    } 
    // 3. Fallback for potential .default export
    else if (pdfParse.default && typeof pdfParse.default === 'function') {
      result = await pdfParse.default(dataBuffer);
    }

    // Defensive parsing of the result
    let finalText = "";
    if (typeof result === 'string') {
      finalText = result;
    } else if (result && typeof result === 'object') {
      // Handle various common return shapes
      finalText = result.text || result.content || result.str || "";
      
      if (Array.isArray(result)) {
        finalText = result.join('\n');
      } else if (Array.isArray(result.items)) {
        finalText = result.items.map(item => item.str || item).join(' ');
      }
    }

    // Bulletproof string conversion
    const stringified = String(finalText || "");
    const cleaned = stringified.trim();
    
    if (cleaned.length === 0) {
      console.warn("⚠️ PDF Extraction result is empty.");
    }
    return cleaned;
  } catch (err) {
    console.error("❌ PDF Parsing Error:", err.message);
    return "";
  }
}

module.exports = { extractTextFromPDF };

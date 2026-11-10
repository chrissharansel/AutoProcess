import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

export async function extractFromText(
  text: string,
  prompt: string,
  outputSchema?: Record<string, any>
): Promise<{ result: any; confidence?: number }> {
  const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const schemaInstruction = outputSchema
    ? `\n\nReturn ONLY a valid JSON object matching this schema:\n${JSON.stringify(outputSchema, null, 2)}`
    : '\n\nReturn ONLY a valid JSON object with the extracted fields.';

  const fullPrompt = `${prompt}

Document text:
"""
${text.slice(0, 30000)}
"""
${schemaInstruction}

Do not include any markdown, explanations or code fences. Just the raw JSON.`;

  try {
    const result = await model.generateContent(fullPrompt);
    const response = result.response;
    let textOut = response.text().trim();

    // Clean possible markdown
    if (textOut.startsWith('```')) {
      textOut = textOut.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(textOut);
    return { result: parsed, confidence: 0.9 };
  } catch (err: any) {
    console.error('Gemini extraction error:', err.message);
    // Fallback mock for demo when no key
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes('YOUR_')) {
      return {
        result: {
          note: 'Demo mode – set GEMINI_API_KEY for real extraction',
          extractedFrom: text.slice(0, 200) + '...',
          fields: { vendor: 'Sample Vendor', amount: 1234.56, date: new Date().toISOString().slice(0, 10) },
        },
        confidence: 0.5,
      };
    }
    throw err;
  }
}

export async function extractFromDocument(
  filePath: string,
  mimeType: string,
  prompt: string,
  outputSchema?: Record<string, any>
) {
  // For MVP we use text extraction. For images/PDFs in production use Gemini multimodal or pdf-parse + OCR.
  const fs = await import('fs/promises');
  let text = '';

  if (mimeType === 'application/pdf' || mimeType.startsWith('text/')) {
    try {
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      text = `[Binary file: ${filePath}] – For full PDF support install pdf-parse and use multimodal Gemini.`;
    }
  } else {
    text = `[Image/Document uploaded: ${filePath}] – Multimodal extraction requires Gemini vision model.`;
  }

  return extractFromText(text, prompt, outputSchema);
}

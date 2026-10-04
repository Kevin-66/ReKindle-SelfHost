// Stand-in for the Cloudflare Workers AI binding (`env.AI.run`) used by the
// handwriting-recognition worker. Sends the image to Gemini, or to any
// OpenAI-compatible vision model if OPENAI_BASE_URL is set.

import { config } from './config.js';
// May point at a model on the local network (OPENAI_BASE_URL), so skip the public-only guard.
import { rawFetch as fetch } from './netguard.js';

function sniffMime(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
    return 'image/png';
}

async function gemini(prompt, b64, mime, input) {
    const model = config.ocrModel || 'gemini-flash-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: b64 } }] }],
            // Generous limit: "thinking" models spend tokens before answering.
            generationConfig: { temperature: input.temperature ?? 0, maxOutputTokens: Math.max(input.max_tokens || 0, 2048) }
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(`Gemini: ${data.error.message}`);
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    return parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
}

async function openaiCompatible(prompt, b64, mime, input) {
    const model = config.ocrModel || 'gpt-4o-mini';
    const res = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
        body: JSON.stringify({
            model,
            temperature: input.temperature ?? 0,
            max_tokens: Math.max(input.max_tokens || 0, 512),
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
                ]
            }]
        })
    });
    const data = await res.json();
    if (data.error) throw new Error(`AI: ${data.error.message || JSON.stringify(data.error)}`);
    return ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
}

export const aiBinding = {
    async run(model, input = {}) {
        if (!input.image) throw new Error(`Only image models are supported on this server (asked for ${model})`);
        const bytes = Uint8Array.from(input.image);
        const b64 = Buffer.from(bytes).toString('base64');
        const mime = sniffMime(bytes);
        const prompt = input.prompt || 'Transcribe the text in this image.';
        let text;
        if (config.openaiBaseUrl && config.openaiApiKey) text = await openaiCompatible(prompt, b64, mime, input);
        else if (config.geminiApiKey) text = await gemini(prompt, b64, mime, input);
        else throw new Error('Handwriting recognition is not set up on this server (set GEMINI_API_KEY).');
        return { response: text };
    }
};

// /api/analyze.js — Vercel Serverless Function
// Backend pra análise de calorias por foto via Gemini.
// A chave fica em variável de ambiente (GEMINI_API_KEY) — NUNCA exposta no front.

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b'
];
const GEMINI_URL_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const RETRY_ROUNDS = 2;
const RETRY_DELAY_MS = 1500;

const PROMPT = `Você é um nutricionista especialista em análise de pratos por imagem. Analise esta foto de comida com precisão.

Estime cada item visível:
1. Identifique o alimento
2. Estime peso/porção em gramas baseado no tamanho aparente do prato (assume prato padrão ~25cm)
3. Calcule calorias e macros baseado em tabelas nutricionais brasileiras (TACO/USDA)

Responda APENAS com JSON válido neste formato:

{
  "dish_name": "Nome resumido do prato em português (max 30 chars)",
  "total_calories": <int>,
  "protein_g": <number>,
  "carbs_g": <number>,
  "fat_g": <number>,
  "items": [
    {
      "name": "<alimento em português>",
      "portion": "<quantidade ex: 150g, 1 unidade média>",
      "weight_g": <number>,
      "calories": <int>,
      "protein_g": <number>,
      "carbs_g": <number>,
      "fat_g": <number>
    }
  ],
  "confidence": "high|medium|low"
}

Se não houver comida na imagem, retorne: {"error": "Não consegui identificar comida nesta imagem. Tire uma foto mais clara."}

Seja realista. Considere métodos de preparo (frito vs grelhado).`;

function looksLikeOverload(text) {
  if (!text) return false;
  const m = String(text).toLowerCase();
  return m.includes('overload') || m.includes('high demand') || m.includes('unavailable') ||
         m.includes('try again later') || m.includes('temporarily') || m.includes('quota') ||
         m.includes('rate limit') || m.includes('exhausted') || m.includes('exceeded') ||
         m.includes('busy');
}

function looksLikeFatalKeyError(text) {
  if (!text) return false;
  const m = String(text).toLowerCase();
  return m.includes('api key not valid') || m.includes('api_key_invalid') ||
         m.includes('permission denied') || m.includes('forbidden') ||
         m.includes('reported as leaked');
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callGemini(model, imageBase64, apiKey, useJsonMode = true) {
  const url = `${GEMINI_URL_BASE}${model}:generateContent?key=${apiKey}`;
  const generationConfig = { temperature: 0.2, maxOutputTokens: 1024 };
  if (useJsonMode) generationConfig.responseMimeType = 'application/json';

  const body = {
    contents: [{
      parts: [
        { text: PROMPT },
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
      ]
    }],
    generationConfig
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    const err = new Error('Erro de conexão com o Gemini');
    err.recoverable = true;
    throw err;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(errText);
      if (j?.error?.message) msg = j.error.message;
    } catch {}

    const err = new Error(msg);
    err.status = res.status;
    if (res.status === 400 && looksLikeFatalKeyError(msg)) { err.fatal = true; throw err; }
    if (res.status === 401 || res.status === 403) { err.fatal = true; throw err; }
    err.recoverable = true;
    throw err;
  }

  const data = await res.json().catch(() => null);
  if (!data) {
    const e = new Error('Resposta inválida'); e.recoverable = true; throw e;
  }
  if (data?.promptFeedback?.blockReason) {
    const e = new Error('Imagem rejeitada por filtros de segurança. Tente outra foto.');
    e.fatal = true; throw e;
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text || !text.trim()) {
    const e = new Error('Resposta vazia do modelo'); e.recoverable = true; throw e;
  }
  if (looksLikeOverload(text) && !text.trim().startsWith('{')) {
    const e = new Error('Modelo sobrecarregado'); e.recoverable = true; throw e;
  }
  const parsed = extractJson(text);
  if (!parsed) {
    const e = new Error('Não consegui interpretar a resposta');
    e.recoverable = true; e.unparsable = true; throw e;
  }
  if (parsed.error) {
    const e = new Error(parsed.error);
    e.recoverable = looksLikeOverload(parsed.error); throw e;
  }
  if (typeof parsed.total_calories !== 'number' && !parsed.dish_name) {
    const e = new Error('Formato de resposta inesperado'); e.recoverable = true; throw e;
  }
  return parsed;
}

export default async function handler(req, res) {
  // CORS básico — mesmo origin não precisa, mas se algum dia chamar de outro domínio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Servidor não configurado: GEMINI_API_KEY ausente'
    });
  }

  // body pode chegar como string ou objeto
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const { image } = body;
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ error: 'Campo "image" (base64) é obrigatório' });
  }

  // limite de tamanho (~3MB base64 ≈ 2.2MB binário)
  if (image.length > 4_500_000) {
    return res.status(413).json({
      error: 'Imagem muito grande. Reduza pra menos de 3MB.'
    });
  }

  let lastError = null;
  for (let round = 0; round < RETRY_ROUNDS; round++) {
    for (const model of GEMINI_MODELS) {
      for (const useJson of [true, false]) {
        try {
          const result = await callGemini(model, image, apiKey, useJson);
          // resposta de sucesso
          return res.status(200).json(result);
        } catch (err) {
          lastError = err;
          if (err.fatal) {
            const status = err.status || 500;
            return res.status(status).json({
              error: err.message,
              fatal: true
            });
          }
          if (err.unparsable && useJson) continue; // tenta sem json mode
          break; // próximo modelo
        }
      }
    }
    if (round < RETRY_ROUNDS - 1) await sleep(RETRY_DELAY_MS);
  }

  const finalMsg = lastError?.message || 'Erro desconhecido';
  if (looksLikeOverload(finalMsg)) {
    return res.status(503).json({
      error: 'Os servidores do Gemini estão sobrecarregados agora. Tenta de novo em 1-2 minutos.'
    });
  }
  return res.status(500).json({ error: finalMsg });
}

// configuração da function — aumenta limite de body pra fotos
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '5mb'
    }
  },
  maxDuration: 60
};

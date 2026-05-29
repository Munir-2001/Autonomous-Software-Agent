// OpenAI-compatible client wrapper for the BEARS LiteLLM proxy.
//
// We're NOT calling openai.com. The `openai` npm package is just a
// JS HTTP client for the OpenAI-style chat-completions API; we point
// `baseURL` at the UNITN BEARS LiteLLM proxy, which routes to
// llama-3.3-70b-lmstudio.
//
// Configuration via env (course-prescribed names):
//   LITELLM_BASE_URL  — endpoint URL
//   LITELLM_API_KEY   — API key (from course staff)
//   LOCAL_MODEL       — model id (default: llama-3.3-70b-lmstudio)

import OpenAI from 'openai';

const BASE_URL = process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1';
const API_KEY  = process.env.LITELLM_API_KEY;
const MODEL    = process.env.LOCAL_MODEL || 'llama-3.3-70b-lmstudio';

if (!API_KEY) {
  console.error('FATAL: LITELLM_API_KEY missing from .env');
  process.exit(1);
}

const client = new OpenAI({ baseURL: BASE_URL, apiKey: API_KEY });

/**
 * Single LLM call. Default temperature 0 for deterministic agent reasoning.
 *
 * @param {Array<{role: string, content: string}>} messages
 * @param {{ temperature?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function callModel(messages, { temperature = 0 } = {}) {
  const response = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature,
  });
  return response.choices?.[0]?.message?.content ?? '';
}

export const LLM_CONFIG = { BASE_URL, MODEL };

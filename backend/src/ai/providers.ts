/**
 * Thin server-side clients for the supported AI providers. Given a provider
 * config + decrypted key and a system/user prompt, return the assistant text.
 * Keys never leave the server.
 */
import type { AiProviderKind } from "../repos/aiRepo.js";

export interface AiCallInput {
  provider: AiProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  system: string;
  user: string;
  maxTokens?: number;
}

export class AiError extends Error {
  constructor(message: string, readonly status = 502) { super(message); this.name = "AiError"; }
}

export async function callAi(input: AiCallInput): Promise<string> {
  switch (input.provider) {
    case "anthropic": return callAnthropic(input);
    case "openai":
    case "azure":
    case "custom": return callOpenAiCompatible(input);
    case "google": return callGoogle(input);
    default: throw new AiError(`unsupported provider: ${input.provider}`, 400);
  }
}

async function callAnthropic(i: AiCallInput): Promise<string> {
  const base = (i.baseUrl?.replace(/\/$/, "")) || "https://api.anthropic.com";
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": i.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: i.model,
      max_tokens: i.maxTokens ?? 1024,
      system: i.system,
      messages: [{ role: "user", content: i.user }],
    }),
  });
  if (!res.ok) throw new AiError(`Anthropic error ${res.status}: ${(await res.text()).slice(0, 300)}`, 502);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
}

async function callOpenAiCompatible(i: AiCallInput): Promise<string> {
  const base = (i.baseUrl?.replace(/\/$/, "")) || "https://api.openai.com/v1";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${i.apiKey}` },
    body: JSON.stringify({
      model: i.model,
      max_tokens: i.maxTokens ?? 1024,
      messages: [
        { role: "system", content: i.system },
        { role: "user", content: i.user },
      ],
    }),
  });
  if (!res.ok) throw new AiError(`Provider error ${res.status}: ${(await res.text()).slice(0, 300)}`, 502);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function callGoogle(i: AiCallInput): Promise<string> {
  const base = (i.baseUrl?.replace(/\/$/, "")) || "https://generativelanguage.googleapis.com/v1beta";
  const res = await fetch(`${base}/models/${encodeURIComponent(i.model)}:generateContent?key=${encodeURIComponent(i.apiKey)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: i.system }] },
      contents: [{ role: "user", parts: [{ text: i.user }] }],
    }),
  });
  if (!res.ok) throw new AiError(`Google error ${res.status}: ${(await res.text()).slice(0, 300)}`, 502);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
}

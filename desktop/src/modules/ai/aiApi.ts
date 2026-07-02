/** AI provider management + AI chat proxy. Keys are write-only (never returned). */
import { request } from "@/shared/lib/api";

export type AiProviderKind = "anthropic" | "openai" | "google" | "azure" | "custom";

export interface AiProvider {
  id: string;
  scope: "org" | "user";
  provider: AiProviderKind;
  label: string;
  model: string;
  base_url: string | null;
  is_default: boolean;
  is_active: boolean;
  has_key: boolean;
}

export interface CreateProviderInput {
  scope: "org" | "user";
  provider: AiProviderKind;
  label: string;
  model: string;
  api_key: string;
  base_url?: string | null;
  is_default?: boolean;
}

export const aiApi = {
  list() {
    return request<{ org: AiProvider[]; personal: AiProvider[]; can_manage: boolean; can_personal: boolean }>("/api/v1/ai/providers");
  },
  available() {
    return request<{ providers: AiProvider[] }>("/api/v1/ai/available").then((r) => r.providers);
  },
  create(input: CreateProviderInput) {
    return request<{ provider: AiProvider }>("/api/v1/ai/providers", { method: "POST", body: input }).then((r) => r.provider);
  },
  update(id: string, patch: Partial<{ label: string; model: string; api_key: string; base_url: string | null; is_active: boolean; is_default: boolean }>) {
    return request<{ provider: AiProvider }>(`/api/v1/ai/providers/${id}`, { method: "PUT", body: patch }).then((r) => r.provider);
  },
  remove(id: string) {
    return request<void>(`/api/v1/ai/providers/${id}`, { method: "DELETE" });
  },
  chat(body: { provider_id: string; mode: "suggest" | "explain" | "error" | "chat"; input: string; os?: string }) {
    return request<{ text: string }>("/api/v1/ai/chat", { method: "POST", body }).then((r) => r.text);
  },
};

/** Suggested models per provider, for the config form's convenience. */
export const MODEL_HINTS: Record<AiProviderKind, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o",
  google: "gemini-1.5-pro",
  azure: "gpt-4o",
  custom: "",
};

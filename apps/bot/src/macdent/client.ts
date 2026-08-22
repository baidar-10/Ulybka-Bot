import { env } from "../config/env.js";

export interface MacdentClient {
  enabled: boolean;
  call<T = unknown>(
    method: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T>;
}

export class MacdentError extends Error {
  constructor(
    message: string,
    readonly method?: string,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "MacdentError";
  }
}

function disabledClient(): MacdentClient {
  return {
    enabled: false,
    async call() {
      throw new MacdentError("MacDent API is not configured (MACDENT_API_KEY)");
    },
  };
}

function okPayload(obj: Record<string, unknown>): unknown {
  const skip = new Set([
    "response",
    "reponse",
    "error",
    "errorDescription",
    "isTokenNeedToBeUpdated",
  ]);
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!skip.has(key)) rest[key] = value;
  }
  const arrays = Object.values(rest).filter(Array.isArray);
  if (arrays.length === 1) return arrays[0];
  if (Array.isArray(rest.data)) return rest.data;
  return Object.keys(rest).length ? rest : [];
}

function unwrap(json: unknown, method: string): unknown {
  if (!json || typeof json !== "object") return json;
  const obj = json as Record<string, unknown>;
  const code = obj.response ?? obj.reponse;
  if (code === 0) {
    throw new MacdentError(
      String(obj.error || obj.errorDescription || "MacDent response=0"),
      method,
      json
    );
  }
  if (code === 1) return okPayload(obj);
  if (code !== undefined && code !== 0) return code;
  return json;
}

function toMethodPath(method: string): string {
  const name = method.replace(/^\/+/, "");
  if (name.includes("/")) return name;
  const dot = name.indexOf(".");
  if (dot > 0) return `${name.slice(0, dot)}/${name.slice(dot + 1)}`;
  return name;
}

function enabledClient(baseUrl: string, apiKey: string): MacdentClient {
  const root = baseUrl.replace(/\/+$/, "");

  return {
    enabled: true,
    async call<T = unknown>(
      method: string,
      params: Record<string, string | number | undefined> = {}
    ) {
      const name = method.replace(/^\/+/, "");
      const primary = toMethodPath(name);
      const dotted = name.includes(".") ? name : primary.replace("/", ".");
      const paths = primary === dotted ? [primary] : [primary, dotted];

      let lastError: unknown;
      for (const path of paths) {
        const url = new URL(`${root}/${path}`);
        url.searchParams.set("access_token", apiKey);
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === "") continue;
          url.searchParams.set(key, String(value));
        }

        console.log(`MacDent request ${path}`, { ...params });

        const res = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        const text = await res.text();
        let json: unknown = text;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* raw */
        }
        const preview =
          typeof json === "string"
            ? json.slice(0, 500)
            : JSON.stringify(json)?.slice(0, 4000);
        console.log(`MacDent response ${path} HTTP ${res.status}`, preview);
        if (!res.ok) {
          lastError = new MacdentError(`MacDent HTTP ${res.status}`, name, json);
          continue;
        }
        try {
          return unwrap(json, name) as T;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (/групп|метод не найден/i.test(msg) && path !== dotted) continue;
          throw err;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new MacdentError("MacDent request failed", name);
    },
  };
}

export function createMacdentClient(): MacdentClient {
  if (!env.MACDENT_API_KEY) {
    console.log("MacDent: disabled (MACDENT_API_KEY is empty)");
    return disabledClient();
  }
  console.log(`MacDent: configured (${env.MACDENT_API_URL})`);
  return enabledClient(env.MACDENT_API_URL, env.MACDENT_API_KEY);
}

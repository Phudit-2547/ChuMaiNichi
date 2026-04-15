import OpenAI from "openai";

export function createClient(): OpenAI {
  if (process.env.GEMINI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.GEMINI_API_KEY,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
    });
  }
  throw new Error("Set OPENAI_API_KEY or GEMINI_API_KEY");
}

export function defaultModel(): string {
  if (process.env.AI_MODEL) return process.env.AI_MODEL;
  if (process.env.GEMINI_API_KEY) return "gemini-2.5-flash";
  return "gpt-4o-mini";
}

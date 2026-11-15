/**
 * OpenRouter Free Models Catalog (14 models as of 2026-11-15)
 * Ratings based on public benchmarks & community feedback
 * Higher rating = better quality priority
 */
export const FREE_MODELS = [
  // Tier 1: Highest quality
  { id: "meta-llama/llama-3.3-70b-instruct:free", rating: 95, context: 128000, provider: "meta" },
  { id: "meta-llama/llama-3.1-70b-instruct:free", rating: 93, context: 128000, provider: "meta" },
  { id: "qwen/qwen-2.5-72b-instruct:free", rating: 92, context: 128000, provider: "qwen" },
  
  // Tier 2: Strong mid-range
  { id: "mistralai/mistral-large:free", rating: 88, context: 128000, provider: "mistral" },
  { id: "qwen/qwen-2.5-32b-instruct:free", rating: 87, context: 128000, provider: "qwen" },
  { id: "google/gemini-flash-1.5:free", rating: 86, context: 1000000, provider: "google" },
  { id: "meta-llama/llama-3.1-8b-instruct:free", rating: 82, context: 128000, provider: "meta" },
  
  // Tier 3: Good smaller models
  { id: "qwen/qwen-2.5-14b-instruct:free", rating: 80, context: 128000, provider: "qwen" },
  { id: "mistralai/mistral-nemo:free", rating: 78, context: 128000, provider: "mistral" },
  { id: "google/gemma-2-9b-it:free", rating: 75, context: 8192, provider: "google" },
  { id: "microsoft/phi-3.5-mini-instruct:free", rating: 73, context: 128000, provider: "microsoft" },
  
  // Tier 4: Fast/lightweight
  { id: "qwen/qwen-2.5-7b-instruct:free", rating: 70, context: 128000, provider: "qwen" },
  { id: "meta-llama/llama-3.2-3b-instruct:free", rating: 65, context: 128000, provider: "meta" },
  { id: "google/gemma-2-2b-it:free", rating: 60, context: 8192, provider: "google" },
] as const;

export type FreeModel = typeof FREE_MODELS[number];

export function getModelsByRating(): FreeModel[] {
  return [...FREE_MODELS].sort((a, b) => b.rating - a.rating);
}

export function getModelById(id: string): FreeModel | undefined {
  return FREE_MODELS.find(m => m.id === id);
}

export function getAllModelIds(): string[] {
  return FREE_MODELS.map(m => m.id);
}

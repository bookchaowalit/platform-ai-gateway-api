// SPEC-003 media generation registry and router. Red stub: real code lands with the green commit.
export const MEDIA_GENERATION_REGISTRY_SCHEMA = 'solo-empire.media-generation-routing.v1' as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MediaGenerationRegistry = any;
export interface MediaRouteContext {
  now: Date;
  hasCredential: (envName: string) => boolean;
  subjectAllowsModel: (modelId: string) => boolean;
  budgetAllows: (usd: number) => boolean;
}
export function validateMediaGenerationRegistry(_registry: unknown): { problems: string[] } {
  return { problems: [] };
}
export function routeMediaGeneration(_registry: unknown, _request: unknown, _ctx: MediaRouteContext): {
  selected: Array<{ model_id: string; reserved_usd: number; units: number }>;
  fallbacks: Array<{ model_id: string }>;
  skipped: Array<{ model_id: string; reason: string }>;
} {
  return { selected: [], fallbacks: [], skipped: [] };
}

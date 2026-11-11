/**
 * Media generation registry and router (SPEC-003 §3.4, §4.3; AC-04, AC-05).
 *
 * The registry (platform/media-generation-routing.json) holds providers, models,
 * capabilities, normalised parameter maps, prices and our own eval scores. The
 * router turns a normalised request into a ranked list of model attempts. Which
 * model is "best" is data: change the JSON, not this file.
 *
 * Pure functions only. Credential presence, subject allow-lists and budget are
 * passed in as callbacks so this module never reads env values or the store.
 */

export const MEDIA_GENERATION_REGISTRY_SCHEMA = 'solo-empire.media-generation-routing.v1' as const;

export type MediaKind = 'image' | 'video';
export type MediaMode = 'single' | 'compare';
export type MediaPrivacyClass = 'public' | 'internal' | 'private' | 'restricted';
export type SkipReason =
  | 'capability'
  | 'privacy'
  | 'no_credential'
  | 'disabled'
  | 'no_price'
  | 'subject_not_allowed'
  | 'budget';

/** Adapters the worker ships. `returns_urls` adapters must list the hosts their outputs come from. */
export const KNOWN_MEDIA_ADAPTERS: Record<string, { returns_urls: boolean }> = {
  'openai-images': { returns_urls: false },
  // Test adapters, used only by fixtures.
  'fake-sync': { returns_urls: false },
  'fake-url': { returns_urls: true },
};

export interface MediaProviderEntry {
  adapter: string;
  credential_env: string;
  max_concurrent: number;
  max_in_flight: number;
  rpm: number;
  webhook: boolean;
  output_hosts: string[];
  privacy_classes: MediaPrivacyClass[];
  terms_checked_at: string;
}

export interface MediaOwnEval {
  evaluated_at: string;
  votes: number;
  win_rate: number;
  mean_score: number;
  judge_score?: number;
  p50_latency_ms?: number;
  cost_per_accepted_usd?: number;
}

export interface MediaExtraParam {
  type: 'integer' | 'number' | 'boolean' | 'string';
  min?: number;
  max?: number;
  values?: string[];
}

export interface MediaModelEntry {
  provider: string;
  provider_model: string;
  kind: MediaKind;
  enabled: boolean;
  capabilities: {
    aspects: string[];
    resolutions: string[];
    seconds?: number[];
    audio?: boolean;
    references: number;
    text_in_image?: 'good' | 'fair' | 'poor';
    max_n?: number;
  };
  param_map: {
    aspect: Record<string, Record<string, unknown>>;
    resolution: Record<string, Record<string, unknown>>;
  };
  extra_params: Record<string, MediaExtraParam>;
  pricing: {
    unit: 'image' | 'second';
    cost_source: 'registry' | 'provider';
    cancel_policy: 'free' | 'charged';
    /** Key `<aspect>|<resolution>`; video prices are per second. */
    usd: Record<string, number>;
    source: string;
    checked_at: string;
  };
  /** Keyed by profile id. Written only by the weekly report PR (P3). */
  own_eval: Record<string, MediaOwnEval> | null;
}

export interface MediaProfileEntry {
  kind: MediaKind;
  defaults: { aspect?: string; resolution?: string; seconds?: number };
  requires?: { text_in_image?: 'good' | 'fair' | 'poor' };
  models: string[];
}

export interface MediaGenerationRegistry {
  schema_version: typeof MEDIA_GENERATION_REGISTRY_SCHEMA;
  updated_at: string;
  policy: {
    max_evaluation_age_days: number;
    external_privacy_classes: MediaPrivacyClass[];
    fallback_depth: number;
    lease_wait_max_ms: number;
    job_timeout_ms: number;
  };
  providers: Record<string, MediaProviderEntry>;
  models: Record<string, MediaModelEntry>;
  profiles: Record<string, MediaProfileEntry>;
}

export interface MediaRouteRequest {
  kind: MediaKind;
  mode: MediaMode;
  profile?: string;
  models?: string[];
  n_models?: number;
  aspect: string;
  resolution?: string;
  n?: number;
  seconds?: number;
  privacy_class: MediaPrivacyClass;
}

export interface MediaRouteContext {
  now: Date;
  /** True when the named credential variable is set (the value is never read here). */
  hasCredential: (envName: string) => boolean;
  subjectAllowsModel: (modelId: string) => boolean;
  /** True when this extra amount still fits every budget cap for the caller. */
  budgetAllows: (usd: number) => boolean;
}

export interface MediaRoutePick {
  model_id: string;
  provider_id: string;
  provider_model: string;
  unit: 'image' | 'second';
  unit_price_usd: number;
  units: number;
  reserved_usd: number;
  mapped_params: Record<string, unknown>;
}

export interface MediaRouteResult {
  selected: MediaRoutePick[];
  fallbacks: MediaRoutePick[];
  skipped: Array<{ model_id: string; reason: SkipReason }>;
  selected_by: 'own_eval' | 'candidate_order';
}

const RANK = { poor: 0, fair: 1, good: 2 } as const;
const DAY_MS = 86_400_000;

function priceKey(aspect: string, resolution: string): string {
  return `${aspect}|${resolution}`;
}

function money(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

const EXTRA_PARAM_TYPES = new Set(['integer', 'number', 'boolean', 'string']);
const TEXT_RANKS = new Set(['good', 'fair', 'poor']);

function checkProvider(id: string, provider: unknown, problems: string[]): void {
  if (!isObject(provider)) {
    problems.push(`provider ${id}: is not an object`);
    return;
  }
  const adapter = typeof provider.adapter === 'string' ? KNOWN_MEDIA_ADAPTERS[provider.adapter] : undefined;
  if (!adapter) problems.push(`provider ${id}: adapter is unknown`);
  if (!isStringArray(provider.output_hosts)) problems.push(`provider ${id}: output_hosts is not a list of hosts`);
  else if (adapter?.returns_urls && provider.output_hosts.length === 0) problems.push(`provider ${id}: output_hosts is empty for an adapter that returns URLs`);
  if (typeof provider.credential_env !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(provider.credential_env)) problems.push(`provider ${id}: credential_env is not a variable name`);
  for (const field of ['max_concurrent', 'max_in_flight', 'rpm'] as const) {
    if (!Number.isInteger(provider[field]) || (provider[field] as number) < 1) problems.push(`provider ${id}: ${field} must be a positive integer`);
  }
  if (typeof provider.webhook !== 'boolean') problems.push(`provider ${id}: webhook must be a boolean`);
  if (!isStringArray(provider.privacy_classes)) problems.push(`provider ${id}: privacy_classes is missing`);
  if (!isDate(provider.terms_checked_at)) problems.push(`provider ${id}: terms_checked_at is missing`);
}

function checkModel(id: string, model: unknown, providers: Record<string, unknown>, problems: string[]): void {
  if (!isObject(model)) {
    problems.push(`model ${id}: is not an object`);
    return;
  }
  if (typeof model.provider !== 'string' || !providers[model.provider]) problems.push(`model ${id}: provider is unknown`);
  if (typeof model.provider_model !== 'string' || model.provider_model === '') problems.push(`model ${id}: provider_model is missing`);
  if (model.kind !== 'image' && model.kind !== 'video') problems.push(`model ${id}: kind is invalid`);
  if (typeof model.enabled !== 'boolean') problems.push(`model ${id}: enabled must be a boolean`);
  // Setup-day guard: an enabled model must name a real provider model.
  if (model.enabled === true && (model.provider_model === 'set-on-setup-day' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(String(model.provider_model)))) {
    problems.push(`model ${id}: provider_model is not set for an enabled model`);
  }

  const caps = model.capabilities;
  if (!isObject(caps) || !isStringArray(caps.aspects) || !isStringArray(caps.resolutions)
    || (caps.seconds !== undefined && !isNumberArray(caps.seconds)) || typeof caps.references !== 'number'
    || (caps.max_n !== undefined && !Number.isInteger(caps.max_n))
    || (caps.audio !== undefined && typeof caps.audio !== 'boolean')
    || (caps.text_in_image !== undefined && !TEXT_RANKS.has(caps.text_in_image as string))) {
    problems.push(`model ${id}: capabilities is malformed`);
    return;
  }
  if (model.kind === 'video' && (!isNumberArray(caps.seconds) || caps.seconds.length === 0)) problems.push(`model ${id}: capabilities.seconds is missing for video`);

  const map = model.param_map;
  if (!isObject(map) || !isObject(map.aspect) || !isObject(map.resolution)) {
    problems.push(`model ${id}: param_map is malformed`);
  } else {
    for (const [group, keys] of [['aspect', caps.aspects], ['resolution', caps.resolutions]] as const) {
      const table = map[group] as Record<string, unknown>;
      for (const key of keys) {
        if (!(key in table)) problems.push(`model ${id}: param_map.${group} is missing ${key}`);
        else if (!isObject(table[key])) problems.push(`model ${id}: param_map.${group} entry ${key} is not an object`);
      }
    }
  }

  if (!isObject(model.extra_params)) {
    problems.push(`model ${id}: extra_params is not an object`);
  } else {
    for (const [name, spec] of Object.entries(model.extra_params)) {
      if (!isObject(spec) || !EXTRA_PARAM_TYPES.has(spec.type as string)
        || (spec.min !== undefined && typeof spec.min !== 'number') || (spec.max !== undefined && typeof spec.max !== 'number')
        || (spec.values !== undefined && !isStringArray(spec.values))) {
        problems.push(`model ${id}: extra_params ${name} is malformed`);
      }
    }
  }

  if (model.own_eval !== null) {
    const evals = model.own_eval;
    const ok = isObject(evals) && Object.values(evals).every((entry) => isObject(entry) && isDate(entry.evaluated_at)
      && typeof entry.votes === 'number' && typeof entry.win_rate === 'number' && typeof entry.mean_score === 'number');
    if (!ok) problems.push(`model ${id}: own_eval is malformed`);
  }

  const pricing = model.pricing;
  if (!isObject(pricing) || (pricing.unit !== 'image' && pricing.unit !== 'second')) {
    problems.push(`model ${id}: pricing.unit is invalid`);
    return;
  }
  if (pricing.unit !== (model.kind === 'image' ? 'image' : 'second')) problems.push(`model ${id}: pricing.unit does not match kind`);
  if (pricing.cost_source !== 'registry' && pricing.cost_source !== 'provider') problems.push(`model ${id}: pricing.cost_source is invalid`);
  if (pricing.cancel_policy !== 'free' && pricing.cancel_policy !== 'charged') problems.push(`model ${id}: pricing.cancel_policy is invalid`);
  if (!isObject(pricing.usd)) {
    problems.push(`model ${id}: pricing.usd is not an object`);
    return;
  }
  const prices = Object.entries(pricing.usd);
  if (model.enabled === true && prices.length === 0) problems.push(`model ${id}: enabled model has no prices`);
  for (const [key, usd] of prices) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) problems.push(`model ${id}: price ${key} is negative or not a number`);
  }
  if (prices.length > 0) {
    if (typeof pricing.source !== 'string' || !/^https:\/\//.test(pricing.source)) problems.push(`model ${id}: pricing.source is missing`);
    if (!isDate(pricing.checked_at)) problems.push(`model ${id}: pricing.checked_at is missing`);
  }
}

function checkProfile(id: string, profile: unknown, models: Record<string, unknown>, problems: string[]): void {
  if (!isObject(profile)) {
    problems.push(`profile ${id}: is not an object`);
    return;
  }
  if (profile.kind !== 'image' && profile.kind !== 'video') problems.push(`profile ${id}: kind is invalid`);
  const defaults = profile.defaults;
  if (!isObject(defaults)
    || (defaults.aspect !== undefined && typeof defaults.aspect !== 'string')
    || (defaults.resolution !== undefined && typeof defaults.resolution !== 'string')
    || (defaults.seconds !== undefined && (typeof defaults.seconds !== 'number' || !Number.isFinite(defaults.seconds)))) {
    problems.push(`profile ${id}: defaults is malformed`);
  }
  if (profile.requires !== undefined && (!isObject(profile.requires)
    || (profile.requires.text_in_image !== undefined && !TEXT_RANKS.has(profile.requires.text_in_image as string)))) {
    problems.push(`profile ${id}: requires is malformed`);
  }
  if (!isStringArray(profile.models)) {
    problems.push(`profile ${id}: models is not a list of model ids`);
    return;
  }
  for (const modelId of profile.models) {
    const model = models[modelId];
    if (!isObject(model)) problems.push(`profile ${id}: model ${modelId} is unknown`);
    else if (model.kind !== profile.kind) problems.push(`profile ${id}: kind does not match model ${modelId}`);
  }
}

/**
 * AC-05: full shape check of untrusted registry JSON. Every problem names the entry, never a
 * value. An empty list means the registry may be used; the router assumes a registry that passed.
 */
export function validateMediaGenerationRegistry(registry: MediaGenerationRegistry): { problems: string[] } {
  const problems: string[] = [];
  const root = registry as unknown;
  if (!isObject(root)) return { problems: ['registry is not an object'] };
  if (root.schema_version !== MEDIA_GENERATION_REGISTRY_SCHEMA) problems.push('schema_version is not supported');
  const policy = root.policy;
  if (!isObject(policy) || !((policy.max_evaluation_age_days as number) > 0) || !Number.isInteger(policy.fallback_depth)
    || (policy.fallback_depth as number) < 0 || !((policy.lease_wait_max_ms as number) > 0) || !((policy.job_timeout_ms as number) > 0)
    || !isStringArray(policy.external_privacy_classes)) {
    problems.push('policy is incomplete');
  }
  for (const section of ['providers', 'models', 'profiles'] as const) {
    if (!isObject(root[section])) problems.push(`${section} is not an object`);
  }
  const providers = isObject(root.providers) ? root.providers : {};
  const models = isObject(root.models) ? root.models : {};
  const profiles = isObject(root.profiles) ? root.profiles : {};
  for (const [id, provider] of Object.entries(providers)) checkProvider(id, provider, problems);
  for (const [id, model] of Object.entries(models)) checkModel(id, model, providers, problems);
  for (const [id, profile] of Object.entries(profiles)) checkProfile(id, profile, models, problems);
  return { problems };
}

function capabilityFits(model: MediaModelEntry, request: MediaRouteRequest, resolution: string, profile?: MediaProfileEntry): boolean {
  const caps = model.capabilities;
  if (model.kind !== request.kind) return false;
  if (!caps.aspects.includes(request.aspect) || !caps.resolutions.includes(resolution)) return false;
  if (request.kind === 'image' && (request.n ?? 1) > (caps.max_n ?? 1)) return false;
  if (request.kind === 'video' && !(caps.seconds ?? []).includes(request.seconds ?? -1)) return false;
  const needText = profile?.requires?.text_in_image;
  if (needText && RANK[caps.text_in_image ?? 'poor'] < RANK[needText]) return false;
  return true;
}

function freshScore(model: MediaModelEntry, profileId: string | undefined, now: Date, maxAgeDays: number): number | undefined {
  if (!profileId || !model.own_eval) return undefined;
  const entry = model.own_eval[profileId];
  if (!entry || !isDate(entry.evaluated_at)) return undefined;
  if (now.getTime() - Date.parse(entry.evaluated_at) > maxAgeDays * DAY_MS) return undefined;
  return entry.mean_score;
}

/**
 * AC-04: candidates → filter (capability, privacy, credential, enabled, price, subject, budget) →
 * order (fresh own_eval, else candidate order) → pick (single: first + fallback_depth; compare:
 * distinct providers first). The caller has already validated the request shape (AC-03).
 */
export function routeMediaGeneration(
  registry: MediaGenerationRegistry,
  request: MediaRouteRequest,
  ctx: MediaRouteContext,
): MediaRouteResult {
  const profile = request.profile ? registry.profiles[request.profile] : undefined;
  const resolution = request.resolution ?? profile?.defaults.resolution ?? 'standard';
  const candidates = request.models ?? profile?.models ?? [];
  const seconds = request.seconds ?? profile?.defaults.seconds;
  const units = request.kind === 'image' ? (request.n ?? 1) : (seconds ?? 0);
  const skipped: MediaRouteResult['skipped'] = [];
  const eligible: Array<{ pick: MediaRoutePick; order: number; score?: number }> = [];

  candidates.forEach((modelId, order) => {
    const model = registry.models[modelId];
    const provider = model ? registry.providers[model.provider] : undefined;
    if (!model || !provider) {
      skipped.push({ model_id: modelId, reason: 'disabled' });
      return;
    }
    const skip = (reason: SkipReason) => skipped.push({ model_id: modelId, reason });
    if (!capabilityFits(model, { ...request, seconds }, resolution, profile)) return skip('capability');
    if (!registry.policy.external_privacy_classes.includes(request.privacy_class)
      || !provider.privacy_classes.includes(request.privacy_class)) return skip('privacy');
    if (!ctx.hasCredential(provider.credential_env)) return skip('no_credential');
    if (!model.enabled) return skip('disabled');
    const unitPrice = model.pricing.usd[priceKey(request.aspect, resolution)];
    if (typeof unitPrice !== 'number') return skip('no_price');
    if (!ctx.subjectAllowsModel(modelId)) return skip('subject_not_allowed');
    const factor = model.pricing.cost_source === 'provider' ? 2 : 1;
    const reserved = money(unitPrice * units * factor);
    if (!ctx.budgetAllows(reserved)) return skip('budget');
    eligible.push({
      order,
      score: request.models ? undefined : freshScore(model, request.profile, ctx.now, registry.policy.max_evaluation_age_days),
      pick: {
        model_id: modelId,
        provider_id: model.provider,
        provider_model: model.provider_model,
        unit: model.pricing.unit,
        unit_price_usd: unitPrice,
        units,
        reserved_usd: reserved,
        mapped_params: { ...model.param_map.aspect[request.aspect], ...model.param_map.resolution[resolution] },
      },
    });
  });

  const scored = eligible.some((e) => e.score !== undefined);
  eligible.sort((a, b) => {
    if (scored) {
      const diff = (b.score ?? -Infinity) - (a.score ?? -Infinity);
      if (diff !== 0) return diff;
    }
    return a.order - b.order;
  });
  const ranked = eligible.map((e) => e.pick);

  if (request.mode === 'compare') {
    const want = request.n_models ?? request.models?.length ?? 2;
    const selected: MediaRoutePick[] = [];
    const providersUsed = new Set<string>();
    for (const pick of ranked) {
      if (selected.length < want && !providersUsed.has(pick.provider_id)) {
        selected.push(pick);
        providersUsed.add(pick.provider_id);
      }
    }
    for (const pick of ranked) {
      if (selected.length < want && !selected.includes(pick)) selected.push(pick);
    }
    selected.sort((a, b) => ranked.indexOf(a) - ranked.indexOf(b));
    return { selected, fallbacks: [], skipped, selected_by: scored ? 'own_eval' : 'candidate_order' };
  }

  return {
    selected: ranked.slice(0, 1),
    fallbacks: ranked.slice(1, 1 + registry.policy.fallback_depth),
    skipped,
    selected_by: scored ? 'own_eval' : 'candidate_order',
  };
}

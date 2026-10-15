import { randomUUID } from 'crypto';
import { AiBudgetError, type AiBudgetGuard } from './ai_budget.js';
import type { AiAttemptAdmission, AiAttemptReservation } from './ai_shared_admission.js';

export const AI_GATEWAY_CONTRACT = 'solo-empire.ai-gateway.v1';
export const AI_TELEMETRY_CONTRACT = 'solo-empire.ai-telemetry.v1';
export const AI_RESPONSE_LANGUAGE = 'th' as const;
export const AI_RESPONSE_LANGUAGE_POLICY_VERSION = 'solo-empire.ai-response-language.th-v1';
export const AI_RESPONSE_LANGUAGE_SYSTEM_MESSAGE = [
  'ภาษาหลักของคำตอบ: ภาษาไทย',
  'ตอบผู้ใช้เป็นภาษาไทยสำหรับคำอธิบาย สรุป สถานะ คำถาม แผนงาน คำเตือน และ handoff',
  'คง code, commands, file paths, identifiers, logs, protocol fields และข้อความที่อ้างคำพูดไว้ตามต้นฉบับเมื่อการแปลทำให้ความถูกต้องลดลง',
  'ใช้ภาษาอื่นเฉพาะเมื่อผู้ใช้ขอภาษาอื่นอย่างชัดเจนสำหรับคำตอบหรือ artifact นั้น',
].join('\n');

export type AiProfile = 'fast' | 'balanced' | 'quality';
export type AiPrivacyClass = 'public' | 'internal' | 'private' | 'restricted';
export type AiMessageRole = 'system' | 'user' | 'assistant';
export type AiResponseFormat = 'text' | 'json_object';
export type AiTokenParam = 'max_tokens' | 'max_completion_tokens';
export type AiErrorCostPolicy = 'unknown' | 'bounded';

export interface AiMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiGenerateRequest {
  route: string;
  /** Optional per-request reasoning effort; overrides AI_GATEWAY_REASONING_EFFORT for this call only. */
  reasoning_effort?: string;
  prompt_version: string;
  messages: AiMessage[];
  profile?: AiProfile;
  privacy_class?: AiPrivacyClass;
  token_budget?: number;
  max_output_tokens?: number;
  temperature?: number;
  response_format?: { type: AiResponseFormat };
}

export interface AiUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  source: 'provider' | 'estimated' | 'unavailable';
}

export interface AiTelemetryEvent {
  run_id: string;
  route: string;
  prompt_version: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  token_budget: number;
  latency_ms: number;
  estimated_cost_usd: number | null;
  cache_hit: boolean;
  status: 'success' | 'error' | 'budget_exceeded';
  metadata: Record<string, string | number | boolean | null>;
}

export interface AiGenerateResponse {
  contract: typeof AI_GATEWAY_CONTRACT;
  run_id: string;
  status: 'success' | 'budget_exceeded';
  route: string;
  prompt_version: string;
  provider: string;
  model: string;
  fallback_used: boolean;
  content: string;
  output_trust: 'untrusted_model_output';
  finish_reason: string | null;
  usage: AiUsage;
  token_budget: number;
  latency_ms: number;
  estimated_cost_usd: number | null;
}

export interface AiGatewayStatus {
  contract: typeof AI_GATEWAY_CONTRACT;
  response_language: typeof AI_RESPONSE_LANGUAGE;
  configured: boolean;
  provider: string | null;
  adapter: 'openai-compatible' | 'none';
  base_url_configured: boolean;
  api_key_configured: boolean;
  rate_cards_configured: boolean;
  models: Record<AiProfile, string | null>;
  fallback_models: Record<AiProfile, string | null>;
  request_options: {
    token_param: AiTokenParam | null;
    send_temperature: boolean | null;
    reasoning_effort: string | null;
    request_reasoning_efforts: string[];
    error_cost_policy: AiErrorCostPolicy | null;
    response_formats: AiResponseFormat[];
  };
  limits: {
    max_context_chars: number;
    max_output_tokens: number;
    default_token_budget: number;
    max_token_budget: number;
    timeout_ms: number;
    reasoning_timeout_ms: number;
  };
  reason?: string;
}

export interface AiGenerateOptions {
  budgetGuard?: AiBudgetGuard;
  attemptAdmission?: AiAttemptAdmission;
  recordTelemetry?: (event: AiTelemetryEvent) => void;
}

export class AiGatewayError extends Error {
  readonly status: number;
  readonly telemetry?: AiTelemetryEvent;

  constructor(status: number, message: string, telemetry?: AiTelemetryEvent) {
    super(message);
    this.name = 'AiGatewayError';
    this.status = status;
    this.telemetry = telemetry;
  }
}

interface GatewayConfig {
  provider: 'openai-compatible';
  providerName: string;
  baseUrl: URL;
  apiKey: string;
  models: Record<AiProfile, string>;
  maxContextChars: number;
  maxOutputTokens: number;
  defaultTokenBudget: number;
  maxTokenBudget: number;
  timeoutMs: number;
  reasoningTimeoutMs: number;
  inputRatePer1k: number | null;
  outputRatePer1k: number | null;
  fallbackModels: Record<AiProfile, string | null>;
  fallbackInputRatePer1k: number | null;
  fallbackOutputRatePer1k: number | null;
  tokenParam: AiTokenParam;
  sendTemperature: boolean;
  reasoningEffort: string | null;
  errorCostPolicy: AiErrorCostPolicy;
}

interface RequestOptions {
  tokenParam: AiTokenParam;
  sendTemperature: boolean;
  reasoningEffort: string | null;
  errorCostPolicy: AiErrorCostPolicy;
}

const REQUEST_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const PROFILE_DEFAULT_OUTPUT: Record<AiProfile, number> = {
  fast: 512,
  balanced: 1024,
  quality: 2048,
};

const PRIVACY_CLASSES = new Set<AiPrivacyClass>(['public', 'internal', 'private', 'restricted']);
const PROFILES = new Set<AiProfile>(['fast', 'balanced', 'quality']);
const RESPONSE_FORMATS = new Set<AiResponseFormat>(['text', 'json_object']);

function withDefaultResponseLanguage(messages: AiMessage[]): AiMessage[] {
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex >= 0) {
    return messages.map((message, index) => index === systemIndex
      ? { ...message, content: `${message.content}\n\n${AI_RESPONSE_LANGUAGE_SYSTEM_MESSAGE}` }
      : message);
  }
  return [{ role: 'system', content: AI_RESPONSE_LANGUAGE_SYSTEM_MESSAGE }, ...messages];
}

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function nonNegativeRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function safeName(value: string | undefined, fallback: string): string {
  const candidate = (value || fallback).trim();
  return /^[A-Za-z0-9_.:/-]{1,100}$/.test(candidate) ? candidate : fallback;
}

function modelName(value: string | undefined, fallback: string): string {
  const candidate = value === undefined || value.trim() === '' ? fallback : value.trim();
  return safeName(candidate, '');
}

// The per-request token_budget ceiling defaults to the default budget, which
// preserves the historical contract. AI_GATEWAY_MAX_TOKEN_BUDGET raises only
// the ceiling a caller may request; it is never lower than the default.
function tokenBudgetLimits(env: NodeJS.ProcessEnv): { defaultTokenBudget: number; maxTokenBudget: number } {
  const defaultTokenBudget = boundedInt(env.AI_GATEWAY_DEFAULT_TOKEN_BUDGET, 4_096, 256, 32_768);
  const maxTokenBudget = Math.max(defaultTokenBudget, boundedInt(env.AI_GATEWAY_MAX_TOKEN_BUDGET, defaultTokenBudget, 256, 131_072));
  return { defaultTokenBudget, maxTokenBudget };
}

function optionalModel(value: string | undefined, fallback: string | null, label: string): string | null {
  if (value === undefined || value.trim() === '') return fallback;
  const candidate = modelName(value, '');
  if (!candidate) throw new AiGatewayError(503, `AI gateway ${label} is invalid`);
  return candidate;
}

function fallbackModels(env: NodeJS.ProcessEnv): Record<AiProfile, string | null> {
  const shared = optionalModel(env.AI_GATEWAY_FALLBACK_MODEL, null, 'fallback model');
  return {
    fast: optionalModel(env.AI_GATEWAY_FALLBACK_MODEL_FAST, shared, 'fallback model'),
    balanced: optionalModel(env.AI_GATEWAY_FALLBACK_MODEL_BALANCED, shared, 'fallback model'),
    quality: optionalModel(env.AI_GATEWAY_FALLBACK_MODEL_QUALITY, shared, 'fallback model'),
  };
}

// Newer OpenAI-compatible models reject `max_tokens` or a non-default
// temperature. These switches keep the default payload unchanged for existing
// providers while letting an operator opt in per deployment.
function readRequestOptions(env: NodeJS.ProcessEnv): RequestOptions {
  const tokenParam = (env.AI_GATEWAY_TOKEN_PARAM || 'max_tokens').trim();
  if (tokenParam !== 'max_tokens' && tokenParam !== 'max_completion_tokens') {
    throw new AiGatewayError(503, 'AI gateway token parameter option is invalid');
  }
  const rawTemperature = (env.AI_GATEWAY_SEND_TEMPERATURE || 'true').trim().toLowerCase();
  let sendTemperature: boolean;
  if (['1', 'true', 'yes', 'on'].includes(rawTemperature)) sendTemperature = true;
  else if (['0', 'false', 'no', 'off'].includes(rawTemperature)) sendTemperature = false;
  else throw new AiGatewayError(503, 'AI gateway temperature option is invalid');
  const rawEffort = (env.AI_GATEWAY_REASONING_EFFORT || '').trim().toLowerCase();
  if (rawEffort && !/^[a-z]{1,16}$/.test(rawEffort)) {
    throw new AiGatewayError(503, 'AI gateway reasoning effort option is invalid');
  }
  // `unknown` keeps the historical fail-closed behavior: a provider error that
  // may have been billed records a NULL cost, which blocks the budget guard.
  // `bounded` records zero for an HTTP rejection (nothing generated) and the
  // reserved worst-case estimate for timeouts or unreadable responses.
  const errorCostPolicy = (env.AI_GATEWAY_ERROR_COST_POLICY || 'unknown').trim();
  if (errorCostPolicy !== 'unknown' && errorCostPolicy !== 'bounded') {
    throw new AiGatewayError(503, 'AI gateway error cost policy is invalid');
  }
  return { tokenParam, sendTemperature, reasoningEffort: rawEffort || null, errorCostPolicy };
}

function validateBaseUrl(raw: string, env: NodeJS.ProcessEnv): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AiGatewayError(503, 'AI gateway provider URL is invalid');
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AiGatewayError(503, 'AI gateway provider URL contains forbidden credentials or query data');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && env.NODE_ENV !== 'production')) {
    throw new AiGatewayError(503, 'AI gateway provider URL must use HTTPS');
  }
  return parsed;
}

function readConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const provider = (env.AI_GATEWAY_PROVIDER || '').trim();
  if (provider !== 'openai-compatible') {
    throw new AiGatewayError(503, 'AI gateway provider is not configured');
  }

  const rawBaseUrl = (env.AI_GATEWAY_BASE_URL || '').trim();
  const apiKey = (env.AI_GATEWAY_API_KEY || '').trim();
  if (!rawBaseUrl) throw new AiGatewayError(503, 'AI gateway provider URL is not configured');
  const baseUrl = validateBaseUrl(rawBaseUrl, env);
  const local = baseUrl.hostname === 'localhost' || baseUrl.hostname === '127.0.0.1' || baseUrl.hostname === '::1';
  if (!apiKey && (!local || env.NODE_ENV === 'production')) {
    throw new AiGatewayError(503, 'AI gateway provider credential is not configured');
  }

  const defaultModel = safeName(env.AI_GATEWAY_MODEL, '');
  const models = {
    fast: modelName(env.AI_GATEWAY_MODEL_FAST, defaultModel),
    balanced: modelName(env.AI_GATEWAY_MODEL_BALANCED, defaultModel),
    quality: modelName(env.AI_GATEWAY_MODEL_QUALITY, defaultModel),
  };
  if (!models.fast || !models.balanced || !models.quality) {
    throw new AiGatewayError(503, 'AI gateway model mapping is not configured');
  }

  const inputRatePer1k = nonNegativeRate(env.AI_GATEWAY_INPUT_USD_PER_1K);
  const outputRatePer1k = nonNegativeRate(env.AI_GATEWAY_OUTPUT_USD_PER_1K);
  if (inputRatePer1k === null || outputRatePer1k === null) {
    throw new AiGatewayError(503, 'AI gateway input/output rate cards are not configured');
  }
  const fallbacks = fallbackModels(env);
  const fallbackInputRatePer1k = (env.AI_GATEWAY_FALLBACK_INPUT_USD_PER_1K || '').trim() === ''
    ? inputRatePer1k
    : nonNegativeRate(env.AI_GATEWAY_FALLBACK_INPUT_USD_PER_1K);
  const fallbackOutputRatePer1k = (env.AI_GATEWAY_FALLBACK_OUTPUT_USD_PER_1K || '').trim() === ''
    ? outputRatePer1k
    : nonNegativeRate(env.AI_GATEWAY_FALLBACK_OUTPUT_USD_PER_1K);
  if (fallbackInputRatePer1k === null || fallbackOutputRatePer1k === null) {
    throw new AiGatewayError(503, 'AI gateway fallback rate cards are invalid');
  }
  const options = readRequestOptions(env);

  return {
    provider: 'openai-compatible',
    providerName: safeName(env.AI_GATEWAY_PROVIDER_NAME, 'openai-compatible'),
    baseUrl,
    apiKey,
    models,
    maxContextChars: boundedInt(env.AI_GATEWAY_MAX_CONTEXT_CHARS, 48_000, 1_024, 200_000),
    maxOutputTokens: boundedInt(env.AI_GATEWAY_MAX_OUTPUT_TOKENS, 4_096, 128, 16_384),
    ...tokenBudgetLimits(env),
    timeoutMs: boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
    // Calls that request their own reasoning effort may think longer; other callers keep timeoutMs.
    reasoningTimeoutMs: boundedInt(
      env.AI_GATEWAY_REASONING_TIMEOUT_MS,
      boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
      1_000,
      120_000,
    ),
    inputRatePer1k,
    outputRatePer1k,
    fallbackModels: fallbacks,
    fallbackInputRatePer1k,
    fallbackOutputRatePer1k,
    ...options,
  };
}

function safeStatusValue<T>(read: () => T, fallback: T): T {
  try { return read(); } catch { return fallback; }
}

export function getAiGatewayStatus(env: NodeJS.ProcessEnv = process.env): AiGatewayStatus {
  const defaultModel = safeName(env.AI_GATEWAY_MODEL, '');
  const common = {
    contract: AI_GATEWAY_CONTRACT as typeof AI_GATEWAY_CONTRACT,
    response_language: AI_RESPONSE_LANGUAGE,
    adapter: 'none' as const,
    base_url_configured: Boolean(env.AI_GATEWAY_BASE_URL),
    api_key_configured: Boolean(env.AI_GATEWAY_API_KEY),
    rate_cards_configured: nonNegativeRate(env.AI_GATEWAY_INPUT_USD_PER_1K) !== null
      && nonNegativeRate(env.AI_GATEWAY_OUTPUT_USD_PER_1K) !== null,
    models: {
      fast: modelName(env.AI_GATEWAY_MODEL_FAST, defaultModel) || null,
      balanced: modelName(env.AI_GATEWAY_MODEL_BALANCED, defaultModel) || null,
      quality: modelName(env.AI_GATEWAY_MODEL_QUALITY, defaultModel) || null,
    },
    fallback_models: safeStatusValue<Record<AiProfile, string | null>>(() => fallbackModels(env), { fast: null, balanced: null, quality: null }),
    request_options: (() => {
      const options = safeStatusValue<RequestOptions | null>(() => readRequestOptions(env), null);
      return {
        token_param: options?.tokenParam ?? null,
        send_temperature: options?.sendTemperature ?? null,
        reasoning_effort: options?.reasoningEffort ?? null,
        request_reasoning_efforts: [...REQUEST_REASONING_EFFORTS],
        error_cost_policy: options?.errorCostPolicy ?? null,
        response_formats: [...RESPONSE_FORMATS],
      };
    })(),
    limits: {
      max_context_chars: boundedInt(env.AI_GATEWAY_MAX_CONTEXT_CHARS, 48_000, 1_024, 200_000),
      max_output_tokens: boundedInt(env.AI_GATEWAY_MAX_OUTPUT_TOKENS, 4_096, 128, 16_384),
      default_token_budget: tokenBudgetLimits(env).defaultTokenBudget,
      max_token_budget: tokenBudgetLimits(env).maxTokenBudget,
      timeout_ms: boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
      reasoning_timeout_ms: boundedInt(
        env.AI_GATEWAY_REASONING_TIMEOUT_MS,
        boundedInt(env.AI_GATEWAY_TIMEOUT_MS, 30_000, 1_000, 120_000),
        1_000,
        120_000,
      ),
    },
  };
  try {
    const config = readConfig(env);
    return {
      ...common,
      configured: true,
      provider: config.providerName,
      adapter: 'openai-compatible',
    };
  } catch (error) {
    return {
      ...common,
      configured: false,
      provider: safeName(env.AI_GATEWAY_PROVIDER, '') || null,
      reason: error instanceof AiGatewayError ? error.message : 'AI gateway configuration is invalid',
    };
  }
}

function validateRequest(input: unknown, config: GatewayConfig): Required<Pick<AiGenerateRequest, 'route' | 'prompt_version' | 'messages'>> & {
  profile: AiProfile;
  privacyClass: AiPrivacyClass;
  tokenBudget: number;
  maxOutputTokens: number;
  temperature: number;
  responseFormat: AiResponseFormat | null;
  reasoningEffort: string | null;
} {
  if (!input || typeof input !== 'object') throw new AiGatewayError(400, 'Request body must be a JSON object');
  const value = input as Record<string, unknown>;
  const route = typeof value.route === 'string' ? value.route.trim() : '';
  const promptVersion = typeof value.prompt_version === 'string' ? value.prompt_version.trim() : '';
  if (!/^[A-Za-z0-9_.:/-]{1,64}$/.test(route)) throw new AiGatewayError(400, 'route is required and must be a safe identifier');
  if (!/^[A-Za-z0-9_.:/-]{1,64}$/.test(promptVersion)) throw new AiGatewayError(400, 'prompt_version is required and must be a safe identifier');

  const profile = (typeof value.profile === 'string' ? value.profile : 'balanced') as AiProfile;
  if (!PROFILES.has(profile)) throw new AiGatewayError(400, 'profile must be fast, balanced, or quality');
  const privacyClass = (typeof value.privacy_class === 'string' ? value.privacy_class : 'internal') as AiPrivacyClass;
  if (!PRIVACY_CLASSES.has(privacyClass)) throw new AiGatewayError(400, 'privacy_class is invalid');
  if (privacyClass === 'private' || privacyClass === 'restricted') {
    throw new AiGatewayError(403, 'Hosted AI generation is disabled for private or restricted data');
  }

  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 40) {
    throw new AiGatewayError(400, 'messages must contain between 1 and 40 items');
  }
  const messages = value.messages.map((item, index) => {
    if (!item || typeof item !== 'object') throw new AiGatewayError(400, `messages[${index}] must be an object`);
    const message = item as Record<string, unknown>;
    const role = message.role;
    const content = message.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') throw new AiGatewayError(400, `messages[${index}].role is invalid`);
    if (typeof content !== 'string' || content.trim() === '' || content.length > config.maxContextChars) {
      throw new AiGatewayError(400, `messages[${index}].content is empty or too large`);
    }
    return { role, content } as AiMessage;
  });
  if (!messages.some((message) => message.role === 'user')) throw new AiGatewayError(400, 'messages must contain a user message');
  const messagesWithLanguagePolicy = withDefaultResponseLanguage(messages);
  const contextChars = messagesWithLanguagePolicy.reduce((sum, message) => sum + message.content.length, 0);
  if (contextChars > config.maxContextChars) throw new AiGatewayError(400, 'message context exceeds the gateway limit');

  const tokenBudget = value.token_budget === undefined ? config.defaultTokenBudget : Number(value.token_budget);
  if (!Number.isInteger(tokenBudget) || tokenBudget < 256 || tokenBudget > config.maxTokenBudget) {
    throw new AiGatewayError(400, `token_budget must be an integer between 256 and ${config.maxTokenBudget}`);
  }
  const requestedOutput = value.max_output_tokens === undefined ? PROFILE_DEFAULT_OUTPUT[profile] : Number(value.max_output_tokens);
  const maxOutputTokens = Math.min(requestedOutput, config.maxOutputTokens);
  if (!Number.isInteger(requestedOutput) || requestedOutput < 1 || requestedOutput > config.maxOutputTokens) {
    throw new AiGatewayError(400, `max_output_tokens must be an integer between 1 and ${config.maxOutputTokens}`);
  }
  const temperature = value.temperature === undefined ? 0.2 : Number(value.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new AiGatewayError(400, 'temperature must be between 0 and 2');
  const estimatedInputTokens = Math.ceil(contextChars / 4) + messagesWithLanguagePolicy.length * 4;
  if (estimatedInputTokens + maxOutputTokens > tokenBudget) throw new AiGatewayError(400, 'estimated input and output exceed token_budget');

  let responseFormat: AiResponseFormat | null = null;
  if (value.response_format !== undefined) {
    const format = value.response_format;
    if (!format || typeof format !== 'object' || Array.isArray(format)
      || Object.keys(format).some((key) => key !== 'type')
      || !RESPONSE_FORMATS.has((format as Record<string, unknown>).type as AiResponseFormat)) {
      throw new AiGatewayError(400, 'response_format must be {"type":"text"} or {"type":"json_object"}');
    }
    responseFormat = (format as { type: AiResponseFormat }).type;
    // OpenAI-compatible JSON mode rejects requests whose messages never ask
    // for JSON. Fail early with a caller-actionable 400 instead of a 502.
    if (responseFormat === 'json_object' && !messages.some((message) => /json/i.test(message.content))) {
      throw new AiGatewayError(400, 'response_format json_object requires a message that asks for JSON');
    }
  }

  let reasoningEffort: string | null = null;
  if (value.reasoning_effort !== undefined) {
    const effort = typeof value.reasoning_effort === 'string' ? value.reasoning_effort.trim().toLowerCase() : '';
    if (!REQUEST_REASONING_EFFORTS.has(effort)) {
      throw new AiGatewayError(400, `reasoning_effort must be one of ${[...REQUEST_REASONING_EFFORTS].join(', ')}`);
    }
    reasoningEffort = effort;
  }

  return { route, prompt_version: promptVersion, messages: messagesWithLanguagePolicy, profile, privacyClass, tokenBudget, maxOutputTokens, temperature, responseFormat, reasoningEffort };
}

function endpoint(baseUrl: URL): URL {
  const base = baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`;
  return new URL('chat/completions', base);
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function telemetryForError(runId: string, request: { route: string; prompt_version: string; tokenBudget: number }, provider: string | null, model: string | null, latencyMs: number, status: 'error' | 'budget_exceeded' = 'error', errorClass?: string): AiTelemetryEvent {
  return {
    run_id: runId,
    route: request.route,
    prompt_version: request.prompt_version,
    provider,
    model,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    token_budget: request.tokenBudget,
    latency_ms: latencyMs,
    estimated_cost_usd: status === 'budget_exceeded' ? 0 : null,
    cache_hit: false,
    status,
    metadata: { contract: AI_GATEWAY_CONTRACT, error_class: errorClass || 'provider_error' },
  };
}

type ValidatedRequest = ReturnType<typeof validateRequest>;

type AttemptSuccess = {
  kind: 'success';
  model: string;
  payload: any;
  content: string;
};

type AttemptFailure = {
  kind: 'failure';
  model: string;
  status: number;
  message: string;
  errorClass: string;
  // True when the provider answered with an HTTP error status: nothing was
  // generated, so a bounded cost policy can record zero spend.
  httpRejected: boolean;
  // 429, 5xx, timeout and network failures may succeed on a fallback model.
  retryable: boolean;
};

function roundedLatency(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function costFor(inputTokens: number, outputTokens: number, inputRate: number | null, outputRate: number | null): number | null {
  if (inputRate === null || outputRate === null) return null;
  return Number(((inputTokens * inputRate + outputTokens * outputRate) / 1000).toFixed(8));
}

async function callProvider(config: GatewayConfig, request: ValidatedRequest, model: string): Promise<AttemptSuccess | AttemptFailure> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  const body: Record<string, unknown> = { model, messages: request.messages, stream: false };
  body[config.tokenParam] = request.maxOutputTokens;
  if (config.sendTemperature) body.temperature = request.temperature;
  const reasoningEffort = request.reasoningEffort ?? config.reasoningEffort;
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  if (request.responseFormat === 'json_object') body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.reasoningEffort ? config.reasoningTimeoutMs : config.timeoutMs);
  let providerResponse: Response;
  let payload: any;
  try {
    try {
      providerResponse = await fetch(endpoint(config.baseUrl), {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });
    } catch (error) {
      const errorClass = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network_error';
      return { kind: 'failure', model, status: errorClass === 'timeout' ? 504 : 502, message: `AI provider ${errorClass}`, errorClass, httpRejected: false, retryable: true };
    }

    if (!providerResponse.ok) {
      // Drain without reading the body into any error, log, or telemetry.
      await providerResponse.body?.cancel().catch(() => undefined);
      const errorClass = providerResponse.status === 429 ? 'rate_limited' : providerResponse.status === 401 || providerResponse.status === 403 ? 'provider_auth' : 'provider_rejected';
      const status = providerResponse.status === 429 ? 429 : 502;
      return {
        kind: 'failure',
        model,
        status,
        message: `AI provider ${errorClass}`,
        errorClass,
        httpRejected: true,
        retryable: providerResponse.status === 429 || providerResponse.status >= 500,
      };
    }

    try {
      payload = await providerResponse.json();
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'AbortError';
      return timedOut
        ? { kind: 'failure', model, status: 504, message: 'AI provider timeout', errorClass: 'timeout', httpRejected: false, retryable: true }
        : { kind: 'failure', model, status: 502, message: 'AI provider returned invalid JSON', errorClass: 'invalid_json', httpRejected: false, retryable: false };
    }
  } finally {
    clearTimeout(timeout);
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return { kind: 'failure', model, status: 502, message: 'AI provider response did not contain text content', errorClass: 'invalid_response', httpRejected: false, retryable: false };
  }
  // Provider implementations can ignore the output cap or return an unexpected
  // payload. Keep the response bounded before it crosses the API boundary.
  const maxResponseBytes = Math.min(
    config.maxContextChars * 4,
    Math.max(1_024, request.maxOutputTokens * 16),
  );
  if (Buffer.byteLength(content, 'utf8') > maxResponseBytes) {
    return { kind: 'failure', model, status: 502, message: 'AI provider response exceeded the output limit', errorClass: 'invalid_response', httpRejected: false, retryable: false };
  }
  return { kind: 'success', model, payload, content };
}

export async function generateAi(input: unknown, env: NodeJS.ProcessEnv = process.env, options: AiGenerateOptions = {}): Promise<{ response: AiGenerateResponse; telemetry: AiTelemetryEvent }> {
  const runId = randomUUID();
  const started = performance.now();
  let config: GatewayConfig;
  try {
    config = readConfig(env);
  } catch (error) {
    const message = error instanceof AiGatewayError ? error.message : 'AI gateway configuration is invalid';
    throw new AiGatewayError(503, message, telemetryForError(runId, { route: 'unknown', prompt_version: 'unknown', tokenBudget: 0 }, null, null, performance.now() - started, 'error', 'not_configured'));
  }
  const request = validateRequest(input, config);
  const primaryModel = config.models[request.profile];
  const fallbackModel = config.fallbackModels[request.profile];
  // Byte count provides a conservative text-token allowance, including Thai;
  // chars / 4 is only a heuristic and must not be used as a cost ceiling.
  const estimatedInputTokens = request.messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 32, 0);
  const ratesFor = (fallback: boolean): [number | null, number | null] => fallback
    ? [config.fallbackInputRatePer1k, config.fallbackOutputRatePer1k]
    : [config.inputRatePer1k, config.outputRatePer1k];
  const estimateFor = (fallback: boolean) => costFor(estimatedInputTokens, request.maxOutputTokens, ...ratesFor(fallback));
  // Shared microUSD ceilings must use the unrounded cost. Telemetry retains its
  // historical eight-decimal representation for backwards compatibility.
  const sharedCostFor = (input: number, output: number, fallback: boolean): number | null => {
    const [inputRate, outputRate] = ratesFor(fallback);
    return inputRate === null || outputRate === null ? null : (input * inputRate + output * outputRate) / 1000;
  };
  const sharedEstimateFor = (fallback: boolean) => sharedCostFor(estimatedInputTokens, request.maxOutputTokens, fallback);

  const reserve = async (model: string, fallback: boolean): Promise<(() => void) | undefined> => {
    try {
      return options.budgetGuard ? await options.budgetGuard.reserve(estimateFor(fallback)) : undefined;
    } catch (error) {
      if (error instanceof AiBudgetError) {
        throw new AiGatewayError(429, 'AI monthly budget guard denied the request', telemetryForError(runId, request, config.providerName, model, roundedLatency(started), 'budget_exceeded', error.reason));
      }
      throw error;
    }
  };

  const failureTelemetry = (id: string, failure: AttemptFailure, fallback: boolean, latencyMs: number, extra: AiTelemetryEvent['metadata'] = {}): AiTelemetryEvent => {
    const event = telemetryForError(id, request, config.providerName, failure.model, latencyMs, 'error', failure.errorClass);
    if (config.errorCostPolicy === 'bounded') event.estimated_cost_usd = failure.httpRejected ? 0 : estimateFor(fallback);
    event.metadata = { ...event.metadata, profile: request.profile, error_cost_policy: config.errorCostPolicy, ...extra };
    return event;
  };

  let telemetryFailed = false;
  const record = (event: AiTelemetryEvent) => {
    try { options.recordTelemetry?.(event); }
    catch (error) { telemetryFailed = true; throw error; }
  };

  let releaseBudget = await reserve(primaryModel, false);
  let sharedReservation: AiAttemptReservation | undefined;
  try {
    sharedReservation = await options.attemptAdmission?.reserve(sharedEstimateFor(false));
    let outcome = await callProvider(config, request, primaryModel);
    let primaryFailure: AttemptFailure | null = null;
    if (outcome.kind === 'failure' && outcome.retryable && fallbackModel) {
      primaryFailure = outcome;
      // The failed primary attempt is its own ledger row so its (possibly
      // billed) cost is persisted before the reservation is released.
      record(failureTelemetry(randomUUID(), outcome, false, roundedLatency(started), { attempt: 'primary', parent_run_id: runId }));
      await sharedReservation?.settle(null);
      sharedReservation = undefined;
      releaseBudget?.();
      releaseBudget = undefined;
      try {
        releaseBudget = await reserve(fallbackModel, true);
      } catch (error) {
        if (error instanceof AiGatewayError && error.telemetry) {
          throw new AiGatewayError(primaryFailure.status, primaryFailure.message, error.telemetry);
        }
        throw error;
      }
      sharedReservation = await options.attemptAdmission?.reserve(sharedEstimateFor(true));
      outcome = await callProvider(config, request, fallbackModel);
    }
    const fallbackUsed = primaryFailure !== null;
    const fallbackMetadata: AiTelemetryEvent['metadata'] = fallbackUsed
      ? { fallback_used: true, primary_model: primaryModel, primary_error_class: primaryFailure!.errorClass }
      : { fallback_used: false };

    const latencyMs = roundedLatency(started);
    if (outcome.kind === 'failure') {
      await sharedReservation?.settle(null);
      throw new AiGatewayError(outcome.status, outcome.message, failureTelemetry(runId, outcome, fallbackUsed, latencyMs, fallbackMetadata));
    }

    const { payload, content, model } = outcome;
    const inputTokens = integerOrNull(payload?.usage?.prompt_tokens ?? payload?.usage?.input_tokens);
    const outputTokens = integerOrNull(payload?.usage?.completion_tokens ?? payload?.usage?.output_tokens);
    const totalTokens = integerOrNull(payload?.usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
    const usage: AiUsage = { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: totalTokens, source: totalTokens === null ? 'unavailable' : 'provider' };
    const actualCost = inputTokens !== null && outputTokens !== null
      ? costFor(inputTokens, outputTokens, ...ratesFor(fallbackUsed))
      : null;
    const status = totalTokens !== null && totalTokens > request.tokenBudget ? 'budget_exceeded' : 'success';
    const telemetry: AiTelemetryEvent = {
      run_id: runId,
      route: request.route,
      prompt_version: request.prompt_version,
      provider: config.providerName,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      token_budget: request.tokenBudget,
      latency_ms: latencyMs,
      estimated_cost_usd: actualCost,
      cache_hit: false,
      status,
      metadata: {
        contract: AI_GATEWAY_CONTRACT,
        profile: request.profile,
        privacy_class: request.privacyClass,
        usage_source: usage.source,
        response_language: AI_RESPONSE_LANGUAGE,
        response_language_policy: AI_RESPONSE_LANGUAGE_POLICY_VERSION,
        ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
        ...fallbackMetadata,
      },
    };
    record(telemetry);
    await sharedReservation?.settle(inputTokens !== null && outputTokens !== null ? sharedCostFor(inputTokens, outputTokens, fallbackUsed) : null);
    return {
      response: {
        contract: AI_GATEWAY_CONTRACT,
        run_id: runId,
        status,
        route: request.route,
        prompt_version: request.prompt_version,
        provider: config.providerName,
        model,
        fallback_used: fallbackUsed,
        content,
        output_trust: 'untrusted_model_output',
        finish_reason: typeof payload?.choices?.[0]?.finish_reason === 'string' ? payload.choices[0].finish_reason : null,
        usage,
        token_budget: request.tokenBudget,
        latency_ms: latencyMs,
        estimated_cost_usd: actualCost,
      },
      telemetry,
    };
  } catch (error) {
    if (error instanceof AiGatewayError && error.telemetry && !telemetryFailed) record(error.telemetry);
    throw error;
  } finally {
    // Persist spend before making this reservation available to another call.
    // A failed telemetry write retains the reservation for operator recovery.
    if (!telemetryFailed) releaseBudget?.();
  }
}

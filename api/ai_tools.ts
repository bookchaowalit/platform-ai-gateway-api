/**
 * SPEC-002: tool calling, image input and JSON-schema output for /api/ai/generate.
 *
 * The gateway validates and forwards OpenAI-compatible shapes; it never executes a tool, never
 * fetches a remote image and keeps no conversation state. Everything a caller sends here is
 * bounded before the provider call, and everything the provider returns is bounded before it
 * crosses the API boundary. Validation errors carry fixed text only, never caller or model content.
 */

export const MAX_TOOLS = 32;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_TOOL_DESCRIPTION_CHARS = 4_096;
export const MAX_TOOL_CALLS = 16;
export const MAX_TOOL_ARGUMENT_BYTES = 16 * 1024;
export const MAX_IMAGES = 4;

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/;
const TOOL_CHOICE_WORDS = new Set(['auto', 'none', 'required']);

/** A caller error; the gateway turns it into a 400 with this fixed message. */
export class InvalidAiRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAiRequest';
  }
}

function fail(message: string): never {
  throw new InvalidAiRequest(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${label} has unsupported fields`);
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

// ---- tools ----------------------------------------------------------------------------------

export interface ParsedTools {
  /** Provider-shaped tool list, or null when the request has no tools. */
  tools: Array<Record<string, unknown>> | null;
  names: Set<string>;
  toolChoice: unknown;
  parallelToolCalls: boolean | undefined;
  /** Serialized bytes of tools and tool_choice, billed by the provider as input. */
  bytes: number;
}

export function parseTools(request: Record<string, unknown>): ParsedTools {
  const raw = request.tools;
  if (raw === undefined) {
    if (request.tool_choice !== undefined) fail('tool_choice requires tools');
    if (request.parallel_tool_calls !== undefined) fail('parallel_tool_calls requires tools');
    return { tools: null, names: new Set(), toolChoice: undefined, parallelToolCalls: undefined, bytes: 0 };
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TOOLS) fail(`tools must contain between 1 and ${MAX_TOOLS} items`);
  const names = new Set<string>();
  const tools = raw.map((item, index) => {
    const label = `tools[${index}]`;
    if (!isPlainObject(item) || item.type !== 'function' || !isPlainObject(item.function)) fail(`${label} must be a function tool`);
    onlyKeys(item, ['type', 'function'], label);
    const fn = item.function;
    onlyKeys(fn, ['name', 'description', 'parameters', 'strict'], `${label}.function`);
    if (typeof fn.name !== 'string' || !TOOL_NAME.test(fn.name)) fail(`${label}.function.name must match ${TOOL_NAME.source}`);
    if (names.has(fn.name)) fail(`${label}.function.name is a duplicate`);
    names.add(fn.name);
    const out: Record<string, unknown> = { name: fn.name };
    if (fn.description !== undefined) {
      if (typeof fn.description !== 'string' || fn.description.length > MAX_TOOL_DESCRIPTION_CHARS) fail(`${label}.function.description is invalid`);
      out.description = fn.description;
    }
    if (fn.parameters !== undefined) {
      if (!isPlainObject(fn.parameters) || jsonBytes(fn.parameters) > MAX_SCHEMA_BYTES) fail(`${label}.function.parameters must be a JSON schema object of at most ${MAX_SCHEMA_BYTES} bytes`);
      out.parameters = fn.parameters;
    }
    if (fn.strict !== undefined) {
      if (typeof fn.strict !== 'boolean') fail(`${label}.function.strict must be a boolean`);
      out.strict = fn.strict;
    }
    return { type: 'function', function: out };
  });

  let toolChoice: unknown;
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice;
    if (typeof choice === 'string') {
      if (!TOOL_CHOICE_WORDS.has(choice)) fail('tool_choice must be auto, none, required or a named function');
      toolChoice = choice;
    } else if (isPlainObject(choice) && choice.type === 'function' && isPlainObject(choice.function)
      && Object.keys(choice).length === 2 && Object.keys(choice.function).length === 1
      && typeof choice.function.name === 'string' && names.has(choice.function.name)) {
      toolChoice = { type: 'function', function: { name: choice.function.name } };
    } else {
      fail('tool_choice must be auto, none, required or a named function from tools');
    }
  }
  let parallelToolCalls: boolean | undefined;
  if (request.parallel_tool_calls !== undefined) {
    if (typeof request.parallel_tool_calls !== 'boolean') fail('parallel_tool_calls must be a boolean');
    parallelToolCalls = request.parallel_tool_calls;
  }
  return { tools, names, toolChoice, parallelToolCalls, bytes: jsonBytes(tools) + (toolChoice === undefined ? 0 : jsonBytes(toolChoice)) };
}

// ---- json_schema ----------------------------------------------------------------------------

export function parseJsonSchemaFormat(format: Record<string, unknown>): { format: Record<string, unknown>; bytes: number } {
  const bad = (): never => fail('response_format json_schema needs {name, schema[, strict, description]} with a safe name and a schema of at most 16384 bytes');
  if (Object.keys(format).some((key) => key !== 'type' && key !== 'json_schema') || !isPlainObject(format.json_schema)) bad();
  const spec = format.json_schema as Record<string, unknown>;
  if (Object.keys(spec).some((key) => !['name', 'schema', 'strict', 'description'].includes(key))) bad();
  if (typeof spec.name !== 'string' || !SCHEMA_NAME.test(spec.name)) bad();
  if (!isPlainObject(spec.schema) || jsonBytes(spec.schema) > MAX_SCHEMA_BYTES) bad();
  if (spec.strict !== undefined && typeof spec.strict !== 'boolean') bad();
  if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > MAX_TOOL_DESCRIPTION_CHARS)) bad();
  const out: Record<string, unknown> = { name: spec.name, schema: spec.schema };
  if (spec.strict !== undefined) out.strict = spec.strict;
  if (spec.description !== undefined) out.description = spec.description;
  const result = { type: 'json_schema', json_schema: out };
  return { format: result, bytes: jsonBytes(out) };
}

// ---- messages -------------------------------------------------------------------------------

export interface ImageLimits {
  maxImageBytes: number;
  maxTotalImageBytes: number;
}

export interface ParsedMessages {
  /** Provider-shaped (OpenAI chat-completions) messages, before the language policy. */
  messages: Array<Record<string, unknown>>;
  imageCount: number;
  /** Serialized bytes of assistant tool_calls in the history, billed as input. */
  toolHistoryBytes: number;
  hasUser: boolean;
}

function magicMatches(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** Decoded byte length of a validated data URL image; throws on anything else. */
function imageBytes(dataUrl: unknown, label: string, limits: ImageLimits): number {
  const invalid = `${label} image must be a base64 data URL (png, jpeg or webp)`;
  if (typeof dataUrl !== 'string') fail(invalid);
  const match = DATA_URL.exec(dataUrl);
  if (!match) fail(invalid);
  const [, mediaType, payload] = match;
  if (payload.length === 0 || payload.length % 4 !== 0) fail(invalid);
  // Reject before decoding when the encoded size already proves the image is too big.
  if (Math.floor(payload.length / 4) * 3 - 2 > limits.maxImageBytes) fail(`${label} image exceeds the per-image size limit`);
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length > limits.maxImageBytes) fail(`${label} image exceeds the per-image size limit`);
  if (!magicMatches(mediaType, decoded)) fail(invalid);
  return decoded.length;
}

function userContent(content: unknown, label: string, maxChars: number, limits: ImageLimits, state: { images: number; imageBytes: number }): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    if (content.trim() === '' || content.length > maxChars) fail(`${label}.content is empty or too large`);
    return content;
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > 16) fail(`${label}.content must be a string or 1 to 16 parts`);
  let chars = 0;
  return content.map((part, index) => {
    const partLabel = `${label}.content[${index}]`;
    if (!isPlainObject(part)) fail(`${partLabel} must be an object`);
    if (part.type === 'text') {
      onlyKeys(part, ['type', 'text'], partLabel);
      if (typeof part.text !== 'string' || part.text.trim() === '') fail(`${partLabel}.text is empty`);
      chars += part.text.length;
      if (chars > maxChars) fail(`${label}.content is empty or too large`);
      return { type: 'text', text: part.text };
    }
    if (part.type === 'image') {
      onlyKeys(part, ['type', 'data_url'], partLabel);
      state.images += 1;
      if (state.images > MAX_IMAGES) fail(`at most ${MAX_IMAGES} images per request`);
      state.imageBytes += imageBytes(part.data_url, partLabel, limits);
      if (state.imageBytes > limits.maxTotalImageBytes) fail('images together exceed the total image size limit');
      return { type: 'image_url', image_url: { url: part.data_url } };
    }
    return fail(`${partLabel}.type must be text or image`);
  });
}

function assistantToolCalls(raw: unknown, label: string, tools: ParsedTools, seenIds: Set<string>): Array<Record<string, unknown>> {
  if (!tools.tools) fail(`${label}.tool_calls requires tools`);
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TOOL_CALLS) fail(`${label}.tool_calls must contain between 1 and ${MAX_TOOL_CALLS} tool calls`);
  return raw.map((call, index) => {
    const callLabel = `${label}.tool_calls[${index}]`;
    if (!isPlainObject(call) || call.type !== 'function' || !isPlainObject(call.function)) fail(`${callLabel} must be a function tool call`);
    onlyKeys(call, ['id', 'type', 'function'], callLabel);
    onlyKeys(call.function, ['name', 'arguments'], `${callLabel}.function`);
    if (typeof call.id !== 'string' || !CALL_ID.test(call.id)) fail(`${callLabel}.id is invalid`);
    if (seenIds.has(call.id)) fail(`${callLabel}.id is a duplicate tool call id`);
    seenIds.add(call.id);
    const { name, arguments: args } = call.function;
    if (typeof name !== 'string' || !tools.names.has(name)) fail(`${callLabel}.function.name is not a defined tool`);
    if (typeof args !== 'string' || Buffer.byteLength(args, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) fail(`${callLabel}.function.arguments must be a string of at most ${MAX_TOOL_ARGUMENT_BYTES} bytes`);
    return { id: call.id, type: 'function', function: { name, arguments: args } };
  });
}

export function parseMessages(raw: unknown, tools: ParsedTools, maxChars: number, limits: ImageLimits): ParsedMessages {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 40) fail('messages must contain between 1 and 40 items');
  const state = { images: 0, imageBytes: 0 };
  const seenIds = new Set<string>();
  let pending: Set<string> | null = null;
  let toolHistoryBytes = 0;
  const messages = raw.map((item, index) => {
    const label = `messages[${index}]`;
    if (!isPlainObject(item)) fail(`${label} must be an object`);
    const { role, content } = item;
    if (role !== 'tool' && pending && pending.size > 0) fail(`${label}: assistant tool calls must each be answered by a tool message first`);
    if (role !== 'tool') pending = null;

    if (role === 'tool') {
      if (!tools.tools) fail(`${label} tool messages require tools`);
      const id = item.tool_call_id;
      if (typeof id !== 'string' || !pending || !pending.has(id)) fail(`${label}.tool_call_id does not match a pending assistant tool call`);
      pending.delete(id);
      if (typeof content !== 'string' || content.length > maxChars) fail(`${label}.content must be a string within the context limit`);
      return { role, tool_call_id: id, content };
    }
    if (role === 'assistant' && item.tool_calls !== undefined) {
      const calls = assistantToolCalls(item.tool_calls, label, tools, seenIds);
      // OpenAI allows content to be omitted beside tool_calls; forward it as null.
      const text = content === undefined ? null : content;
      if (text !== null && (typeof text !== 'string' || text.length > maxChars)) fail(`${label}.content must be null or a string`);
      pending = new Set(calls.map((call) => call.id as string));
      toolHistoryBytes += jsonBytes(calls);
      return { role, content: text, tool_calls: calls };
    }
    if (role === 'user') return { role, content: userContent(content, label, maxChars, limits, state) };
    if (role !== 'system' && role !== 'assistant') fail(`${label}.role is invalid`);
    if (typeof content !== 'string' || content.trim() === '' || content.length > maxChars) fail(`${label}.content is empty or too large`);
    return { role, content };
  });
  if (pending && (pending as Set<string>).size > 0) fail('assistant tool calls must each be answered by a tool message');
  return { messages, imageCount: state.images, toolHistoryBytes, hasUser: messages.some((message) => message.role === 'user') };
}

/** The text a message carries (string content or text parts); images and tool calls excluded. */
export function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (isPlainObject(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('');
  return '';
}

// ---- provider tool calls --------------------------------------------------------------------

export interface GatewayToolCall {
  id: string;
  name: string;
  /** Raw provider string; not guaranteed to be valid JSON. */
  arguments: string;
}

/** Bounded tool calls from a provider reply, or null when the reply is malformed or unbounded. */
export function parseProviderToolCalls(raw: unknown, finishReason: unknown, names: Set<string>): GatewayToolCall[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_TOOL_CALLS) return null;
  if (raw.length > 0 && finishReason === 'length') return null; // truncated arguments
  const ids = new Set<string>();
  const calls: GatewayToolCall[] = [];
  for (const call of raw) {
    if (!isPlainObject(call) || (call.type !== undefined && call.type !== 'function') || !isPlainObject(call.function)) return null;
    const { id } = call;
    const { name, arguments: args } = call.function;
    if (typeof id !== 'string' || !CALL_ID.test(id) || ids.has(id)) return null;
    if (typeof name !== 'string' || !names.has(name)) return null;
    if (typeof args !== 'string' || Buffer.byteLength(args, 'utf8') > MAX_TOOL_ARGUMENT_BYTES) return null;
    ids.add(id);
    calls.push({ id, name, arguments: args });
  }
  return calls;
}

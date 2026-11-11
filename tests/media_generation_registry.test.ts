// SPEC-003 AC-04 (routing) and AC-05 (registry validation). Pure functions, no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEDIA_GENERATION_REGISTRY_SCHEMA,
  routeMediaGeneration,
  validateMediaGenerationRegistry,
  type MediaGenerationRegistry,
  type MediaRouteContext,
} from '../api/media/registry.js';

const NOW = new Date('2026-11-11T00:00:00Z');

function fixture(): MediaGenerationRegistry {
  return {
    schema_version: MEDIA_GENERATION_REGISTRY_SCHEMA,
    updated_at: '2026-11-11',
    policy: {
      max_evaluation_age_days: 60,
      external_privacy_classes: ['public', 'internal'],
      fallback_depth: 1,
      lease_wait_max_ms: 1_800_000,
      job_timeout_ms: 1_800_000,
    },
    providers: {
      'vendor-a': {
        adapter: 'fake-sync', credential_env: 'VENDOR_A_KEY', max_concurrent: 2, max_in_flight: 10, rpm: 30,
        webhook: false, output_hosts: [], privacy_classes: ['public', 'internal'], terms_checked_at: '2026-11-11',
      },
      'vendor-b': {
        adapter: 'fake-url', credential_env: 'VENDOR_B_KEY', max_concurrent: 2, max_in_flight: 10, rpm: 30,
        webhook: true, output_hosts: ['cdn.vendor-b.example'], privacy_classes: ['public'], terms_checked_at: '2026-11-11',
      },
    },
    models: {
      'a-photo': {
        provider: 'vendor-a', provider_model: 'photo-1', kind: 'image', enabled: true,
        capabilities: { aspects: ['1:1', '16:9'], resolutions: ['standard'], references: 0, text_in_image: 'fair', max_n: 4 },
        param_map: { aspect: { '1:1': { size: '1024x1024' }, '16:9': { size: '1536x864' } }, resolution: { standard: { quality: 'medium' } } },
        extra_params: { seed: { type: 'integer', min: 0, max: 4294967295 } },
        pricing: { unit: 'image', cost_source: 'registry', cancel_policy: 'free', usd: { '1:1|standard': 0.04, '16:9|standard': 0.06 }, source: 'https://vendor-a.example/pricing', checked_at: '2026-11-11' },
        own_eval: null,
      },
      'a-cheap': {
        provider: 'vendor-a', provider_model: 'photo-mini', kind: 'image', enabled: true,
        capabilities: { aspects: ['1:1', '16:9'], resolutions: ['standard'], references: 0, text_in_image: 'poor', max_n: 4 },
        param_map: { aspect: { '1:1': { size: '1024x1024' }, '16:9': { size: '1536x864' } }, resolution: { standard: { quality: 'low' } } },
        extra_params: {},
        pricing: { unit: 'image', cost_source: 'registry', cancel_policy: 'free', usd: { '1:1|standard': 0.01 }, source: 'https://vendor-a.example/pricing', checked_at: '2026-11-11' },
        own_eval: null,
      },
      'b-poster': {
        provider: 'vendor-b', provider_model: 'poster-3', kind: 'image', enabled: true,
        capabilities: { aspects: ['1:1', '16:9'], resolutions: ['standard'], references: 0, text_in_image: 'good', max_n: 2 },
        param_map: { aspect: { '1:1': { aspect_ratio: '1:1' }, '16:9': { aspect_ratio: '16:9' } }, resolution: { standard: {} } },
        extra_params: {},
        pricing: { unit: 'image', cost_source: 'provider', cancel_policy: 'charged', usd: { '1:1|standard': 0.05, '16:9|standard': 0.05 }, source: 'https://vendor-b.example/pricing', checked_at: '2026-11-11' },
        own_eval: null,
      },
    },
    profiles: {
      'social-photo': { kind: 'image', defaults: { aspect: '1:1', resolution: 'standard' }, models: ['a-photo', 'a-cheap', 'b-poster'] },
    },
  };
}

function ctx(overrides: Partial<MediaRouteContext> = {}): MediaRouteContext {
  return {
    now: NOW,
    hasCredential: () => true,
    subjectAllowsModel: () => true,
    budgetAllows: () => true,
    ...overrides,
  };
}

const baseRequest = {
  kind: 'image' as const,
  mode: 'single' as const,
  profile: 'social-photo',
  aspect: '1:1',
  resolution: 'standard',
  n: 1,
  privacy_class: 'internal' as const,
};

// ---------------------------------------------------------------- AC-05

test('SPEC-003 AC-05 the fixture registry has no problems', () => {
  assert.deepEqual(validateMediaGenerationRegistry(fixture()).problems, []);
});

test('SPEC-003 AC-05 invalid registries fail closed', () => {
  const cases: Array<[string, (r: MediaGenerationRegistry) => void, RegExp]> = [
    ['schema', (r) => { (r as { schema_version: string }).schema_version = 'other.v9'; }, /schema_version/],
    ['provider', (r) => { r.models['a-photo'].provider = 'nobody'; }, /a-photo.*provider/],
    ['profile model', (r) => { r.profiles['social-photo'].models.push('ghost'); }, /social-photo.*ghost/],
    ['param_map', (r) => { delete r.models['a-photo'].param_map.aspect['16:9']; }, /a-photo.*param_map.*16:9/],
    ['negative price', (r) => { r.models['a-photo'].pricing.usd['1:1|standard'] = -1; }, /a-photo.*price/],
    ['price source', (r) => { r.models['a-photo'].pricing.source = ''; }, /a-photo.*source/],
    ['output hosts', (r) => { r.providers['vendor-b'].output_hosts = []; }, /vendor-b.*output_hosts/],
    ['adapter', (r) => { r.providers['vendor-a'].adapter = 'mystery'; }, /vendor-a.*adapter/],
    ['profile kind', (r) => { r.profiles['social-photo'].kind = 'video'; }, /social-photo.*kind/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const registry = fixture();
    mutate(registry);
    const { problems } = validateMediaGenerationRegistry(registry);
    assert.ok(problems.some((p) => pattern.test(p)), `${name}: ${JSON.stringify(problems)}`);
    assert.ok(problems.every((p) => !/VENDOR_[AB]_KEY=|sk-/.test(p)), 'problems carry no values');
  }
});

test('SPEC-003 AC-05 a disabled model with no prices is valid but never routable', () => {
  const registry = fixture();
  registry.models['a-cheap'].enabled = false; // DoD N7: an enabled model must have prices
  registry.models['a-cheap'].pricing = { unit: 'image', cost_source: 'registry', cancel_policy: 'free', usd: {}, source: '', checked_at: '' };
  assert.deepEqual(validateMediaGenerationRegistry(registry).problems, []);
});

// ---------------------------------------------------------------- AC-04

test('SPEC-003 AC-04 single mode picks the first candidate plus fallback_depth fallbacks', () => {
  const result = routeMediaGeneration(fixture(), baseRequest, ctx());
  assert.deepEqual(result.selected.map((s) => s.model_id), ['a-photo']);
  assert.deepEqual(result.fallbacks.map((s) => s.model_id), ['a-cheap']);
  assert.equal(result.selected[0].reserved_usd, 0.04);
  assert.equal(result.selected[0].units, 1);
});

test('SPEC-003 AC-04 skipped models carry one reason each, in filter order', () => {
  const registry = fixture();
  registry.models['a-photo'].enabled = false;
  const result = routeMediaGeneration(registry, { ...baseRequest, aspect: '16:9', privacy_class: 'public' }, ctx({
    hasCredential: (env) => env !== 'VENDOR_B_KEY',
  }));
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.skipped, [
    { model_id: 'a-photo', reason: 'disabled' },
    { model_id: 'a-cheap', reason: 'no_price' },
    { model_id: 'b-poster', reason: 'no_credential' },
  ]);
});

test('SPEC-003 AC-04 privacy, capability, subject and budget filters', () => {
  const capability = routeMediaGeneration(fixture(), { ...baseRequest, n: 3 }, ctx());
  assert.deepEqual(capability.skipped.find((s) => s.model_id === 'b-poster'), { model_id: 'b-poster', reason: 'capability' });

  const privacy = routeMediaGeneration(fixture(), { ...baseRequest, mode: 'compare', n_models: 3 }, ctx());
  assert.deepEqual(privacy.skipped, [{ model_id: 'b-poster', reason: 'privacy' }]);

  const subject = routeMediaGeneration(fixture(), baseRequest, ctx({ subjectAllowsModel: (id) => id !== 'a-photo' }));
  assert.equal(subject.selected[0].model_id, 'a-cheap');
  assert.deepEqual(subject.skipped[0], { model_id: 'a-photo', reason: 'subject_not_allowed' });

  const budget = routeMediaGeneration(fixture(), baseRequest, ctx({ budgetAllows: (usd) => usd < 0.02 }));
  assert.equal(budget.selected[0].model_id, 'a-cheap');
  assert.deepEqual(budget.skipped[0], { model_id: 'a-photo', reason: 'budget' });
});

test('SPEC-003 AC-04 fresh own_eval scores re-order the profile; stale ones do not', () => {
  const fresh = fixture();
  fresh.models['a-cheap'].own_eval = { 'social-photo': { evaluated_at: '2026-11-01', votes: 30, win_rate: 0.7, mean_score: 4.4 } };
  fresh.models['a-photo'].own_eval = { 'social-photo': { evaluated_at: '2026-11-01', votes: 30, win_rate: 0.3, mean_score: 3.1 } };
  assert.equal(routeMediaGeneration(fresh, baseRequest, ctx()).selected[0].model_id, 'a-cheap');

  const stale = fixture();
  stale.models['a-cheap'].own_eval = { 'social-photo': { evaluated_at: '2026-06-01', votes: 30, win_rate: 0.9, mean_score: 4.9 } };
  assert.equal(routeMediaGeneration(stale, baseRequest, ctx()).selected[0].model_id, 'a-photo');
});

test('SPEC-003 AC-04 changing only registry data changes the pick', () => {
  const swapped = fixture();
  swapped.profiles['social-photo'].models = ['a-cheap', 'a-photo', 'b-poster'];
  assert.equal(routeMediaGeneration(fixture(), baseRequest, ctx()).selected[0].model_id, 'a-photo');
  assert.equal(routeMediaGeneration(swapped, baseRequest, ctx()).selected[0].model_id, 'a-cheap');
});

test('SPEC-003 AC-04 compare prefers distinct providers and provider-priced models reserve 2x', () => {
  const result = routeMediaGeneration(fixture(), { ...baseRequest, privacy_class: 'public', mode: 'compare', n_models: 2 }, ctx());
  assert.deepEqual(result.selected.map((s) => s.model_id), ['a-photo', 'b-poster']);
  assert.deepEqual(result.fallbacks, []);
  assert.equal(result.selected[1].reserved_usd, 0.1);
});

test('SPEC-003 AC-04 explicit models skip the profile and keep caller order', () => {
  const result = routeMediaGeneration(fixture(), { ...baseRequest, profile: undefined, models: ['a-cheap'] }, ctx());
  assert.deepEqual(result.selected.map((s) => s.model_id), ['a-cheap']);
  assert.deepEqual(result.fallbacks, []);
});

test('SPEC-003 AC-04 n multiplies the image reservation', () => {
  const result = routeMediaGeneration(fixture(), { ...baseRequest, n: 3 }, ctx());
  assert.equal(result.selected[0].units, 3);
  assert.equal(result.selected[0].reserved_usd, 0.12);
});

test('SPEC-003 AC-05 malformed capabilities and param maps are problems, not crashes', () => {
  const cases: Array<[string, (r: MediaGenerationRegistry) => void]> = [
    ['no capabilities', (r) => { delete (r.models['a-photo'] as Partial<MediaGenerationRegistry['models'][string]>).capabilities; }],
    ['aspects not array', (r) => { (r.models['a-photo'].capabilities as { aspects: unknown }).aspects = '1:1'; }],
    ['no param_map', (r) => { delete (r.models['a-photo'] as Partial<MediaGenerationRegistry['models'][string]>).param_map; }],
    ['seconds not array', (r) => { (r.models['a-photo'].capabilities as { seconds: unknown }).seconds = 5; }],
  ];
  for (const [name, mutate] of cases) {
    const registry = fixture();
    mutate(registry);
    const { problems } = validateMediaGenerationRegistry(registry);
    assert.ok(problems.some((p) => /a-photo.*(capabilities|param_map)/.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('SPEC-003 AC-04 video uses the profile default seconds when the request has none', () => {
  const registry = fixture();
  registry.models['v-clip'] = {
    provider: 'vendor-a', provider_model: 'clip-1', kind: 'video', enabled: true,
    capabilities: { aspects: ['9:16'], resolutions: ['standard'], seconds: [5, 10], references: 0 },
    param_map: { aspect: { '9:16': { size: '720x1280' } }, resolution: { standard: {} } },
    extra_params: {},
    pricing: { unit: 'second', cost_source: 'registry', cancel_policy: 'charged', usd: { '9:16|standard': 0.1 }, source: 'https://vendor-a.example/pricing', checked_at: '2026-11-11' },
    own_eval: null,
  };
  registry.profiles['short-clip'] = { kind: 'video', defaults: { aspect: '9:16', seconds: 5 }, models: ['v-clip'] };
  const result = routeMediaGeneration(registry, { kind: 'video', mode: 'single', profile: 'short-clip', aspect: '9:16', privacy_class: 'internal' }, ctx());
  assert.deepEqual(result.selected.map((s) => s.model_id), ['v-clip']);
  assert.equal(result.selected[0].units, 5);
  assert.equal(result.selected[0].reserved_usd, 0.5);
});

test('SPEC-003 AC-05 every nested field is shape-checked', () => {
  type M = MediaGenerationRegistry;
  const cases: Array<[string, (r: M) => void, RegExp]> = [
    ['usd array', (r) => { (r.models['a-photo'].pricing as { usd: unknown }).usd = [0.04]; }, /a-photo.*pricing\.usd/],
    ['usd string', (r) => { (r.models['a-photo'].pricing as { usd: unknown }).usd = 'free'; }, /a-photo.*pricing\.usd/],
    ['defaults missing', (r) => { delete (r.profiles['social-photo'] as { defaults?: unknown }).defaults; }, /social-photo.*defaults/],
    ['defaults seconds string', (r) => { (r.profiles['social-photo'].defaults as { seconds: unknown }).seconds = '5'; }, /social-photo.*defaults/],
    ['profile models not array', (r) => { (r.profiles['social-photo'] as { models: unknown }).models = 'a-photo'; }, /social-photo.*models/],
    ['param_map entry string', (r) => { (r.models['a-photo'].param_map.aspect as Record<string, unknown>)['1:1'] = 'x'; }, /a-photo.*param_map\.aspect.*1:1/],
    ['param_map entry array', (r) => { (r.models['a-photo'].param_map.resolution as Record<string, unknown>).standard = [1]; }, /a-photo.*param_map\.resolution.*standard/],
    ['extra_params bad type', (r) => { (r.models['a-photo'].extra_params.seed as { type: unknown }).type = 'blob'; }, /a-photo.*extra_params.*seed/],
    ['own_eval bad', (r) => { (r.models['a-photo'] as { own_eval: unknown }).own_eval = 'great'; }, /a-photo.*own_eval/],
    ['output_hosts not array', (r) => { (r.providers['vendor-a'] as { output_hosts: unknown }).output_hosts = 'x'; }, /vendor-a.*output_hosts/],
    ['providers not object', (r) => { (r as { providers: unknown }).providers = []; }, /providers/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const registry = fixture();
    mutate(registry);
    let problems: string[] = [];
    assert.doesNotThrow(() => { problems = validateMediaGenerationRegistry(registry).problems; }, name);
    assert.ok(problems.some((p) => pattern.test(p)), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('DoD N7 an enabled model needs a real provider_model and at least one price', () => {
  const placeholder = fixture();
  placeholder.models['a-photo'].provider_model = 'set-on-setup-day';
  assert.ok(validateMediaGenerationRegistry(placeholder).problems.some((p) => /a-photo.*provider_model/.test(p)));
  const unpriced = fixture();
  unpriced.models['a-photo'].pricing.usd = {};
  unpriced.models['a-photo'].pricing.source = '';
  unpriced.models['a-photo'].pricing.checked_at = '';
  assert.ok(validateMediaGenerationRegistry(unpriced).problems.some((p) => /a-photo.*no prices/.test(p)));
  const disabled = fixture();
  disabled.models['a-photo'].enabled = false;
  disabled.models['a-photo'].provider_model = 'set-on-setup-day';
  assert.deepEqual(validateMediaGenerationRegistry(disabled).problems, [], 'disabled placeholders are fine');
});

test('policy.max_prompt_chars, when present, must be a positive integer', () => {
  for (const bad of [0, -1, 1.5, '1000']) {
    const r = fixture();
    (r.policy as Record<string, unknown>).max_prompt_chars = bad;
    assert.ok(validateMediaGenerationRegistry(r).problems.some((p) => /max_prompt_chars/.test(p)), String(bad));
  }
  const ok = fixture();
  ok.policy.max_prompt_chars = 1000;
  assert.deepEqual(validateMediaGenerationRegistry(ok).problems.filter((p) => /max_prompt_chars/.test(p)), []);
});

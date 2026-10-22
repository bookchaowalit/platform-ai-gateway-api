import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MEDIA_ROUTING_REGISTRY,
  decideMediaRoute,
  MediaRouteError,
  parseMediaRouteInput,
  type MediaRoutingRegistry,
} from '../api/media_router.js';

const ALL_KEYS: NodeJS.ProcessEnv = {
  SPEECHMATICS_API_KEY: 'x',
  AZURE_SPEECH_KEY: 'x',
  ELEVENLABS_API_KEY: 'x',
  GLADIA_API_KEY: 'x',
  ASSEMBLYAI_API_KEY: 'x',
  DEEPGRAM_API_KEY: 'x',
};
const NOW = new Date('2026-10-08T00:00:00Z');

function registryWith(mutate: (registry: MediaRoutingRegistry) => void): MediaRoutingRegistry {
  const copy = structuredClone(DEFAULT_MEDIA_ROUTING_REGISTRY);
  mutate(copy);
  return copy;
}

test('registry routes reference known providers that support the route language', () => {
  const registry = DEFAULT_MEDIA_ROUTING_REGISTRY;
  for (const [language, ids] of Object.entries(registry.stt_routes)) {
    assert.ok(ids.length > 0, `${language} has candidates`);
    for (const id of ids) {
      const provider = registry.providers[id];
      assert.ok(provider, `${id} exists`);
      assert.ok(provider.languages.includes(language as any), `${id} supports ${language}`);
      assert.match(provider.credential_env, /^[A-Z][A-Z0-9_]+$/);
    }
  }
  for (const kind of Object.values(registry.content_kinds)) {
    assert.ok(registry.summary_profiles[kind.summary_profile], `${kind.summary_profile} exists`);
  }
});

test('Teams recording in Recordings folder routes to a diarized meeting', () => {
  const decision = decideMediaRoute(
    { file_name: 'NCB Fix Data-20260727_163204-Meeting Recording.mp4', folder_path: '/Recordings', duration_seconds: 3600 },
    { env: ALL_KEYS, now: NOW },
  );
  assert.equal(decision.status, 'routed');
  assert.equal(decision.content_kind.value, 'meeting');
  assert.equal(decision.language.value, 'unknown');
  assert.equal(decision.stt?.language_route, 'mixed');
  assert.equal(decision.stt?.options.language_detection, true);
  assert.equal(decision.stt?.options.diarization, true);
  assert.equal(decision.summary?.profile, 'meeting-minutes');
});

test('file tags and folders decide kind and language', () => {
  const edit = decideMediaRoute({ file_name: 'vlog take 3 [edit] [en].mp4' }, { env: ALL_KEYS, now: NOW });
  assert.equal(edit.content_kind.value, 'video_edit');
  assert.equal(edit.language.value, 'en');
  assert.equal(edit.stt?.provider_id, 'elevenlabs-scribe-v2');
  assert.equal(edit.stt?.options.language_code, 'en');
  assert.equal(edit.summary?.profile, 'edit-decision-list');

  const clip = decideMediaRoute({ file_name: 'รีวิวสินค้า.mp4', folder_path: 'Transcribe/Content' }, { env: ALL_KEYS, now: NOW });
  assert.equal(clip.content_kind.value, 'video_content');
  assert.equal(clip.language.value, 'th');
  assert.equal(clip.stt?.provider_id, 'speechmatics-enhanced');
});

test('unconfigured providers are skipped and a missing route fails closed', () => {
  const partial = decideMediaRoute({ file_name: 'a [clip] [th].mp4' }, { env: { ELEVENLABS_API_KEY: 'x' }, now: NOW });
  assert.equal(partial.stt?.provider_id, 'elevenlabs-scribe-v2');
  assert.ok(partial.stt?.skipped.some(item => item.provider_id === 'speechmatics-enhanced' && /not set/.test(item.reason)));

  const none = decideMediaRoute({ file_name: 'a [clip] [th].mp4' }, { env: {}, now: NOW });
  assert.equal(none.status, 'blocked');
  assert.equal(none.stt, null);
});

test('fresh own_eval WER overrides candidate order; stale results only warn', () => {
  const fresh = registryWith(registry => {
    registry.providers['gladia'].own_eval = { evaluated_at: '2026-10-01', sample_count: 5, wer_pct: { th: 5.1 } };
  });
  const decision = decideMediaRoute({ file_name: 'x [clip] [th].mp4' }, { env: ALL_KEYS, now: NOW, registry: fresh });
  assert.equal(decision.stt?.provider_id, 'gladia');
  assert.equal(decision.stt?.selected_by, 'own_eval');

  const stale = registryWith(registry => {
    registry.providers['gladia'].own_eval = { evaluated_at: '2026-01-01', sample_count: 5, wer_pct: { th: 5.1 } };
  });
  const staleDecision = decideMediaRoute({ file_name: 'x [clip] [th].mp4' }, { env: ALL_KEYS, now: NOW, registry: stale });
  assert.equal(staleDecision.stt?.provider_id, 'speechmatics-enhanced');
  assert.ok(staleDecision.warnings.some(warning => /gladia own_eval is \d+ days old/.test(warning)));
});

test('private media never routes to an external provider', () => {
  const decision = decideMediaRoute({ file_name: 'board [meeting].mp4', privacy_class: 'private' }, { env: ALL_KEYS, now: NOW });
  assert.equal(decision.status, 'blocked');
  assert.match(decision.blocked_reason || '', /private/);
});

test('low-confidence classification is flagged for review', () => {
  const decision = decideMediaRoute({ file_name: 'IMG_0042.mp4' }, { env: ALL_KEYS, now: NOW });
  assert.equal(decision.needs_review, true);
  assert.equal(decision.content_kind.confidence < 0.6, true);
});

test('input parsing rejects unsafe or invalid fields', () => {
  assert.throws(() => parseMediaRouteInput({}), MediaRouteError);
  assert.throws(() => parseMediaRouteInput({ file_name: 'a\nb.mp4' }), MediaRouteError);
  assert.throws(() => parseMediaRouteInput({ file_name: 'a.mp4', duration_seconds: -1 }), MediaRouteError);
  assert.throws(() => parseMediaRouteInput({ file_name: 'a.mp4', hints: { language: 'fr' } }), MediaRouteError);
  assert.deepEqual(parseMediaRouteInput({ file_name: 'a.mp4', hints: { content_kind: 'meeting' } }), {
    file_name: 'a.mp4',
    hints: { content_kind: 'meeting' },
  });
});

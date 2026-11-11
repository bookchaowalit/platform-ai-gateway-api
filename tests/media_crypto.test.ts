// SPEC-003 §4.4 encrypted payloads, §4.5 signed queue messages, AC-02 / AC-10 / AC-16.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalHash,
  openPayload,
  parsePayloadKeys,
  queueMessageSignature,
  refMac,
  sealPayload,
  subjectHash,
  verifyQueueMessage,
  webhookMac,
  PayloadUnavailableError,
} from '../api/media/crypto.js';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const QUEUE_KEY = 'MARKER_queue_key_for_tests_only_32b';

test('SPEC-003 §4.4 payload keys parse and fail closed', () => {
  const keys = parsePayloadKeys(JSON.stringify({ current: 'k2', keys: { k1: K1, k2: K2 } }));
  assert.equal(keys.ok, true);
  for (const bad of [
    'not json',
    JSON.stringify({ current: 'k3', keys: { k1: K1 } }),
    JSON.stringify({ current: 'k1', keys: { k1: Buffer.alloc(16).toString('base64') } }),
    JSON.stringify({ current: 'k1', keys: [] }),
    '',
  ]) {
    const parsed = parsePayloadKeys(bad);
    assert.equal(parsed.ok, false, bad);
    if (!parsed.ok) assert.doesNotMatch(parsed.problem, /AQEB|Ag==/, 'problem carries no key material');
  }
});

test('SPEC-003 §4.4 payload round trip, unique nonces, bound to the request id', async () => {
  const parsed = parsePayloadKeys(JSON.stringify({ current: 'k1', keys: { k1: K1 } }));
  assert.ok(parsed.ok);
  const payload = { prompt: 'a red square on white', params: { seed: 7 } };
  const a = await sealPayload(parsed.keys, 'req-1', payload);
  const b = await sealPayload(parsed.keys, 'req-1', payload);
  assert.notEqual(a.nonce, b.nonce);
  assert.equal(a.key_id, 'k1');
  assert.ok(!Buffer.from(a.ciphertext).toString('utf8').includes('red square'));
  assert.deepEqual(await openPayload(parsed.keys, 'req-1', a), payload);
  await assert.rejects(openPayload(parsed.keys, 'req-2', a), PayloadUnavailableError);
});

test('SPEC-003 §4.4 rotation: old key id still opens, unknown key id fails closed', async () => {
  const old = parsePayloadKeys(JSON.stringify({ current: 'k1', keys: { k1: K1 } }));
  const rotated = parsePayloadKeys(JSON.stringify({ current: 'k2', keys: { k1: K1, k2: K2 } }));
  const retired = parsePayloadKeys(JSON.stringify({ current: 'k2', keys: { k2: K2 } }));
  assert.ok(old.ok && rotated.ok && retired.ok);
  const sealed = await sealPayload(old.keys, 'req-1', { prompt: 'x' });
  assert.deepEqual(await openPayload(rotated.keys, 'req-1', sealed), { prompt: 'x' });
  assert.equal((await sealPayload(rotated.keys, 'req-1', { prompt: 'y' })).key_id, 'k2');
  await assert.rejects(openPayload(retired.keys, 'req-1', sealed), PayloadUnavailableError);
});

test('SPEC-003 §4.5 queue message signatures cover every field', async () => {
  const message = { v: 1 as const, attempt_id: 'att-1', dispatch_no: 'd-1', reason: 'start' as const };
  const sig = await queueMessageSignature(QUEUE_KEY, message);
  assert.equal(await verifyQueueMessage(QUEUE_KEY, { ...message, sig }), true);
  for (const tampered of [
    { ...message, attempt_id: 'att-2', sig },
    { ...message, dispatch_no: 'd-2', sig },
    { ...message, reason: 'poll' as const, sig },
    { ...message, ref_mac: 'x', sig },
    { ...message, sig: sig.replace(/^./, sig[0] === 'A' ? 'B' : 'A') },
    { ...message, sig: '' },
  ]) {
    assert.equal(await verifyQueueMessage(QUEUE_KEY, tampered), false, JSON.stringify(tampered));
  }
  assert.equal(await verifyQueueMessage('another-key-another-key-another!', { ...message, sig }), false);
  const webhook = { ...message, reason: 'webhook' as const, ref_mac: await refMac(QUEUE_KEY, 'job_123') };
  const webhookSig = await queueMessageSignature(QUEUE_KEY, webhook);
  assert.equal(await verifyQueueMessage(QUEUE_KEY, { ...webhook, sig: webhookSig }), true);
});

test('SPEC-003 AC-10 webhook and ref macs are distinct and stable', async () => {
  assert.equal(await webhookMac(QUEUE_KEY, 'att-1', 'd-1'), await webhookMac(QUEUE_KEY, 'att-1', 'd-1'));
  assert.notEqual(await webhookMac(QUEUE_KEY, 'att-1', 'd-1'), await webhookMac(QUEUE_KEY, 'att-1', 'd-2'));
  assert.notEqual(await refMac(QUEUE_KEY, 'att-1'), await webhookMac(QUEUE_KEY, 'att-1', ''));
});

test('SPEC-003 §4.5 subject hash hides the subject and canonical hash ignores key order', async () => {
  const hash = await subjectHash('MARKER_subject_hash_key', 'client-a');
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.ok(!hash.includes('client'));
  assert.notEqual(hash, await subjectHash('MARKER_subject_hash_key', 'client-b'));
  assert.equal(await canonicalHash({ b: 1, a: { d: [1, 2], c: 'x' } }), await canonicalHash({ a: { c: 'x', d: [1, 2] }, b: 1 }));
  assert.notEqual(await canonicalHash({ a: [1, 2] }), await canonicalHash({ a: [2, 1] }));
});

test('SPEC-003 §4.5 macs are length-prefixed and messages are format-checked before verifying', async () => {
  const { queueMessageSignature: sign, verifyQueueMessage: verify } = await import('../api/media/crypto.js');
  const a = { v: 1 as const, attempt_id: 'att\u001fx', dispatch_no: 'd', reason: 'start' as const };
  const b = { v: 1 as const, attempt_id: 'att', dispatch_no: 'x\u001fd', reason: 'start' as const };
  assert.notEqual(await sign(QUEUE_KEY, a), await sign(QUEUE_KEY, b));
  const good = { v: 1 as const, attempt_id: 'att_1', dispatch_no: 'd_1', reason: 'start' as const };
  const sig = await sign(QUEUE_KEY, good);
  for (const bad of [
    { ...good, v: 2, sig },
    { ...good, reason: 'other', sig },
    { ...good, attempt_id: 'has space', sig },
    { ...good, attempt_id: 7, sig },
    { ...good, ref_mac: 5, sig },
  ]) {
    assert.equal(await verify(QUEUE_KEY, bad as never), false, JSON.stringify(bad));
  }
});

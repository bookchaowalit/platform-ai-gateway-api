import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAiRateLimiter, aiRateLimitHeaders } from '../api/ai_rate_limit.js';

test('AI rate limiter enforces per-subject request windows and expires counters', () => {
  const limiter = createAiRateLimiter({
    AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: '2',
    AI_GATEWAY_MAX_CONCURRENT_REQUESTS: '10',
  });

  const first = limiter.acquire('agent-a', 0);
  const second = limiter.acquire('agent-a', 0);
  const blocked = limiter.acquire('agent-a', 0);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'rate_limited');
  assert.equal(blocked.retryAfterSeconds, 60);
  assert.equal(aiRateLimitHeaders(blocked)['Retry-After'], '60');

  first.release();
  second.release();
  const afterWindow = limiter.acquire('agent-a', 60_000);
  assert.equal(afterWindow.allowed, true);
  assert.equal(afterWindow.remaining, 1);
  afterWindow.release();
});

test('AI rate limiter enforces global concurrency and releases idempotently', () => {
  const limiter = createAiRateLimiter({
    AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: '30',
    AI_GATEWAY_MAX_CONCURRENT_REQUESTS: '1',
  });

  const first = limiter.acquire('agent-a', 1_000);
  const blocked = limiter.acquire('agent-b', 1_000);
  assert.equal(first.allowed, true);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'concurrency_limited');
  assert.equal(blocked.retryAfterSeconds, 1);
  assert.equal(blocked.activeRequests, 1);
  assert.equal(aiRateLimitHeaders(blocked)['X-RateLimit-Concurrent-Limit'], '1');

  first.release();
  first.release();
  const admitted = limiter.acquire('agent-b', 1_000);
  assert.equal(admitted.allowed, true);
  assert.equal(limiter.status().active_requests, 1);
  admitted.release();
  assert.equal(limiter.status().active_requests, 0);
});

test('AI rate limiter fails closed for invalid configuration and bounds tracked subjects', () => {
  const invalid = createAiRateLimiter({ AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: 'not-a-number' });
  const denied = invalid.acquire('agent-a', 0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'configuration_error');
  assert.match(invalid.status().configuration_error || '', /MAX_REQUESTS_PER_MINUTE/);

  const limiter = createAiRateLimiter({
    AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: '1',
    AI_GATEWAY_MAX_CONCURRENT_REQUESTS: '1',
  });
  for (let index = 0; index < 10_050; index += 1) {
    const permit = limiter.acquire(`agent-${index}`, index);
    permit.release();
  }
  assert.ok(limiter.status().tracked_subjects <= 10_000);
});

test('AI rate limiter applies per-subject overrides on top of the global cap', () => {
  const limiter = createAiRateLimiter({
    AI_GATEWAY_MAX_REQUESTS_PER_MINUTE: '120',
    AI_GATEWAY_MAX_CONCURRENT_REQUESTS: '8',
    AI_GATEWAY_SUBJECT_LIMITS_JSON: JSON.stringify({ 'ev3-web': { max_requests_per_minute: 3, max_concurrent_requests: 2 } }),
  });
  const first = limiter.acquire('ev3-web', 0);
  const second = limiter.acquire('ev3-web', 0);
  const concurrent = limiter.acquire('ev3-web', 0);
  assert.equal(first.allowed && second.allowed, true);
  assert.equal(concurrent.reason, 'concurrency_limited');
  assert.equal(concurrent.maxConcurrentRequests, 2);
  const other = limiter.acquire('other-app', 0);
  assert.equal(other.allowed, true);
  assert.equal(other.limit, 120);
  first.release();
  const windowExhausted = limiter.acquire('ev3-web', 0);
  assert.equal(windowExhausted.reason, 'rate_limited');
  assert.equal(windowExhausted.limit, 3);
  second.release();
  other.release();
  assert.equal(limiter.status().subject_overrides, 1);
  assert.equal(limiter.status().active_requests, 0);

  const invalid = createAiRateLimiter({ AI_GATEWAY_SUBJECT_LIMITS_JSON: '{"ev3-web":{"max_requests_per_minute":0}}' });
  assert.equal(invalid.acquire('ev3-web', 0).reason, 'configuration_error');
  assert.match(invalid.status().configuration_error || '', /SUBJECT_LIMITS_JSON/);
});

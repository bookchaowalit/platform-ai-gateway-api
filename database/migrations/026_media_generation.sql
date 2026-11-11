-- SPEC-003 §4.4 media generation state. Runs on every start after 025: CREATE ... IF NOT EXISTS only, never ALTER.
-- No prompt text outside media_request_payloads, which holds AES-256-GCM ciphertext only.

CREATE TABLE IF NOT EXISTS media_requests (
    id TEXT PRIMARY KEY,
    subject_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    mode TEXT NOT NULL CHECK (mode IN ('single', 'compare')),
    blind INTEGER NOT NULL DEFAULT 0 CHECK (blind IN (0, 1)),
    profile TEXT,
    route TEXT NOT NULL,
    status TEXT NOT NULL,
    reserved_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
    settled_usd REAL NOT NULL DEFAULT 0 CHECK (settled_usd >= 0),
    prompt_sha256 TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_media_requests_subject_status ON media_requests(subject_key, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_requests_idempotency
    ON media_requests(subject_key, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_requests_created ON media_requests(created_at);

CREATE TABLE IF NOT EXISTS media_request_payloads (
    request_id TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    nonce TEXT NOT NULL UNIQUE,
    key_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    purge_after TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_payloads_purge ON media_request_payloads(purge_after);

CREATE TABLE IF NOT EXISTS media_attempts (
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    attempt_no INTEGER NOT NULL DEFAULT 1,
    model_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    status TEXT NOT NULL,
    dispatch_state TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_state IN ('pending', 'sent')),
    dispatch_tries INTEGER NOT NULL DEFAULT 0,
    dispatch_no TEXT NOT NULL,
    next_dispatch_at TEXT,
    first_leased_at TEXT,
    lease_recoveries INTEGER NOT NULL DEFAULT 0,
    poll_count INTEGER NOT NULL DEFAULT 0,
    submit_started_at TEXT,
    lease_id TEXT,
    lease_deadline TEXT,
    lease_started_at TEXT,
    report_seq INTEGER NOT NULL DEFAULT 0,
    provider_job_ref TEXT,
    units REAL NOT NULL,
    unit_price_usd REAL NOT NULL,
    reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    overspend_usd REAL NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]',
    cancel_requested_at TEXT,
    error_code TEXT,
    latency_ms REAL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_media_attempts_request ON media_attempts(request_id);
CREATE INDEX IF NOT EXISTS idx_media_attempts_subject_status ON media_attempts(subject_key, status);
CREATE INDEX IF NOT EXISTS idx_media_attempts_status_updated ON media_attempts(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_media_attempts_dispatch ON media_attempts(dispatch_state, next_dispatch_at);
CREATE INDEX IF NOT EXISTS idx_media_attempts_provider_status ON media_attempts(provider_id, status);

CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    subject_key TEXT NOT NULL,
    attempt_id TEXT,
    parent_asset_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('output', 'reference', 'variant')),
    state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('pending_upload', 'ready', 'expired')),
    upload_expires_at TEXT,
    staging_key TEXT,
    etag TEXT,
    object_key TEXT NOT NULL,
    media_type TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0 CHECK (bytes >= 0),
    width INTEGER,
    height INTEGER,
    seconds REAL,
    sha256 TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expired_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_assets_attempt ON media_assets(attempt_id);
CREATE INDEX IF NOT EXISTS idx_media_assets_subject ON media_assets(subject_key, role);

CREATE TABLE IF NOT EXISTS media_votes (
    request_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    voter_label TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL CHECK (source IN ('api', 'mcp', 'judge')),
    judge_id TEXT NOT NULL DEFAULT '',
    judge_attempt_id TEXT NOT NULL DEFAULT '',
    winner_attempt_id TEXT,
    scores_json TEXT NOT NULL DEFAULT '{}',
    tags_json TEXT NOT NULL DEFAULT '[]',
    note TEXT CHECK (note IS NULL OR length(note) <= 500),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (request_id, subject, voter_label, source, judge_attempt_id, judge_id)
);

CREATE TABLE IF NOT EXISTS media_provider_slots (
    provider_id TEXT NOT NULL,
    lease_id TEXT NOT NULL PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    deadline TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_slots_provider ON media_provider_slots(provider_id);

CREATE TABLE IF NOT EXISTS media_provider_calls (
    provider_id TEXT NOT NULL,
    called_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_provider_calls ON media_provider_calls(provider_id, called_at);

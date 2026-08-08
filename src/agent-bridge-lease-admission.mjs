import { createHash } from 'node:crypto';

const MAX_IDENTIFIER = 128;
const MAX_PATHS = 128;
const MAX_PATH_LENGTH = 512;
const MAX_RECEIPT_BYTES = 16 * 1024;

const INTENT_KEYS = new Set([
  'schema_version',
  'message_id',
  'bridge_channel',
  'bridge_sequence',
  'job_id',
  'agent_key',
  'repository',
  'paths',
  'operation',
  'payload_sha256',
  'lease_id',
  'fencing_token',
  'lease_expires_ms',
]);

const AUTHORITY_KEYS = new Set([
  'schema_version',
  'committed',
  'found',
  'snapshot_revision',
  'lease_id',
  'agent_key',
  'repository',
  'paths',
  'fencing_token',
  'lease_expires_ms',
]);

const OPERATIONS = new Set([
  'repository.write',
  'repository.commit',
  'repository.pull-request',
]);

export class AgentBridgeLeaseAdmission {
  constructor({ now = () => Date.now() } = {}) {
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    this.now = now;
    this.fingerprintsByMessage = new Map();
    this.receiptsByMessage = new Map();
    this.lastSequenceByChannel = new Map();
    this.admittedEffects = 0;
  }

  evaluate({ intent, authority }) {
    const nowMs = requirePositiveSafeInteger(this.now(), 'now');
    let canonicalIntent;
    try {
      canonicalIntent = canonicalizeIntent(intent);
    } catch (error) {
      return rejectionReceipt({ code: error.code ?? 'invalid-intent', nowMs });
    }

    const fingerprint = sha256(stableJson(canonicalIntent));
    const priorFingerprint = this.fingerprintsByMessage.get(canonicalIntent.message_id);
    if (priorFingerprint && priorFingerprint !== fingerprint) {
      return rejectionReceipt({
        code: 'message-replay-conflict',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }
    if (!priorFingerprint) {
      this.fingerprintsByMessage.set(canonicalIntent.message_id, fingerprint);
    }

    const prior = this.receiptsByMessage.get(canonicalIntent.message_id);
    if (prior) {
      return freezeReceipt({
        ...prior,
        replayed: true,
        side_effect_permitted: false,
      });
    }

    let canonicalAuthority;
    try {
      canonicalAuthority = canonicalizeAuthority(authority);
    } catch (error) {
      return rejectionReceipt({
        code: error.code ?? 'invalid-authority',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }

    const denial = denyReason(canonicalIntent, canonicalAuthority, nowMs);
    if (denial) {
      return rejectionReceipt({
        code: denial,
        nowMs,
        intent: canonicalIntent,
        fingerprint,
        authorityRevision: canonicalAuthority.snapshot_revision,
      });
    }

    const lastSequence = this.lastSequenceByChannel.get(canonicalIntent.bridge_channel) ?? 0;
    if (canonicalIntent.bridge_sequence <= lastSequence) {
      return rejectionReceipt({
        code: 'bridge-sequence-stale',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
        authorityRevision: canonicalAuthority.snapshot_revision,
      });
    }

    const receipt = freezeReceipt({
      schema_version: 1,
      decision: 'admitted',
      code: 'admitted',
      receipt_id: sha256(`admitted\0${fingerprint}\0${canonicalAuthority.snapshot_revision}`),
      intent_fingerprint: fingerprint,
      message_id: canonicalIntent.message_id,
      bridge_channel: canonicalIntent.bridge_channel,
      bridge_sequence: canonicalIntent.bridge_sequence,
      job_id: canonicalIntent.job_id,
      agent_key: canonicalIntent.agent_key,
      repository: canonicalIntent.repository,
      paths: canonicalIntent.paths,
      operation: canonicalIntent.operation,
      lease_id: canonicalIntent.lease_id,
      fencing_token: canonicalIntent.fencing_token,
      lease_expires_ms: canonicalIntent.lease_expires_ms,
      authority_revision: canonicalAuthority.snapshot_revision,
      evaluated_at_ms: nowMs,
      replayed: false,
      side_effect_permitted: true,
    });

    this.receiptsByMessage.set(canonicalIntent.message_id, receipt);
    this.lastSequenceByChannel.set(canonicalIntent.bridge_channel, canonicalIntent.bridge_sequence);
    this.admittedEffects += 1;
    return receipt;
  }

  effectCount() {
    return this.admittedEffects;
  }
}

function canonicalizeIntent(value) {
  requirePlainObject(value, 'intent');
  requireExactKeys(value, INTENT_KEYS, 'intent');
  if (value.schema_version !== 1) fail('unsupported-intent-version');
  return Object.freeze({
    schema_version: 1,
    message_id: requireIdentifier(value.message_id, 'message_id'),
    bridge_channel: requireIdentifier(value.bridge_channel, 'bridge_channel'),
    bridge_sequence: requirePositiveSafeInteger(value.bridge_sequence, 'bridge_sequence'),
    job_id: requireIdentifier(value.job_id, 'job_id'),
    agent_key: requireIdentifier(value.agent_key, 'agent_key'),
    repository: canonicalRepository(value.repository),
    paths: canonicalPaths(value.paths),
    operation: requireOperation(value.operation),
    payload_sha256: requireSha256(value.payload_sha256),
    lease_id: requireIdentifier(value.lease_id, 'lease_id'),
    fencing_token: requirePositiveSafeInteger(value.fencing_token, 'fencing_token'),
    lease_expires_ms: requirePositiveSafeInteger(value.lease_expires_ms, 'lease_expires_ms'),
  });
}

function canonicalizeAuthority(value) {
  requirePlainObject(value, 'authority');
  requireExactKeys(value, AUTHORITY_KEYS, 'authority');
  if (value.schema_version !== 1) fail('unsupported-authority-version');
  if (value.committed !== true) fail('authority-not-committed');
  if (value.found !== true) fail('authority-not-found');
  return Object.freeze({
    schema_version: 1,
    committed: true,
    found: true,
    snapshot_revision: requirePositiveSafeInteger(value.snapshot_revision, 'snapshot_revision'),
    lease_id: requireIdentifier(value.lease_id, 'lease_id'),
    agent_key: requireIdentifier(value.agent_key, 'agent_key'),
    repository: canonicalRepository(value.repository),
    paths: canonicalPaths(value.paths),
    fencing_token: requirePositiveSafeInteger(value.fencing_token, 'fencing_token'),
    lease_expires_ms: requirePositiveSafeInteger(value.lease_expires_ms, 'lease_expires_ms'),
  });
}

function denyReason(intent, authority, nowMs) {
  if (authority.lease_expires_ms <= nowMs || intent.lease_expires_ms <= nowMs) {
    return 'authority-expired';
  }
  if (intent.repository !== authority.repository) return 'repository-mismatch';
  if (stableJson(intent.paths) !== stableJson(authority.paths)) return 'path-union-mismatch';
  if (intent.agent_key !== authority.agent_key) return 'agent-mismatch';
  if (intent.lease_id !== authority.lease_id) return 'lease-id-mismatch';
  if (intent.fencing_token !== authority.fencing_token) return 'fencing-token-mismatch';
  if (intent.lease_expires_ms !== authority.lease_expires_ms) return 'lease-expiry-mismatch';
  return null;
}

function rejectionReceipt({
  code,
  nowMs,
  intent = null,
  fingerprint = null,
  authorityRevision = null,
}) {
  const safeCode = requireCode(code);
  const identity = intent
    ? `${intent.message_id}\0${fingerprint}\0${safeCode}\0${authorityRevision ?? 0}`
    : `unknown\0${safeCode}`;
  return freezeReceipt({
    schema_version: 1,
    decision: 'rejected',
    code: safeCode,
    receipt_id: sha256(`rejected\0${identity}`),
    intent_fingerprint: fingerprint,
    message_id: intent?.message_id ?? null,
    bridge_channel: intent?.bridge_channel ?? null,
    bridge_sequence: intent?.bridge_sequence ?? null,
    job_id: intent?.job_id ?? null,
    agent_key: intent?.agent_key ?? null,
    repository: intent?.repository ?? null,
    paths: intent?.paths ?? Object.freeze([]),
    operation: intent?.operation ?? null,
    lease_id: intent?.lease_id ?? null,
    fencing_token: intent?.fencing_token ?? null,
    lease_expires_ms: intent?.lease_expires_ms ?? null,
    authority_revision: authorityRevision,
    evaluated_at_ms: nowMs,
    replayed: false,
    side_effect_permitted: false,
  });
}

function freezeReceipt(receipt) {
  const frozen = Object.freeze({
    ...receipt,
    paths: Object.freeze([...(receipt.paths ?? [])]),
  });
  const bytes = Buffer.byteLength(stableJson(frozen));
  if (bytes > MAX_RECEIPT_BYTES) {
    throw new Error('internal receipt exceeded the bounded evidence size');
  }
  return frozen;
}

function canonicalRepository(value) {
  if (typeof value !== 'string' || value.length > 256 || value !== value.trim()) {
    fail('invalid-repository');
  }
  const parts = value.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(part))) {
    fail('invalid-repository');
  }
  if (parts[1].toLowerCase().endsWith('.git')) fail('invalid-repository');
  return parts.join('/').toLowerCase();
}

function canonicalPaths(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) {
    fail('invalid-path-union');
  }
  const normalized = [];
  for (const path of value) {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.length > MAX_PATH_LENGTH ||
      path !== path.trim() ||
      path.startsWith('/') ||
      path.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(path)
    ) {
      fail('invalid-path');
    }
    const parts = path.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) fail('invalid-path');
    normalized.push(path);
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function requireOperation(value) {
  if (!OPERATIONS.has(value)) fail('invalid-operation');
  return value;
}

function requireSha256(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail('invalid-payload-digest');
  return value;
}

function requireIdentifier(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,127})$/u.test(value)
  ) {
    fail(`invalid-${field.replaceAll('_', '-')}`);
  }
  return value;
}

function requirePositiveSafeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid-${field.replaceAll('_', '-')}`);
  return value;
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`invalid-${name}`);
}

function requireExactKeys(value, allowed, name) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (stableJson(keys) !== stableJson(expected)) fail(`${name}-field-set-mismatch`);
}

function requireCode(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,64}$/u.test(value)) {
    throw new Error('internal rejection code is invalid');
  }
  return value;
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

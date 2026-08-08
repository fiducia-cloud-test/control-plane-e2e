import { createHash } from 'node:crypto';

const MAX_IDENTIFIER = 128;
const MAX_PATHS = 256;
const MAX_PATH_LENGTH = 800;
const MAX_RECEIPT_BYTES = 16 * 1024;
const MAX_ADAPTER_INPUT_BYTES = 64 * 1024;

const EVALUATION_KEYS = new Set(['intent', 'claim', 'authority']);

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
  'fencing_token',
  'lease_expires_ms',
]);

const CLAIM_KEYS = new Set([
  'schema_version',
  'claimed',
  'job_id',
  'agent_key',
  'repository',
  'claim_expires_ms',
]);

const AUTHORITY_KEYS = new Set([
  'schema_version',
  'committed',
  'found',
  'commitment_sha256',
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

export class AgentBridgeLeaseContractError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'AgentBridgeLeaseContractError';
    this.code = code;
  }
}

export class AgentBridgeLeaseAdmission {
  #now;
  #fingerprintsByMessage = new Map();
  #receiptsByMessage = new Map();
  #latestByChannel = new Map();
  #admittedEffects = 0;
  #maxEntries;

  constructor({ now = () => Date.now(), maxEntries = 10_000 } = {}) {
    if (typeof now !== 'function') {
      throw new TypeError('now must be a function');
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_000_000) {
      throw new TypeError('maxEntries must be a safe integer from 1 through 1000000');
    }
    this.#now = now;
    this.#maxEntries = maxEntries;
  }

  evaluate(input) {
    const nowMs = requirePositiveSafeInteger(this.#now(), 'now');
    try {
      requirePlainObject(input, 'evaluation');
      requireExactKeys(input, EVALUATION_KEYS, 'evaluation');
    } catch (error) {
      return rejectionReceipt({ code: error.code ?? 'invalid-evaluation', nowMs });
    }

    let canonicalIntent;
    try {
      canonicalIntent = canonicalizeIntent(input.intent);
    } catch (error) {
      return rejectionReceipt({ code: error.code ?? 'invalid-intent', nowMs });
    }

    const fingerprint = sha256(stableJson(canonicalIntent));
    const priorFingerprint = this.#fingerprintsByMessage.get(canonicalIntent.message_id);
    if (priorFingerprint && priorFingerprint !== fingerprint) {
      return rejectionReceipt({
        code: 'message-replay-conflict',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }

    if (!priorFingerprint) {
      const latest = this.#latestByChannel.get(canonicalIntent.bridge_channel);
      if (latest && canonicalIntent.bridge_sequence <= latest.sequence) {
        return rejectionReceipt({
          code: 'bridge-sequence-stale',
          nowMs,
          intent: canonicalIntent,
          fingerprint,
        });
      }
      if (this.#fingerprintsByMessage.size >= this.#maxEntries) {
        return rejectionReceipt({
          code: 'admission-capacity-exhausted',
          nowMs,
          intent: canonicalIntent,
          fingerprint,
        });
      }
      this.#fingerprintsByMessage.set(canonicalIntent.message_id, fingerprint);
      this.#latestByChannel.set(canonicalIntent.bridge_channel, {
        sequence: canonicalIntent.bridge_sequence,
        messageId: canonicalIntent.message_id,
      });
    }

    const prior = this.#receiptsByMessage.get(canonicalIntent.message_id);
    if (prior) {
      return freezeReceipt({
        ...prior,
        replayed: true,
        side_effect_permitted: false,
      });
    }

    const latest = this.#latestByChannel.get(canonicalIntent.bridge_channel);
    if (
      !latest ||
      latest.sequence !== canonicalIntent.bridge_sequence ||
      latest.messageId !== canonicalIntent.message_id
    ) {
      return rejectionReceipt({
        code: 'bridge-sequence-stale',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }

    let canonicalClaim;
    try {
      canonicalClaim = canonicalizeClaim(input.claim);
    } catch (error) {
      return rejectionReceipt({
        code: error.code ?? 'invalid-claim',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }

    let canonicalAuthority;
    try {
      canonicalAuthority = canonicalizeAuthority(input.authority);
    } catch (error) {
      return rejectionReceipt({
        code: error.code ?? 'invalid-authority',
        nowMs,
        intent: canonicalIntent,
        fingerprint,
      });
    }

    const denial = denyReason(canonicalIntent, canonicalClaim, canonicalAuthority, nowMs);
    if (denial) {
      return rejectionReceipt({
        code: denial,
        nowMs,
        intent: canonicalIntent,
        fingerprint,
        claimFingerprint: sha256(stableJson(canonicalClaim)),
        authorityCommitment: canonicalAuthority.commitment_sha256,
      });
    }

    const claimFingerprint = sha256(stableJson(canonicalClaim));
    const receipt = freezeReceipt({
      schema_version: 1,
      decision: 'admitted',
      code: 'admitted',
      receipt_id: sha256(
        `admitted\0${fingerprint}\0${claimFingerprint}\0${canonicalAuthority.commitment_sha256}`,
      ),
      intent_fingerprint: fingerprint,
      claim_fingerprint: claimFingerprint,
      authority_commitment_sha256: canonicalAuthority.commitment_sha256,
      message_id: canonicalIntent.message_id,
      bridge_channel: canonicalIntent.bridge_channel,
      bridge_sequence: canonicalIntent.bridge_sequence,
      job_id: canonicalIntent.job_id,
      agent_key: canonicalIntent.agent_key,
      repository: canonicalIntent.repository,
      paths: canonicalIntent.paths,
      operation: canonicalIntent.operation,
      fencing_token: canonicalIntent.fencing_token,
      lease_expires_ms: canonicalIntent.lease_expires_ms,
      claim_expires_ms: canonicalClaim.claim_expires_ms,
      evaluated_at_ms: nowMs,
      replayed: false,
      side_effect_permitted: true,
    });

    this.#receiptsByMessage.set(canonicalIntent.message_id, receipt);
    this.#admittedEffects += 1;
    return receipt;
  }

  effectCount() {
    return this.#admittedEffects;
  }
}

export function claimFromAgentPontifexJob(job) {
  requireBoundedObject(job, 'job');
  if (job.status !== 'running') fail('claim-not-active');
  if (job.claimed_by === null || job.claimed_by === undefined) fail('claim-not-active');
  const org = requireRepositoryComponent(job.org, 'job-org');
  const repo = requireRepositoryComponent(job.repo, 'job-repo');
  return Object.freeze({
    schema_version: 1,
    claimed: true,
    job_id: requireIdentifier(job.id, 'job_id'),
    agent_key: requireIdentifier(job.claimed_by, 'agent_key'),
    repository: canonicalRepository(`${org}/${repo}`),
    claim_expires_ms: requireRfc3339Millis(job.lease_expires_at, 'claim-expires-at'),
  });
}

export function authorityFromFileLeaseRead(input) {
  requirePlainObject(input, 'file-lease-read-adapter');
  requireExactKeys(
    input,
    new Set(['response', 'repository', 'paths']),
    'file-lease-read-adapter',
  );
  requireBoundedObject(input.response, 'file-lease-response');
  const response = input.response;
  if (response.status !== 200) fail('file-lease-read-status');
  if (!response.envelope || response.envelope.committed !== true) fail('authority-not-committed');
  const output = response.output;
  requirePlainObject(output, 'file-lease-output');
  if (output.found !== true) fail('authority-not-found');

  const repository = canonicalRepository(input.repository);
  const paths = canonicalPaths(input.paths);
  const expectedKeys = paths.map((path) => `git-file/${repository}/${path}`);
  const actualKeys = canonicalLeaseKeys(output.keys);
  if (stableJson(actualKeys) !== stableJson(expectedKeys)) fail('file-lease-key-mismatch');

  const normalizedAuthorityMaterial = {
    schema_version: 1,
    committed: true,
    found: true,
    agent_key: requireIdentifier(output.holder, 'agent_key'),
    repository,
    paths,
    fencing_token: requirePositiveSafeInteger(output.fencing_token, 'fencing_token'),
    lease_expires_ms: requirePositiveSafeInteger(output.lease_expires_ms, 'lease_expires_ms'),
  };
  return Object.freeze({
    ...normalizedAuthorityMaterial,
    commitment_sha256: sha256(stableJson(normalizedAuthorityMaterial)),
  });
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
    payload_sha256: requireSha256(value.payload_sha256, 'payload-digest'),
    fencing_token: requirePositiveSafeInteger(value.fencing_token, 'fencing_token'),
    lease_expires_ms: requirePositiveSafeInteger(value.lease_expires_ms, 'lease_expires_ms'),
  });
}

function canonicalizeClaim(value) {
  requirePlainObject(value, 'claim');
  requireExactKeys(value, CLAIM_KEYS, 'claim');
  if (value.schema_version !== 1) fail('unsupported-claim-version');
  if (value.claimed !== true) fail('claim-not-active');
  return Object.freeze({
    schema_version: 1,
    claimed: true,
    job_id: requireIdentifier(value.job_id, 'job_id'),
    agent_key: requireIdentifier(value.agent_key, 'agent_key'),
    repository: canonicalRepository(value.repository),
    claim_expires_ms: requirePositiveSafeInteger(value.claim_expires_ms, 'claim_expires_ms'),
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
    commitment_sha256: requireSha256(value.commitment_sha256, 'authority-commitment'),
    agent_key: requireIdentifier(value.agent_key, 'agent_key'),
    repository: canonicalRepository(value.repository),
    paths: canonicalPaths(value.paths),
    fencing_token: requirePositiveSafeInteger(value.fencing_token, 'fencing_token'),
    lease_expires_ms: requirePositiveSafeInteger(value.lease_expires_ms, 'lease_expires_ms'),
  });
}

function denyReason(intent, claim, authority, nowMs) {
  if (claim.claim_expires_ms <= nowMs) return 'claim-expired';
  if (authority.lease_expires_ms <= nowMs || intent.lease_expires_ms <= nowMs) {
    return 'authority-expired';
  }
  if (intent.job_id !== claim.job_id) return 'job-mismatch';
  if (intent.agent_key !== claim.agent_key) return 'claim-agent-mismatch';
  if (intent.repository !== claim.repository) return 'claim-repository-mismatch';
  if (intent.repository !== authority.repository) return 'repository-mismatch';
  if (stableJson(intent.paths) !== stableJson(authority.paths)) return 'path-union-mismatch';
  if (intent.agent_key !== authority.agent_key) return 'authority-agent-mismatch';
  if (intent.fencing_token !== authority.fencing_token) return 'fencing-token-mismatch';
  if (intent.lease_expires_ms !== authority.lease_expires_ms) return 'lease-expiry-mismatch';
  return null;
}

function rejectionReceipt({
  code,
  nowMs,
  intent = null,
  fingerprint = null,
  claimFingerprint = null,
  authorityCommitment = null,
}) {
  const safeCode = requireCode(code);
  const identity = intent
    ? `${intent.message_id}\0${fingerprint}\0${safeCode}\0${claimFingerprint ?? ''}\0${authorityCommitment ?? ''}`
    : `unknown\0${safeCode}`;
  return freezeReceipt({
    schema_version: 1,
    decision: 'rejected',
    code: safeCode,
    receipt_id: sha256(`rejected\0${identity}`),
    intent_fingerprint: fingerprint,
    claim_fingerprint: claimFingerprint,
    authority_commitment_sha256: authorityCommitment,
    message_id: intent?.message_id ?? null,
    bridge_channel: intent?.bridge_channel ?? null,
    bridge_sequence: intent?.bridge_sequence ?? null,
    job_id: intent?.job_id ?? null,
    agent_key: intent?.agent_key ?? null,
    repository: intent?.repository ?? null,
    paths: intent?.paths ?? Object.freeze([]),
    operation: intent?.operation ?? null,
    fencing_token: intent?.fencing_token ?? null,
    lease_expires_ms: intent?.lease_expires_ms ?? null,
    claim_expires_ms: null,
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

function requireRepositoryComponent(value, field) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 100 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u.test(value) ||
    value.toLowerCase().endsWith('.git')
  ) {
    fail(`invalid-${field}`);
  }
  return value;
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
      path.endsWith('/') ||
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

function canonicalLeaseKeys(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PATHS) {
    fail('invalid-file-lease-keys');
  }
  const keys = value.map((key) => {
    if (
      typeof key !== 'string' ||
      key.length === 0 ||
      key.length > 1024 ||
      key !== key.trim() ||
      !key.startsWith('git-file/') ||
      /[\u0000-\u001f\u007f]/u.test(key)
    ) {
      fail('invalid-file-lease-key');
    }
    return key;
  });
  const canonical = [...new Set(keys)].sort();
  if (canonical.length !== keys.length || stableJson(canonical) !== stableJson(keys)) {
    fail('noncanonical-file-lease-keys');
  }
  return Object.freeze(canonical);
}

function requireOperation(value) {
  if (!OPERATIONS.has(value)) fail('invalid-operation');
  return value;
}

function requireSha256(value, field = 'sha256') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) fail(`invalid-${field}`);
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

function requireRfc3339Millis(value, field) {
  if (typeof value !== 'string') fail(`invalid-${field}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) fail(`invalid-${field}`);
  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart, , offset] = match;
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  let offsetValid = true;
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    offsetValid =
      offsetHours <= 14 &&
      offsetMinutes <= 59 &&
      (offsetHours < 14 || offsetMinutes === 0);
  }
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    !offsetValid
  ) {
    fail(`invalid-${field}`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) fail(`invalid-${field}`);
  return milliseconds;
}

function requirePlainObject(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`invalid-${name}`);
}

function requireBoundedObject(value, name) {
  requirePlainObject(value, name);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    fail(`invalid-${name}`);
  }
  if (serialized === undefined || Buffer.byteLength(serialized) > MAX_ADAPTER_INPUT_BYTES) {
    fail(`${name}-too-large`);
  }
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
  throw new AgentBridgeLeaseContractError(code);
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

import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify
} from 'node:crypto';

export const ATTESTATION_SCHEMA_VERSION = 'reconciliation.attestation.v1';
export const TRUST_POLICY_SCHEMA_VERSION = 'reconciliation.trust-policy.v1';
export const DEFAULT_MAX_CLOCK_SKEW_SECONDS = 60;
export const DEFAULT_MAX_LIFETIME_SECONDS = 15 * 60;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/;
const LINEAR_ISSUE_PATTERN = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const GITHUB_PULL_REQUEST_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const PUBLIC_KEY_PEM_PATTERN = /^-----BEGIN PUBLIC KEY-----\r?\n[\s\S]+\r?\n-----END PUBLIC KEY-----\s*$/;
const PRIVATE_KEY_PEM_PATTERN = /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const MAX_STRING_LENGTH = 16_384;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_KEYS = 128;
const MAX_NESTING_DEPTH = 16;

const ATTESTATION_KEYS = Object.freeze([
  'schema_version',
  'role',
  'provider',
  'subject',
  'policy_digest',
  'producer',
  'issued_at',
  'expires_at',
  'payload_hash',
  'payload',
  'signature'
]);
const SUBJECT_KEYS = Object.freeze(['kind', 'id', 'revision_digest']);
const PRODUCER_KEYS = Object.freeze([
  'key_id',
  'trust_domain',
  'worker_id',
  'job_id',
  'task_type'
]);
const TRUST_POLICY_KEYS = Object.freeze([
  'schema_version',
  'required_roles',
  'keys',
  'distinct_producer_fields'
]);
const TRUST_KEY_KEYS = Object.freeze([
  'public_key_pem',
  'roles',
  'provider',
  'trust_domain',
  'task_types'
]);

export class ReconciliationAttestationError extends Error {
  constructor(message, code = 'invalid_attestation') {
    super(message);
    this.name = 'ReconciliationAttestationError';
    this.code = code;
  }
}

function fail(message, code = 'invalid_attestation') {
  throw new ReconciliationAttestationError(message, code);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePlainObject(value, label, code = 'invalid_attestation') {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`, code);
  return value;
}

function requireExactKeys(value, expected, label, code = 'invalid_attestation') {
  const actual = Object.keys(requirePlainObject(value, label, code)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    const missing = wanted.filter((key) => !actual.includes(key));
    const unexpected = actual.filter((key) => !wanted.includes(key));
    fail(
      `${label} key set is invalid; missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}`,
      code
    );
  }
}

function requireNonEmptyString(
  value,
  label,
  maximumLength = MAX_STRING_LENGTH,
  code = 'invalid_attestation'
) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maximumLength) {
    fail(`${label} must be a non-empty string no longer than ${maximumLength} characters`, code);
  }
  return value;
}

function requireStringArray(value, label, { nonEmpty = true, code = 'invalid_attestation' } = {}) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || (nonEmpty && value.length === 0)) {
    fail(
      `${label} must be ${nonEmpty ? 'a non-empty' : 'an'} array with at most ${MAX_ARRAY_ITEMS} entries`,
      code
    );
  }
  const normalized = value.map((item, index) =>
    requireNonEmptyString(item, `${label}[${index}]`, MAX_STRING_LENGTH, code)
  );
  if (new Set(normalized).size !== normalized.length) {
    fail(`${label} must not contain duplicates`, code);
  }
  return normalized;
}

function requireFiniteProbability(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} must be a finite probability from 0 through 1`);
  }
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    fail(`${label} must be a finite non-negative number`);
  }
  return value;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireHeadSha(value, label) {
  if (typeof value !== 'string' || !HEAD_SHA_PATTERN.test(value)) {
    fail(`${label} must be a lowercase 40-character commit SHA`);
  }
  return value;
}

function parseTimestamp(value, label) {
  requireNonEmptyString(value, label, 128);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be a parseable ISO-8601 timestamp`);
  return milliseconds;
}

function normalizeForCanonicalJson(value, label = 'value', depth = 0) {
  if (depth > MAX_NESTING_DEPTH) fail(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_STRING_LENGTH) {
      fail(`${label} string exceeds maximum length`);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) fail(`${label} contains too many array entries`);
    return value.map((item, index) =>
      normalizeForCanonicalJson(item, `${label}[${index}]`, depth + 1)
    );
  }
  if (!isPlainObject(value)) fail(`${label} contains an unsupported value type`);
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_OBJECT_KEYS) fail(`${label} contains too many object keys`);
  const result = {};
  for (const key of keys) {
    requireNonEmptyString(key, `${label} key`, 512);
    const child = value[key];
    if (child === undefined) fail(`${label}.${key} must not be undefined`);
    result[key] = normalizeForCanonicalJson(child, `${label}.${key}`, depth + 1);
  }
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

export function sha256Canonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(value, label) {
  requireNonEmptyString(value, label, 4096);
  if (!BASE64URL_PATTERN.test(value)) fail(`${label} must use unpadded base64url encoding`);
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const decoded = Buffer.from(`${normalized}${padding}`, 'base64');
  if (base64UrlEncode(decoded) !== value) fail(`${label} must use canonical base64url encoding`);
  return decoded;
}

function unsignedAttestation(attestation) {
  const { signature: _signature, ...unsigned } = attestation;
  return unsigned;
}

function validateSubject(subject) {
  requireExactKeys(subject, SUBJECT_KEYS, 'attestation.subject');
  const kind = requireNonEmptyString(subject.kind, 'attestation.subject.kind', 64);
  const id = requireNonEmptyString(subject.id, 'attestation.subject.id', 512);
  requireDigest(subject.revision_digest, 'attestation.subject.revision_digest');
  if (kind === 'linear_issue') {
    if (!LINEAR_ISSUE_PATTERN.test(id)) {
      fail('attestation.subject.id must be a canonical Linear issue identifier');
    }
  } else if (kind === 'github_pull_request') {
    if (!GITHUB_PULL_REQUEST_PATTERN.test(id)) {
      fail('attestation.subject.id must use owner/repository#number for a GitHub pull request');
    }
  } else {
    fail(`attestation.subject.kind is unsupported: ${kind}`);
  }
  return subject;
}

function validateProducer(producer) {
  requireExactKeys(producer, PRODUCER_KEYS, 'attestation.producer');
  for (const key of PRODUCER_KEYS) {
    requireNonEmptyString(producer[key], `attestation.producer.${key}`, 512);
  }
  return producer;
}

function validateAttestationShape(attestation) {
  requireExactKeys(attestation, ATTESTATION_KEYS, 'attestation');
  if (attestation.schema_version !== ATTESTATION_SCHEMA_VERSION) {
    fail(`attestation.schema_version must be ${ATTESTATION_SCHEMA_VERSION}`);
  }
  requireNonEmptyString(attestation.role, 'attestation.role', 128);
  requireNonEmptyString(attestation.provider, 'attestation.provider', 128);
  validateSubject(attestation.subject);
  requireDigest(attestation.policy_digest, 'attestation.policy_digest');
  validateProducer(attestation.producer);
  parseTimestamp(attestation.issued_at, 'attestation.issued_at');
  parseTimestamp(attestation.expires_at, 'attestation.expires_at');
  requireDigest(attestation.payload_hash, 'attestation.payload_hash');
  normalizeForCanonicalJson(attestation.payload, 'attestation.payload');
  base64UrlDecode(attestation.signature, 'attestation.signature');
  return attestation;
}

function normalizeTrustedPublicKey(publicKeyPem, label) {
  const value = requireNonEmptyString(
    publicKeyPem,
    label,
    16_384,
    'invalid_trust_policy'
  );
  if (PRIVATE_KEY_PEM_PATTERN.test(value)) {
    fail(`${label} must not contain private-key material`, 'private_key_material');
  }
  if (!PUBLIC_KEY_PEM_PATTERN.test(value)) {
    fail(`${label} must be an unencrypted SPKI PUBLIC KEY PEM`, 'invalid_trust_key');
  }
  let publicKey;
  try {
    publicKey = createPublicKey(value);
  } catch {
    fail(`${label} is not a parseable public key`, 'invalid_trust_key');
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    fail(`${label} must be an Ed25519 public key`, 'unsupported_trust_key');
  }
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  return Object.freeze({
    publicKey,
    fingerprint: createHash('sha256').update(spkiDer).digest('hex')
  });
}

function validateTrustPolicy(trustPolicy) {
  requireExactKeys(
    trustPolicy,
    TRUST_POLICY_KEYS,
    'trustPolicy',
    'invalid_trust_policy'
  );
  if (trustPolicy.schema_version !== TRUST_POLICY_SCHEMA_VERSION) {
    fail(
      `trustPolicy.schema_version must be ${TRUST_POLICY_SCHEMA_VERSION}`,
      'invalid_trust_policy'
    );
  }
  const requiredRoles = requireStringArray(
    trustPolicy.required_roles,
    'trustPolicy.required_roles',
    { code: 'invalid_trust_policy' }
  );
  const distinctFields = requireStringArray(
    trustPolicy.distinct_producer_fields,
    'trustPolicy.distinct_producer_fields',
    { code: 'invalid_trust_policy' }
  );
  for (const field of distinctFields) {
    if (!PRODUCER_KEYS.includes(field)) {
      fail(
        `trustPolicy.distinct_producer_fields contains unsupported field ${field}`,
        'invalid_trust_policy'
      );
    }
  }

  const keys = requirePlainObject(trustPolicy.keys, 'trustPolicy.keys', 'invalid_trust_policy');
  const keyEntries = Object.entries(keys);
  if (keyEntries.length === 0 || keyEntries.length > MAX_OBJECT_KEYS) {
    fail(
      'trustPolicy.keys must contain at least one and at most 128 entries',
      'invalid_trust_policy'
    );
  }

  const normalizedKeys = {};
  const fingerprints = new Map();
  const authorizedRoles = new Set();
  for (const [keyId, entry] of keyEntries) {
    requireNonEmptyString(keyId, 'trustPolicy key id', 512, 'invalid_trust_policy');
    requireExactKeys(
      entry,
      TRUST_KEY_KEYS,
      `trustPolicy.keys.${keyId}`,
      'invalid_trust_policy'
    );
    const roles = requireStringArray(entry.roles, `trustPolicy.keys.${keyId}.roles`, {
      code: 'invalid_trust_policy'
    });
    for (const role of roles) authorizedRoles.add(role);
    const provider = requireNonEmptyString(
      entry.provider,
      `trustPolicy.keys.${keyId}.provider`,
      128,
      'invalid_trust_policy'
    );
    const trustDomain = requireNonEmptyString(
      entry.trust_domain,
      `trustPolicy.keys.${keyId}.trust_domain`,
      512,
      'invalid_trust_policy'
    );
    const taskTypes = requireStringArray(
      entry.task_types,
      `trustPolicy.keys.${keyId}.task_types`,
      { code: 'invalid_trust_policy' }
    );
    const normalizedKey = normalizeTrustedPublicKey(
      entry.public_key_pem,
      `trustPolicy.keys.${keyId}.public_key_pem`
    );
    const existingKeyId = fingerprints.get(normalizedKey.fingerprint);
    if (existingKeyId !== undefined) {
      fail(
        `trustPolicy key ${keyId} aliases the same public key as ${existingKeyId}`,
        'key_alias'
      );
    }
    fingerprints.set(normalizedKey.fingerprint, keyId);
    normalizedKeys[keyId] = Object.freeze({
      roles: Object.freeze(roles),
      provider,
      trust_domain: trustDomain,
      task_types: Object.freeze(taskTypes),
      publicKey: normalizedKey.publicKey,
      fingerprint: normalizedKey.fingerprint
    });
  }
  for (const role of requiredRoles) {
    if (!authorizedRoles.has(role)) {
      fail(`trustPolicy has no key authorized for required role ${role}`, 'invalid_trust_policy');
    }
  }
  return Object.freeze({
    requiredRoles: Object.freeze(requiredRoles),
    distinctFields: Object.freeze(distinctFields),
    keys: Object.freeze(normalizedKeys)
  });
}

export function createSignedAttestation({
  role,
  provider,
  subject,
  policyDigest,
  producer,
  payload,
  privateKeyPem,
  issuedAt = new Date(),
  expiresAt = new Date(new Date(issuedAt).getTime() + DEFAULT_MAX_LIFETIME_SECONDS * 1000)
}) {
  requireNonEmptyString(privateKeyPem, 'privateKeyPem', 32_768);
  const issued = new Date(issuedAt);
  const expires = new Date(expiresAt);
  if (!Number.isFinite(issued.getTime()) || !Number.isFinite(expires.getTime())) {
    fail('issuedAt and expiresAt must be valid dates');
  }
  const normalizedPayload = normalizeForCanonicalJson(payload, 'payload');
  const attestation = {
    schema_version: ATTESTATION_SCHEMA_VERSION,
    role,
    provider,
    subject: normalizeForCanonicalJson(subject, 'subject'),
    policy_digest: policyDigest,
    producer: normalizeForCanonicalJson(producer, 'producer'),
    issued_at: issued.toISOString(),
    expires_at: expires.toISOString(),
    payload_hash: sha256Canonical(normalizedPayload),
    payload: normalizedPayload,
    signature: ''
  };
  validateAttestationShape({ ...attestation, signature: 'AA' });
  let signature;
  try {
    signature = cryptoSign(
      null,
      Buffer.from(canonicalJson(unsignedAttestation(attestation)), 'utf8'),
      privateKeyPem
    );
  } catch {
    fail('privateKeyPem cannot sign this attestation', 'invalid_signing_key');
  }
  return Object.freeze({ ...attestation, signature: base64UrlEncode(signature) });
}

function verifyOneAttestation(attestation, trustPolicy, expected, nowMilliseconds, options) {
  validateAttestationShape(attestation);
  const keyEntry = trustPolicy.keys[attestation.producer.key_id];
  if (!keyEntry) {
    fail(`attestation key is not trusted: ${attestation.producer.key_id}`, 'untrusted_key');
  }
  if (!keyEntry.roles.includes(attestation.role)) {
    fail(`attestation key is not authorized for role ${attestation.role}`, 'unauthorized_role');
  }
  if (keyEntry.provider !== attestation.provider) {
    fail('attestation provider does not match trusted key metadata', 'provider_mismatch');
  }
  if (keyEntry.trust_domain !== attestation.producer.trust_domain) {
    fail('attestation trust domain does not match trusted key metadata', 'trust_domain_mismatch');
  }
  if (!keyEntry.task_types.includes(attestation.producer.task_type)) {
    fail('attestation task type is not authorized for the trusted key', 'task_type_mismatch');
  }

  const issuedMilliseconds = parseTimestamp(attestation.issued_at, 'attestation.issued_at');
  const expiresMilliseconds = parseTimestamp(attestation.expires_at, 'attestation.expires_at');
  if (expiresMilliseconds <= issuedMilliseconds) fail('attestation expiration must follow issuance');
  const maximumLifetimeMilliseconds = options.maxLifetimeSeconds * 1000;
  if (expiresMilliseconds - issuedMilliseconds > maximumLifetimeMilliseconds) {
    fail('attestation lifetime exceeds policy maximum', 'attestation_too_long');
  }
  const skewMilliseconds = options.maxClockSkewSeconds * 1000;
  if (issuedMilliseconds > nowMilliseconds + skewMilliseconds) {
    fail('attestation was issued too far in the future', 'attestation_not_yet_valid');
  }
  if (expiresMilliseconds < nowMilliseconds - skewMilliseconds) {
    fail('attestation is expired', 'attestation_expired');
  }

  if (
    attestation.subject.kind !== expected.subject.kind ||
    attestation.subject.id !== expected.subject.id ||
    attestation.subject.revision_digest !== expected.subject.revision_digest
  ) {
    fail('attestation subject does not match the finalizer expectation', 'subject_mismatch');
  }
  if (attestation.policy_digest !== expected.policyDigest) {
    fail('attestation policy digest does not match the finalizer expectation', 'policy_mismatch');
  }
  const actualPayloadHash = sha256Canonical(attestation.payload);
  if (actualPayloadHash !== attestation.payload_hash) {
    fail('attestation payload hash does not match its payload', 'payload_hash_mismatch');
  }
  const signature = base64UrlDecode(attestation.signature, 'attestation.signature');
  const validSignature = cryptoVerify(
    null,
    Buffer.from(canonicalJson(unsignedAttestation(attestation)), 'utf8'),
    keyEntry.publicKey,
    signature
  );
  if (!validSignature) fail('attestation signature is invalid', 'invalid_signature');
  return attestation;
}

export function verifyIndependentAttestationSet(attestations, {
  trustPolicy,
  expectedSubject,
  expectedPolicyDigest,
  now = new Date(),
  maxClockSkewSeconds = DEFAULT_MAX_CLOCK_SKEW_SECONDS,
  maxLifetimeSeconds = DEFAULT_MAX_LIFETIME_SECONDS
}) {
  if (!Array.isArray(attestations)) fail('attestations must be an array');
  const normalizedPolicy = validateTrustPolicy(trustPolicy);
  validateSubject(expectedSubject);
  requireDigest(expectedPolicyDigest, 'expectedPolicyDigest');
  const nowMilliseconds = new Date(now).getTime();
  if (!Number.isFinite(nowMilliseconds)) fail('now must be a valid date');
  requireNonNegativeNumber(maxClockSkewSeconds, 'maxClockSkewSeconds');
  requireNonNegativeNumber(maxLifetimeSeconds, 'maxLifetimeSeconds');

  if (attestations.length !== normalizedPolicy.requiredRoles.length) {
    fail(
      `attestation count must exactly match required roles ${JSON.stringify(normalizedPolicy.requiredRoles)}`,
      'role_set_mismatch'
    );
  }
  const verified = attestations.map((attestation) =>
    verifyOneAttestation(
      attestation,
      normalizedPolicy,
      { subject: expectedSubject, policyDigest: expectedPolicyDigest },
      nowMilliseconds,
      { maxClockSkewSeconds, maxLifetimeSeconds }
    )
  );
  const byRole = new Map();
  for (const attestation of verified) {
    if (!normalizedPolicy.requiredRoles.includes(attestation.role)) {
      fail(`unexpected attestation role ${attestation.role}`, 'role_set_mismatch');
    }
    if (byRole.has(attestation.role)) {
      fail(`duplicate attestation role ${attestation.role}`, 'role_set_mismatch');
    }
    byRole.set(attestation.role, attestation);
  }
  for (const role of normalizedPolicy.requiredRoles) {
    if (!byRole.has(role)) fail(`missing required attestation role ${role}`, 'role_set_mismatch');
  }
  for (const field of normalizedPolicy.distinctFields) {
    const values = verified.map((attestation) => attestation.producer[field]);
    if (new Set(values).size !== values.length) {
      fail(`required independent producer field is duplicated: ${field}`, 'independence_violation');
    }
  }

  return Object.freeze({
    subject: Object.freeze({ ...expectedSubject }),
    policyDigest: expectedPolicyDigest,
    roles: Object.freeze(
      Object.fromEntries(
        normalizedPolicy.requiredRoles.map((role) => [role, byRole.get(role)])
      )
    )
  });
}

function requireLinearOpinionPayload(attestation, expectedSubject) {
  const payload = requirePlainObject(attestation.payload, `${attestation.role} opinion payload`);
  const required = [
    'issue_id',
    'revision_digest',
    'recommendation',
    'summary',
    'blockers',
    'evidence',
    'confidence'
  ];
  requireExactKeys(payload, required, `${attestation.role} opinion payload`);
  if (payload.issue_id !== expectedSubject.id) {
    fail(`${attestation.role} opinion issue id is mismatched`);
  }
  if (payload.revision_digest !== expectedSubject.revision_digest) {
    fail(`${attestation.role} opinion revision digest is mismatched`);
  }
  if (!['draft', 'pending', 'in_progress', 'complete'].includes(payload.recommendation)) {
    fail(`${attestation.role} opinion recommendation is invalid`);
  }
  requireNonEmptyString(payload.summary, `${attestation.role} opinion summary`, 4000);
  requireStringArray(payload.blockers, `${attestation.role} opinion blockers`, { nonEmpty: false });
  requireStringArray(payload.evidence, `${attestation.role} opinion evidence`, { nonEmpty: false });
  requireFiniteProbability(payload.confidence, `${attestation.role} opinion confidence`);
  return payload;
}

export function verifyLinearOpinionAttestations(attestations, options) {
  if (options?.expectedSubject?.kind !== 'linear_issue') {
    fail('verifyLinearOpinionAttestations requires a linear_issue subject');
  }
  const verified = verifyIndependentAttestationSet(attestations, options);
  const chatgpt = verified.roles.chatgpt;
  const claude = verified.roles.claude;
  if (!chatgpt || !claude) {
    fail('Linear opinions require chatgpt and claude roles', 'role_set_mismatch');
  }
  if (chatgpt.provider !== 'openai') {
    fail('chatgpt role must be produced by the openai provider', 'provider_mismatch');
  }
  if (claude.provider !== 'anthropic') {
    fail('claude role must be produced by the anthropic provider', 'provider_mismatch');
  }
  const chatgptPayload = requireLinearOpinionPayload(chatgpt, options.expectedSubject);
  const claudePayload = requireLinearOpinionPayload(claude, options.expectedSubject);
  return Object.freeze({
    ...verified,
    opinions: Object.freeze({ chatgpt: chatgptPayload, claude: claudePayload }),
    agrees: chatgptPayload.recommendation === claudePayload.recommendation
  });
}

function requirePrDecisionPayload(attestation, expectedSubject, expectedHeadSha) {
  const payload = requirePlainObject(attestation.payload, `${attestation.role} PR decision payload`);
  const required = [
    'pull_request',
    'revision_digest',
    'evaluated_head_sha',
    'readiness_probability',
    'continuous_open_hours',
    'graph_digest',
    'summary',
    'blockers'
  ];
  requireExactKeys(payload, required, `${attestation.role} PR decision payload`);
  if (payload.pull_request !== expectedSubject.id) {
    fail(`${attestation.role} PR identity is mismatched`);
  }
  if (payload.revision_digest !== expectedSubject.revision_digest) {
    fail(`${attestation.role} PR revision digest is mismatched`);
  }
  requireHeadSha(payload.evaluated_head_sha, `${attestation.role} evaluated head SHA`);
  if (payload.evaluated_head_sha !== expectedHeadSha) {
    fail(`${attestation.role} evaluated a different PR head`, 'head_mismatch');
  }
  requireFiniteProbability(payload.readiness_probability, `${attestation.role} readiness probability`);
  requireNonNegativeNumber(payload.continuous_open_hours, `${attestation.role} continuous open hours`);
  requireDigest(payload.graph_digest, `${attestation.role} graph digest`);
  requireNonEmptyString(payload.summary, `${attestation.role} summary`, 4000);
  requireStringArray(payload.blockers, `${attestation.role} blockers`, { nonEmpty: false });
  return payload;
}

export function evaluatePullRequestMergeAttestations(attestations, {
  expectedHeadSha,
  readinessThresholdExclusive = 0.995,
  minimumContinuousOpenHours = 55,
  ...verificationOptions
}) {
  if (verificationOptions?.expectedSubject?.kind !== 'github_pull_request') {
    fail('evaluatePullRequestMergeAttestations requires a github_pull_request subject');
  }
  requireHeadSha(expectedHeadSha, 'expectedHeadSha');
  requireFiniteProbability(readinessThresholdExclusive, 'readinessThresholdExclusive');
  requireNonNegativeNumber(minimumContinuousOpenHours, 'minimumContinuousOpenHours');
  const verified = verifyIndependentAttestationSet(attestations, verificationOptions);
  const readiness = verified.roles.readiness;
  const critic = verified.roles.critic;
  if (!readiness || !critic) {
    fail('PR merge decisions require readiness and critic roles', 'role_set_mismatch');
  }
  const readinessPayload = requirePrDecisionPayload(
    readiness,
    verificationOptions.expectedSubject,
    expectedHeadSha
  );
  const criticPayload = requirePrDecisionPayload(
    critic,
    verificationOptions.expectedSubject,
    expectedHeadSha
  );
  if (readinessPayload.graph_digest !== criticPayload.graph_digest) {
    fail('readiness and critic graph digests differ', 'graph_mismatch');
  }
  const lowerProbability = Math.min(
    readinessPayload.readiness_probability,
    criticPayload.readiness_probability
  );
  const lowerContinuousOpenHours = Math.min(
    readinessPayload.continuous_open_hours,
    criticPayload.continuous_open_hours
  );
  const blockers = Object.freeze([
    ...new Set([...readinessPayload.blockers, ...criticPayload.blockers])
  ]);
  return Object.freeze({
    ...verified,
    decisions: Object.freeze({ readiness: readinessPayload, critic: criticPayload }),
    lowerProbability,
    lowerContinuousOpenHours,
    blockers,
    authorized:
      lowerProbability > readinessThresholdExclusive &&
      lowerContinuousOpenHours >= minimumContinuousOpenHours &&
      blockers.length === 0
  });
}

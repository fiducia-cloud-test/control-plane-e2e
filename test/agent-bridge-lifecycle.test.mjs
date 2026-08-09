import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentBridgeLeaseAdmission } from '../src/agent-bridge-lease-admission.mjs';

const BASE_NOW = 1_800_000_000_000;
const DEFAULT_REPOSITORY = 'fiducia-cloud/control-plane-e2e';
const DEFAULT_PATHS = ['src/adapter.mjs', 'test/adapter.test.mjs'];
const PAYLOAD_A = 'a'.repeat(64);
const PAYLOAD_B = 'b'.repeat(64);
const COMMITMENT = 'c'.repeat(64);

function evaluation({
  messageId = 'message-1',
  channel = 'repository-write-certification',
  sequence = 1,
  jobId = 'job-1',
  agentKey = 'agent-a',
  repository = DEFAULT_REPOSITORY,
  paths = DEFAULT_PATHS,
  operation = 'repository.write',
  payloadSha256 = PAYLOAD_A,
  fencingToken = 17,
  leaseExpiresMs = BASE_NOW + 60_000,
  claimExpiresMs = BASE_NOW + 45_000,
  intentOverrides = {},
  claimOverrides = {},
  authorityOverrides = {},
} = {}) {
  return {
    intent: {
      schema_version: 1,
      message_id: messageId,
      bridge_channel: channel,
      bridge_sequence: sequence,
      job_id: jobId,
      agent_key: agentKey,
      repository,
      paths: [...paths],
      operation,
      payload_sha256: payloadSha256,
      fencing_token: fencingToken,
      lease_expires_ms: leaseExpiresMs,
      ...intentOverrides,
    },
    claim: {
      schema_version: 1,
      claimed: true,
      job_id: jobId,
      agent_key: agentKey,
      repository,
      claim_expires_ms: claimExpiresMs,
      ...claimOverrides,
    },
    authority: {
      schema_version: 1,
      committed: true,
      found: true,
      commitment_sha256: COMMITMENT,
      agent_key: agentKey,
      repository,
      paths: [...paths],
      fencing_token: fencingToken,
      lease_expires_ms: leaseExpiresMs,
      ...authorityOverrides,
    },
  };
}

function assertRejected(receipt, code) {
  assert.equal(receipt.decision, 'rejected');
  assert.equal(receipt.code, code);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.side_effect_permitted, false);
}

test('transient authority denial can be repaired for the same immutable intent exactly once', () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });

  const denied = gate.evaluate(evaluation({
    authorityOverrides: { committed: false },
  }));
  assertRejected(denied, 'authority-not-committed');
  assert.equal(gate.effectCount(), 0);

  const admitted = gate.evaluate(evaluation());
  assert.equal(admitted.decision, 'admitted');
  assert.equal(admitted.side_effect_permitted, true);
  assert.equal(gate.effectCount(), 1);

  const replay = gate.evaluate(evaluation());
  assert.equal(replay.receipt_id, admitted.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('malformed claim repair does not echo ambient credentials and still admits only once', () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });
  const secret = 'synthetic-bearer-token-that-must-not-appear';
  const malformed = evaluation();
  malformed.claim = { ...malformed.claim, bearer_token: secret };

  const denied = gate.evaluate(malformed);
  assertRejected(denied, 'claim-field-set-mismatch');
  assert.ok(!JSON.stringify(denied).includes(secret));

  const admitted = gate.evaluate(evaluation());
  assert.equal(admitted.decision, 'admitted');
  assert.equal(gate.effectCount(), 1);
});

test('historical replay after claim and lease expiry remains non-executable evidence', () => {
  let now = BASE_NOW;
  const gate = new AgentBridgeLeaseAdmission({ now: () => now });
  const input = evaluation({
    leaseExpiresMs: BASE_NOW + 10,
    claimExpiresMs: BASE_NOW + 10,
  });

  const first = gate.evaluate(input);
  assert.equal(first.decision, 'admitted');
  assert.equal(first.side_effect_permitted, true);

  now = BASE_NOW + 11;
  const replay = gate.evaluate(input);
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('capacity exhaustion fails closed while exact replay remains available', () => {
  const gate = new AgentBridgeLeaseAdmission({
    now: () => BASE_NOW,
    maxEntries: 1,
  });

  const first = gate.evaluate(evaluation({ messageId: 'capacity-1', sequence: 1 }));
  assert.equal(first.decision, 'admitted');

  const replay = gate.evaluate(evaluation({ messageId: 'capacity-1', sequence: 1 }));
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);

  const exhausted = gate.evaluate(evaluation({ messageId: 'capacity-2', sequence: 2 }));
  assertRejected(exhausted, 'admission-capacity-exhausted');
  assert.equal(gate.effectCount(), 1);
});

test('stale-sequence floods do not consume admission capacity', () => {
  const gate = new AgentBridgeLeaseAdmission({
    now: () => BASE_NOW,
    maxEntries: 2,
  });

  const first = gate.evaluate(evaluation({ messageId: 'sequence-2', sequence: 2 }));
  assert.equal(first.decision, 'admitted');

  const stale = gate.evaluate(evaluation({ messageId: 'sequence-1', sequence: 1 }));
  assertRejected(stale, 'bridge-sequence-stale');

  const successor = gate.evaluate(evaluation({ messageId: 'sequence-3', sequence: 3 }));
  assert.equal(successor.decision, 'admitted');
  assert.equal(gate.effectCount(), 2);
});

test('message identifiers are global while sequence namespaces remain channel-local', () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });

  const alpha = gate.evaluate(evaluation({
    messageId: 'global-message',
    channel: 'channel-alpha',
    sequence: 1,
  }));
  assert.equal(alpha.decision, 'admitted');

  const crossChannelConflict = gate.evaluate(evaluation({
    messageId: 'global-message',
    channel: 'channel-beta',
    sequence: 1,
  }));
  assertRejected(crossChannelConflict, 'message-replay-conflict');

  const beta = gate.evaluate(evaluation({
    messageId: 'beta-message',
    channel: 'channel-beta',
    sequence: 1,
  }));
  assert.equal(beta.decision, 'admitted');
  assert.equal(gate.effectCount(), 2);
});

test('mutating caller-owned input after admission cannot poison stored replay evidence', () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });
  const input = evaluation();
  const admitted = gate.evaluate(input);

  input.intent.paths.push('secrets/should-not-appear.txt');
  input.claim.agent_key = 'agent-b';
  input.authority.commitment_sha256 = 'd'.repeat(64);

  const replay = gate.evaluate(evaluation());
  const rendered = JSON.stringify(replay);
  assert.equal(replay.receipt_id, admitted.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.ok(!rendered.includes('should-not-appear'));
  assert.deepEqual(replay.paths, [...DEFAULT_PATHS].sort());
  assert.ok(Object.isFrozen(replay));
  assert.ok(Object.isFrozen(replay.paths));
});

test('burst duplicate delivery permits one side effect and returns historical replays', async () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });
  const receipts = await Promise.all(
    Array.from({ length: 64 }, () => Promise.resolve().then(() => gate.evaluate(evaluation()))),
  );

  assert.equal(receipts.filter((receipt) => receipt.side_effect_permitted).length, 1);
  assert.equal(receipts.filter((receipt) => receipt.replayed).length, 63);
  assert.equal(new Set(receipts.map((receipt) => receipt.receipt_id)).size, 1);
  assert.equal(gate.effectCount(), 1);
});

test('conflicting payloads delivered in one burst cannot both become executable', async () => {
  const gate = new AgentBridgeLeaseAdmission({ now: () => BASE_NOW });
  const [first, conflict] = await Promise.all([
    Promise.resolve().then(() => gate.evaluate(evaluation({ payloadSha256: PAYLOAD_A }))),
    Promise.resolve().then(() => gate.evaluate(evaluation({ payloadSha256: PAYLOAD_B }))),
  ]);

  assert.equal(first.decision, 'admitted');
  assertRejected(conflict, 'message-replay-conflict');
  assert.equal(gate.effectCount(), 1);
});

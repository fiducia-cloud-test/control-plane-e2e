import assert from 'node:assert/strict';
import test from 'node:test';

import { AgentBridgeLeaseAdmission } from '../src/agent-bridge-lease-admission.mjs';

const NOW = 1_800_000_000_000;
const PAYLOAD = 'a'.repeat(64);

function harness() {
  return new AgentBridgeLeaseAdmission({ now: () => NOW });
}

function intent(overrides = {}) {
  return {
    schema_version: 1,
    message_id: 'message-1',
    bridge_channel: 'repository-write-certification',
    bridge_sequence: 41,
    job_id: 'job-1',
    agent_key: 'agent-a',
    repository: 'Fiducia-Cloud/Control-Plane-E2E',
    paths: ['src/adapter.mjs', 'test/adapter.test.mjs', 'src/adapter.mjs'],
    operation: 'repository.write',
    payload_sha256: PAYLOAD,
    lease_id: 'lease-1',
    fencing_token: 17,
    lease_expires_ms: NOW + 60_000,
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    schema_version: 1,
    committed: true,
    found: true,
    snapshot_revision: 91,
    lease_id: 'lease-1',
    agent_key: 'agent-a',
    repository: 'fiducia-cloud/control-plane-e2e',
    paths: ['test/adapter.test.mjs', 'src/adapter.mjs'],
    fencing_token: 17,
    lease_expires_ms: NOW + 60_000,
    ...overrides,
  };
}

function rejected(receipt, code) {
  assert.equal(receipt.decision, 'rejected');
  assert.equal(receipt.code, code);
  assert.equal(receipt.side_effect_permitted, false);
  assert.equal(receipt.replayed, false);
  return receipt;
}

test('current committed lease admits one bridge-delivered repository intent', () => {
  const gate = harness();
  const receipt = gate.evaluate({ intent: intent(), authority: authority() });
  assert.equal(receipt.decision, 'admitted');
  assert.equal(receipt.side_effect_permitted, true);
  assert.equal(receipt.repository, 'fiducia-cloud/control-plane-e2e');
  assert.deepEqual(receipt.paths, ['src/adapter.mjs', 'test/adapter.test.mjs']);
  assert.equal(gate.effectCount(), 1);
});

test('exact message replay returns historical evidence without another side effect', () => {
  const gate = harness();
  const first = gate.evaluate({ intent: intent(), authority: authority() });
  const replay = gate.evaluate({ intent: intent(), authority: authority() });
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('same message id with a changed payload digest is a replay conflict', () => {
  const gate = harness();
  gate.evaluate({ intent: intent(), authority: authority() });
  rejected(
    gate.evaluate({
      intent: intent({ payload_sha256: 'b'.repeat(64) }),
      authority: authority(),
    }),
    'message-replay-conflict',
  );
  assert.equal(gate.effectCount(), 1);
});

test('same message id with a changed path union is a replay conflict', () => {
  const gate = harness();
  gate.evaluate({ intent: intent(), authority: authority() });
  rejected(
    gate.evaluate({
      intent: intent({ paths: ['src/other.mjs'] }),
      authority: authority({ paths: ['src/other.mjs'] }),
    }),
    'message-replay-conflict',
  );
});

test('bridge sequence cannot mint authority without commitment proof', () => {
  rejected(
    harness().evaluate({ intent: intent(), authority: authority({ committed: false }) }),
    'authority-not-committed',
  );
});

test('coordinator job identity cannot mint authority when no lease is found', () => {
  rejected(
    harness().evaluate({ intent: intent(), authority: authority({ found: false }) }),
    'authority-not-found',
  );
});

test('repository mismatch is rejected after canonical case folding', () => {
  rejected(
    harness().evaluate({
      intent: intent(),
      authority: authority({ repository: 'fiducia-cloud/other-repo' }),
    }),
    'repository-mismatch',
  );
});

test('path union mismatch is rejected', () => {
  rejected(
    harness().evaluate({
      intent: intent(),
      authority: authority({ paths: ['src/adapter.mjs'] }),
    }),
    'path-union-mismatch',
  );
});

test('agent, lease id, token, and expiry mismatches fail independently', () => {
  const scenarios = [
    [{ agent_key: 'agent-b' }, 'agent-mismatch'],
    [{ lease_id: 'lease-2' }, 'lease-id-mismatch'],
    [{ fencing_token: 18 }, 'fencing-token-mismatch'],
    [{ lease_expires_ms: NOW + 90_000 }, 'lease-expiry-mismatch'],
  ];
  for (const [override, code] of scenarios) {
    rejected(harness().evaluate({ intent: intent(), authority: authority(override) }), code);
  }
});

test('expired authority rejects buffered work', () => {
  rejected(
    harness().evaluate({
      intent: intent({ lease_expires_ms: NOW }),
      authority: authority({ lease_expires_ms: NOW }),
    }),
    'authority-expired',
  );
});

test('successor takeover fences a buffered predecessor and admits the newer token', () => {
  const gate = harness();
  rejected(
    gate.evaluate({
      intent: intent({ message_id: 'old-buffered', bridge_sequence: 42 }),
      authority: authority({
        lease_id: 'lease-successor',
        agent_key: 'agent-b',
        fencing_token: 18,
      }),
    }),
    'agent-mismatch',
  );

  const successor = gate.evaluate({
    intent: intent({
      message_id: 'successor',
      bridge_sequence: 43,
      lease_id: 'lease-successor',
      agent_key: 'agent-b',
      fencing_token: 18,
    }),
    authority: authority({
      lease_id: 'lease-successor',
      agent_key: 'agent-b',
      fencing_token: 18,
      snapshot_revision: 92,
    }),
  });
  assert.equal(successor.decision, 'admitted');
  assert.equal(successor.fencing_token, 18);
});

test('out-of-order new bridge messages are rejected even with a current lease', () => {
  const gate = harness();
  gate.evaluate({ intent: intent({ message_id: 'newer', bridge_sequence: 50 }), authority: authority() });
  rejected(
    gate.evaluate({ intent: intent({ message_id: 'older', bridge_sequence: 49 }), authority: authority() }),
    'bridge-sequence-stale',
  );
});

test('repository case, path order, and duplicate paths canonicalize deterministically', () => {
  const receipt = harness().evaluate({
    intent: intent({
      repository: 'FIDUCIA-CLOUD/CONTROL-PLANE-E2E',
      paths: ['test/adapter.test.mjs', 'src/adapter.mjs', 'test/adapter.test.mjs'],
    }),
    authority: authority({
      repository: 'fiducia-cloud/control-plane-e2e',
      paths: ['src/adapter.mjs', 'test/adapter.test.mjs'],
    }),
  });
  assert.equal(receipt.decision, 'admitted');
  assert.equal(receipt.repository, 'fiducia-cloud/control-plane-e2e');
});

test('malformed identifiers, paths, digests, and field sets fail closed', () => {
  const malformed = [
    intent({ message_id: '' }),
    intent({ repository: 'bare-repo' }),
    intent({ paths: ['../secret'] }),
    intent({ paths: ['src\\secret'] }),
    intent({ payload_sha256: 'not-a-digest' }),
    intent({ fencing_token: 0 }),
    { ...intent(), authorization: 'Bearer should-not-be-accepted' },
  ];
  const codes = [
    'invalid-message-id',
    'invalid-repository',
    'invalid-path',
    'invalid-path',
    'invalid-payload-digest',
    'invalid-fencing-token',
    'intent-field-set-mismatch',
  ];
  for (let index = 0; index < malformed.length; index += 1) {
    rejected(harness().evaluate({ intent: malformed[index], authority: authority() }), codes[index]);
  }
});

test('authority field drift and invalid revision fail closed', () => {
  rejected(
    harness().evaluate({
      intent: intent(),
      authority: { ...authority(), private_key: 'must-not-enter-evidence' },
    }),
    'authority-field-set-mismatch',
  );
  rejected(
    harness().evaluate({ intent: intent(), authority: authority({ snapshot_revision: 0 }) }),
    'invalid-snapshot-revision',
  );
});

test('rejection evidence is bounded and does not echo unknown credential values', () => {
  const secret = 'synthetic-super-secret-value';
  const receipt = harness().evaluate({
    intent: { ...intent(), password: secret },
    authority: authority(),
  });
  rejected(receipt, 'intent-field-set-mismatch');
  const rendered = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(rendered) < 16 * 1024);
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes('password'));
});

test('independent gates produce identical receipt identity for identical verified input', () => {
  const left = harness().evaluate({ intent: intent(), authority: authority() });
  const right = harness().evaluate({
    intent: intent({
      repository: 'fiducia-cloud/control-plane-e2e',
      paths: ['test/adapter.test.mjs', 'src/adapter.mjs'],
    }),
    authority: authority(),
  });
  assert.equal(left.receipt_id, right.receipt_id);
  assert.equal(left.intent_fingerprint, right.intent_fingerprint);
});

test('exact historical replay remains non-executable after successor takeover', () => {
  const gate = harness();
  const first = gate.evaluate({ intent: intent(), authority: authority() });
  assert.equal(first.side_effect_permitted, true);
  const replay = gate.evaluate({
    intent: intent(),
    authority: authority({
      lease_id: 'lease-successor',
      agent_key: 'agent-b',
      fencing_token: 18,
      snapshot_revision: 92,
    }),
  });
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('bridge sequence namespaces are independent per channel', () => {
  const gate = harness();
  const left = gate.evaluate({
    intent: intent({ message_id: 'channel-left', bridge_channel: 'channel-left', bridge_sequence: 1 }),
    authority: authority(),
  });
  const right = gate.evaluate({
    intent: intent({ message_id: 'channel-right', bridge_channel: 'channel-right', bridge_sequence: 1 }),
    authority: authority(),
  });
  assert.equal(left.decision, 'admitted');
  assert.equal(right.decision, 'admitted');
  assert.equal(gate.effectCount(), 2);
});

test('repository-relative paths remain case-sensitive', () => {
  rejected(
    harness().evaluate({
      intent: intent({ paths: ['src/Adapter.mjs'] }),
      authority: authority({ paths: ['src/adapter.mjs'] }),
    }),
    'path-union-mismatch',
  );
});

test('all bounded repository mutation operation classes are supported', () => {
  const gate = harness();
  for (const [index, operation] of [
    'repository.write',
    'repository.commit',
    'repository.pull-request',
  ].entries()) {
    const receipt = gate.evaluate({
      intent: intent({
        message_id: `operation-${index}`,
        bridge_sequence: 100 + index,
        operation,
      }),
      authority: authority({ snapshot_revision: 100 + index }),
    });
    assert.equal(receipt.decision, 'admitted');
    assert.equal(receipt.operation, operation);
  }
});

test('receipts and canonical path arrays are immutable', () => {
  const receipt = harness().evaluate({ intent: intent(), authority: authority() });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.paths), true);
  assert.throws(() => receipt.paths.push('src/late.mjs'), TypeError);
  assert.throws(() => {
    receipt.code = 'forged';
  }, TypeError);
});

test('invalid current time fails before any authority decision is created', () => {
  for (const now of [0, -1, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const gate = new AgentBridgeLeaseAdmission({ now: () => now });
    assert.throws(() => gate.evaluate({ intent: intent(), authority: authority() }));
    assert.equal(gate.effectCount(), 0);
  }
});

test('a rejected valid intent reserves its message id against changed-payload reuse', () => {
  const gate = harness();
  rejected(
    gate.evaluate({ intent: intent(), authority: authority({ committed: false }) }),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate({
      intent: intent({ payload_sha256: 'b'.repeat(64) }),
      authority: authority(),
    }),
    'message-replay-conflict',
  );
  assert.equal(gate.effectCount(), 0);
});

test('the exact rejected intent may be retried after authority becomes committed', () => {
  const gate = harness();
  rejected(
    gate.evaluate({ intent: intent(), authority: authority({ committed: false }) }),
    'authority-not-committed',
  );
  const admitted = gate.evaluate({ intent: intent(), authority: authority() });
  assert.equal(admitted.decision, 'admitted');
  assert.equal(admitted.side_effect_permitted, true);
  assert.equal(gate.effectCount(), 1);
});

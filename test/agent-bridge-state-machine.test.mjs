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
  messageId,
  channel,
  sequence,
  payloadSha256 = PAYLOAD_A,
  claimExpiresMs = BASE_NOW + 45_000,
  leaseExpiresMs = BASE_NOW + 60_000,
  authorityCommitted = true,
} = {}) {
  const jobId = `job-${messageId}`;
  return {
    intent: {
      schema_version: 1,
      message_id: messageId,
      bridge_channel: channel,
      bridge_sequence: sequence,
      job_id: jobId,
      agent_key: 'agent-a',
      repository: DEFAULT_REPOSITORY,
      paths: [...DEFAULT_PATHS],
      operation: 'repository.write',
      payload_sha256: payloadSha256,
      fencing_token: 17,
      lease_expires_ms: leaseExpiresMs,
    },
    claim: {
      schema_version: 1,
      claimed: true,
      job_id: jobId,
      agent_key: 'agent-a',
      repository: DEFAULT_REPOSITORY,
      claim_expires_ms: claimExpiresMs,
    },
    authority: {
      schema_version: 1,
      committed: authorityCommitted,
      found: true,
      commitment_sha256: COMMITMENT,
      agent_key: 'agent-a',
      repository: DEFAULT_REPOSITORY,
      paths: [...DEFAULT_PATHS],
      fencing_token: 17,
      lease_expires_ms: leaseExpiresMs,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

function assertRejected(receipt, code) {
  assert.equal(receipt.decision, 'rejected');
  assert.equal(receipt.code, code);
  assert.equal(receipt.replayed, false);
  assert.equal(receipt.side_effect_permitted, false);
  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.paths));
}

test('deterministic state-machine streams preserve exactly-once admission invariants', () => {
  for (let seed = 1; seed <= 32; seed += 1) {
    const random = seeded(seed);
    const gate = new AgentBridgeLeaseAdmission({
      now: () => BASE_NOW,
      maxEntries: 2_048,
    });
    const nextSequence = new Map();
    const admitted = new Map();
    let freshIndex = 0;

    const fresh = ({ transient = null } = {}) => {
      const channel = `channel-${random() % 8}`;
      const sequence = (nextSequence.get(channel) ?? 0) + 1;
      nextSequence.set(channel, sequence);
      const messageId = `seed-${seed}-message-${freshIndex}`;
      freshIndex += 1;
      const input = evaluation({ messageId, channel, sequence });
      const before = gate.effectCount();

      if (transient === 'authority') {
        const denied = clone(input);
        denied.authority.committed = false;
        assertRejected(gate.evaluate(denied), 'authority-not-committed');
        assert.equal(gate.effectCount(), before);
      } else if (transient === 'claim-expired') {
        const denied = clone(input);
        denied.claim.claim_expires_ms = BASE_NOW;
        assertRejected(gate.evaluate(denied), 'claim-expired');
        assert.equal(gate.effectCount(), before);
      }

      const receipt = gate.evaluate(input);
      assert.equal(receipt.decision, 'admitted');
      assert.equal(receipt.code, 'admitted');
      assert.equal(receipt.replayed, false);
      assert.equal(receipt.side_effect_permitted, true);
      assert.ok(Object.isFrozen(receipt));
      assert.ok(Object.isFrozen(receipt.paths));
      assert.equal(gate.effectCount(), before + 1);
      admitted.set(messageId, { input, receiptId: receipt.receipt_id });
    };

    for (let step = 0; step < 256; step += 1) {
      const operation = random() % 8;
      if (admitted.size === 0 || operation <= 2) {
        fresh({ transient: operation === 1 ? 'authority' : operation === 2 ? 'claim-expired' : null });
        assert.equal(gate.effectCount(), admitted.size);
        continue;
      }

      const entries = [...admitted.values()];
      const chosen = entries[random() % entries.length];
      const before = gate.effectCount();

      if (operation === 3) {
        const replay = gate.evaluate(clone(chosen.input));
        assert.equal(replay.decision, 'admitted');
        assert.equal(replay.receipt_id, chosen.receiptId);
        assert.equal(replay.replayed, true);
        assert.equal(replay.side_effect_permitted, false);
      } else if (operation === 4) {
        const conflict = clone(chosen.input);
        conflict.intent.payload_sha256 = PAYLOAD_B;
        assertRejected(gate.evaluate(conflict), 'message-replay-conflict');
      } else if (operation === 5) {
        const conflict = clone(chosen.input);
        conflict.intent.bridge_channel = `${conflict.intent.bridge_channel}-other`;
        assertRejected(gate.evaluate(conflict), 'message-replay-conflict');
      } else if (operation === 6) {
        const channel = chosen.input.intent.bridge_channel;
        const stale = evaluation({
          messageId: `seed-${seed}-stale-${step}-${random()}`,
          channel,
          sequence: nextSequence.get(channel),
        });
        assertRejected(gate.evaluate(stale), 'bridge-sequence-stale');
      } else {
        fresh();
      }

      assert.equal(gate.effectCount(), before + (operation === 7 ? 1 : 0));
      assert.equal(gate.effectCount(), admitted.size);
    }
  }
});

test('reserved capacity fails closed while every immutable reservation remains repairable', () => {
  const maxEntries = 64;
  const gate = new AgentBridgeLeaseAdmission({
    now: () => BASE_NOW,
    maxEntries,
  });
  const reserved = [];

  for (let index = 0; index < maxEntries; index += 1) {
    const input = evaluation({
      messageId: `reserved-${index}`,
      channel: `reserved-channel-${index}`,
      sequence: 1,
    });
    const expired = clone(input);
    expired.claim.claim_expires_ms = BASE_NOW;
    assertRejected(gate.evaluate(expired), 'claim-expired');
    reserved.push(input);
  }

  assert.equal(gate.effectCount(), 0);
  assertRejected(
    gate.evaluate(evaluation({
      messageId: 'capacity-overflow',
      channel: 'capacity-overflow-channel',
      sequence: 1,
    })),
    'admission-capacity-exhausted',
  );

  for (const input of reserved) {
    const admitted = gate.evaluate(clone(input));
    assert.equal(admitted.decision, 'admitted');
    assert.equal(admitted.replayed, false);
    assert.equal(admitted.side_effect_permitted, true);
  }
  assert.equal(gate.effectCount(), maxEntries);

  for (const input of reserved) {
    const replay = gate.evaluate(clone(input));
    assert.equal(replay.decision, 'admitted');
    assert.equal(replay.replayed, true);
    assert.equal(replay.side_effect_permitted, false);
  }
  assert.equal(gate.effectCount(), maxEntries);

  assertRejected(
    gate.evaluate(evaluation({
      messageId: 'capacity-still-full',
      channel: 'capacity-still-full-channel',
      sequence: 1,
    })),
    'admission-capacity-exhausted',
  );
});

test('pre-intent malformed traffic cannot consume one-entry admission capacity', () => {
  const gate = new AgentBridgeLeaseAdmission({
    now: () => BASE_NOW,
    maxEntries: 1,
  });

  for (let index = 0; index < 512; index += 1) {
    const malformed = {
      intent: {
        schema_version: 1,
        message_id: `malformed-${index}`,
      },
      claim: {},
      authority: {},
    };
    const rejected = gate.evaluate(malformed);
    assert.equal(rejected.decision, 'rejected');
    assert.equal(rejected.side_effect_permitted, false);
  }

  const valid = gate.evaluate(evaluation({
    messageId: 'only-valid-message',
    channel: 'only-valid-channel',
    sequence: 1,
  }));
  assert.equal(valid.decision, 'admitted');
  assert.equal(valid.side_effect_permitted, true);
  assert.equal(gate.effectCount(), 1);
});

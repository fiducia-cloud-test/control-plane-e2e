import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  AgentBridgeLeaseAdmission,
  AgentBridgeLeaseContractError,
  authorityFromFileLeaseRead,
  claimFromAgentPontifexJob,
} from '../src/agent-bridge-lease-admission.mjs';
import { FileLeaseClient } from '../src/file-lease-client.mjs';

const NOW = 1_800_000_000_000;
const PAYLOAD = 'a'.repeat(64);
const COMMITMENT = 'c'.repeat(64);
const REPOSITORY = 'fiducia-cloud/control-plane-e2e';
const PATHS = ['src/adapter.mjs', 'test/adapter.test.mjs'];

function harness(options = {}) {
  return new AgentBridgeLeaseAdmission({ now: () => NOW, ...options });
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
    fencing_token: 17,
    lease_expires_ms: NOW + 60_000,
    ...overrides,
  };
}

function claim(overrides = {}) {
  return {
    schema_version: 1,
    claimed: true,
    job_id: 'job-1',
    agent_key: 'agent-a',
    repository: REPOSITORY,
    claim_expires_ms: NOW + 45_000,
    ...overrides,
  };
}

function authority(overrides = {}) {
  return {
    schema_version: 1,
    committed: true,
    found: true,
    commitment_sha256: COMMITMENT,
    agent_key: 'agent-a',
    repository: REPOSITORY,
    paths: ['test/adapter.test.mjs', 'src/adapter.mjs'],
    fencing_token: 17,
    lease_expires_ms: NOW + 60_000,
    ...overrides,
  };
}

function evaluation(overrides = {}) {
  return {
    intent: intent(),
    claim: claim(),
    authority: authority(),
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

function expectContractError(fn, code) {
  assert.throws(
    fn,
    (error) => error instanceof AgentBridgeLeaseContractError && error.code === code,
  );
}

test('current claim and committed file lease admit one bridge-delivered repository intent', () => {
  const gate = harness();
  const receipt = gate.evaluate(evaluation());
  assert.equal(receipt.decision, 'admitted');
  assert.equal(receipt.side_effect_permitted, true);
  assert.equal(receipt.repository, REPOSITORY);
  assert.deepEqual(receipt.paths, PATHS);
  assert.equal(receipt.job_id, 'job-1');
  assert.equal(receipt.claim_fingerprint.length, 64);
  assert.equal(receipt.authority_commitment_sha256, COMMITMENT);
  assert.equal(gate.effectCount(), 1);
});

test('exact message replay returns historical evidence without another side effect', () => {
  const gate = harness();
  const first = gate.evaluate(evaluation());
  const replay = gate.evaluate(evaluation());
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('same message id with a changed payload digest is a replay conflict', () => {
  const gate = harness();
  gate.evaluate(evaluation());
  rejected(
    gate.evaluate(evaluation({ intent: intent({ payload_sha256: 'b'.repeat(64) }) })),
    'message-replay-conflict',
  );
  assert.equal(gate.effectCount(), 1);
});

test('same message id with a changed path union is a replay conflict', () => {
  const gate = harness();
  gate.evaluate(evaluation());
  rejected(
    gate.evaluate(evaluation({
      intent: intent({ paths: ['src/other.mjs'] }),
      authority: authority({ paths: ['src/other.mjs'] }),
    })),
    'message-replay-conflict',
  );
});

test('malformed top-level evaluation input fails closed without throwing', () => {
  rejected(harness().evaluate(null), 'invalid-evaluation');
  rejected(
    harness().evaluate({ ...evaluation(), ambient_token: 'not-accepted' }),
    'evaluation-field-set-mismatch',
  );
});

test('bridge sequence and coordinator claim cannot mint authority without commitment proof', () => {
  rejected(
    harness().evaluate(evaluation({ authority: authority({ committed: false }) })),
    'authority-not-committed',
  );
});

test('bridge sequence and file lease cannot mint authority without an active claim', () => {
  rejected(
    harness().evaluate(evaluation({ claim: claim({ claimed: false }) })),
    'claim-not-active',
  );
});

test('coordinator job identity cannot mint authority when no file lease is found', () => {
  rejected(
    harness().evaluate(evaluation({ authority: authority({ found: false }) })),
    'authority-not-found',
  );
});

test('authority repository mismatch is rejected after canonical case folding', () => {
  rejected(
    harness().evaluate(evaluation({
      authority: authority({ repository: 'fiducia-cloud/other-repo' }),
    })),
    'repository-mismatch',
  );
});

test('authority path union mismatch is rejected', () => {
  rejected(
    harness().evaluate(evaluation({ authority: authority({ paths: ['src/adapter.mjs'] }) })),
    'path-union-mismatch',
  );
});

test('coordinator job mismatch is rejected', () => {
  rejected(
    harness().evaluate(evaluation({ claim: claim({ job_id: 'job-2' }) })),
    'job-mismatch',
  );
});

test('coordinator claim agent mismatch is rejected', () => {
  rejected(
    harness().evaluate(evaluation({ claim: claim({ agent_key: 'agent-b' }) })),
    'claim-agent-mismatch',
  );
});

test('coordinator claim repository mismatch is rejected', () => {
  rejected(
    harness().evaluate(evaluation({
      claim: claim({ repository: 'fiducia-cloud/other-repo' }),
    })),
    'claim-repository-mismatch',
  );
});

test('file lease holder mismatch is rejected', () => {
  rejected(
    harness().evaluate(evaluation({ authority: authority({ agent_key: 'agent-b' }) })),
    'authority-agent-mismatch',
  );
});

test('fencing token and exact lease expiry mismatches fail independently', () => {
  for (const [override, code] of [
    [{ fencing_token: 18 }, 'fencing-token-mismatch'],
    [{ lease_expires_ms: NOW + 90_000 }, 'lease-expiry-mismatch'],
  ]) {
    rejected(harness().evaluate(evaluation({ authority: authority(override) })), code);
  }
});

test('expired coordinator claim rejects buffered work', () => {
  rejected(
    harness().evaluate(evaluation({ claim: claim({ claim_expires_ms: NOW }) })),
    'claim-expired',
  );
});

test('expired file lease authority rejects buffered work', () => {
  rejected(
    harness().evaluate(evaluation({
      intent: intent({ lease_expires_ms: NOW }),
      authority: authority({ lease_expires_ms: NOW }),
    })),
    'authority-expired',
  );
});

test('successor takeover fences a buffered predecessor and admits the newer token', () => {
  const gate = harness();
  rejected(
    gate.evaluate(evaluation({
      intent: intent({ message_id: 'old-buffered', bridge_sequence: 42 }),
      claim: claim({ agent_key: 'agent-b' }),
      authority: authority({ agent_key: 'agent-b', fencing_token: 18 }),
    })),
    'claim-agent-mismatch',
  );

  const successor = gate.evaluate(evaluation({
    intent: intent({
      message_id: 'successor',
      bridge_sequence: 43,
      agent_key: 'agent-b',
      fencing_token: 18,
    }),
    claim: claim({ agent_key: 'agent-b' }),
    authority: authority({
      agent_key: 'agent-b',
      fencing_token: 18,
      commitment_sha256: 'd'.repeat(64),
    }),
  }));
  assert.equal(successor.decision, 'admitted');
  assert.equal(successor.fencing_token, 18);
});

test('a newer authority-rejected message blocks older new bridge messages', () => {
  const gate = harness();
  rejected(
    gate.evaluate(evaluation({
      intent: intent({ message_id: 'newer', bridge_sequence: 50 }),
      authority: authority({ committed: false }),
    })),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate(evaluation({ intent: intent({ message_id: 'older', bridge_sequence: 49 }) })),
    'bridge-sequence-stale',
  );
});

test('an older rejected intent cannot become executable after a newer message is observed', () => {
  const gate = harness();
  rejected(
    gate.evaluate(evaluation({
      intent: intent({ message_id: 'older', bridge_sequence: 49 }),
      authority: authority({ committed: false }),
    })),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate(evaluation({
      intent: intent({ message_id: 'newer', bridge_sequence: 50 }),
      authority: authority({ committed: false }),
    })),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate(evaluation({ intent: intent({ message_id: 'older', bridge_sequence: 49 }) })),
    'bridge-sequence-stale',
  );
});

test('repository case, path order, and duplicate paths canonicalize deterministically', () => {
  const receipt = harness().evaluate(evaluation({
    intent: intent({
      repository: 'FIDUCIA-CLOUD/CONTROL-PLANE-E2E',
      paths: ['test/adapter.test.mjs', 'src/adapter.mjs', 'test/adapter.test.mjs'],
    }),
    claim: claim({ repository: 'fiducia-cloud/control-plane-e2e' }),
    authority: authority({
      repository: 'fiducia-cloud/control-plane-e2e',
      paths: ['src/adapter.mjs', 'test/adapter.test.mjs'],
    }),
  }));
  assert.equal(receipt.decision, 'admitted');
  assert.equal(receipt.repository, REPOSITORY);
});

test('malformed intent identifiers, paths, digests, and field sets fail closed', () => {
  const malformed = [
    [intent({ message_id: '' }), 'invalid-message-id'],
    [intent({ repository: 'bare-repo' }), 'invalid-repository'],
    [intent({ paths: ['../secret'] }), 'invalid-path'],
    [intent({ paths: ['src\\secret'] }), 'invalid-path'],
    [intent({ paths: ['src/trailing/'] }), 'invalid-path'],
    [intent({ payload_sha256: 'not-a-digest' }), 'invalid-payload-digest'],
    [intent({ fencing_token: 0 }), 'invalid-fencing-token'],
    [{ ...intent(), authorization: 'Bearer should-not-be-accepted' }, 'intent-field-set-mismatch'],
  ];
  for (const [badIntent, code] of malformed) {
    rejected(harness().evaluate(evaluation({ intent: badIntent })), code);
  }
});

test('claim and authority field drift and invalid commitment fail closed', () => {
  rejected(
    harness().evaluate(evaluation({ claim: { ...claim(), token: 'must-not-enter' } })),
    'claim-field-set-mismatch',
  );
  rejected(
    harness().evaluate(evaluation({ authority: { ...authority(), private_key: 'must-not-enter' } })),
    'authority-field-set-mismatch',
  );
  rejected(
    harness().evaluate(evaluation({ authority: authority({ commitment_sha256: 'bad' }) })),
    'invalid-authority-commitment',
  );
});

test('rejection evidence is bounded and does not echo unknown credential values', () => {
  const secret = 'synthetic-super-secret-value';
  const receipt = harness().evaluate(evaluation({
    intent: { ...intent(), password: secret },
  }));
  rejected(receipt, 'intent-field-set-mismatch');
  const rendered = JSON.stringify(receipt);
  assert.ok(Buffer.byteLength(rendered) < 16 * 1024);
  assert.ok(!rendered.includes(secret));
  assert.ok(!rendered.includes('password'));
});

test('independent gates produce identical receipt identity for identical verified input', () => {
  const left = harness().evaluate(evaluation());
  const right = harness().evaluate(evaluation({
    intent: intent({
      repository: REPOSITORY,
      paths: ['test/adapter.test.mjs', 'src/adapter.mjs'],
    }),
  }));
  assert.equal(left.receipt_id, right.receipt_id);
  assert.equal(left.intent_fingerprint, right.intent_fingerprint);
  assert.equal(left.claim_fingerprint, right.claim_fingerprint);
});

test('exact historical replay remains non-executable after successor takeover', () => {
  const gate = harness();
  const first = gate.evaluate(evaluation());
  assert.equal(first.side_effect_permitted, true);
  const replay = gate.evaluate(evaluation({
    claim: claim({ agent_key: 'agent-b' }),
    authority: authority({
      agent_key: 'agent-b',
      fencing_token: 18,
      commitment_sha256: 'd'.repeat(64),
    }),
  }));
  assert.equal(replay.receipt_id, first.receipt_id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('bridge sequence namespaces are independent per channel', () => {
  const gate = harness();
  const left = gate.evaluate(evaluation({
    intent: intent({ message_id: 'channel-left', bridge_channel: 'channel-left', bridge_sequence: 1 }),
  }));
  const right = gate.evaluate(evaluation({
    intent: intent({ message_id: 'channel-right', bridge_channel: 'channel-right', bridge_sequence: 1 }),
  }));
  assert.equal(left.decision, 'admitted');
  assert.equal(right.decision, 'admitted');
  assert.equal(gate.effectCount(), 2);
});

test('repository-relative paths remain case-sensitive', () => {
  rejected(
    harness().evaluate(evaluation({
      intent: intent({ paths: ['src/Adapter.mjs'] }),
      authority: authority({ paths: ['src/adapter.mjs'] }),
    })),
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
    const receipt = gate.evaluate(evaluation({
      intent: intent({
        message_id: `operation-${index}`,
        bridge_sequence: 100 + index,
        operation,
      }),
      authority: authority({ commitment_sha256: String(index + 1).repeat(64) }),
    }));
    assert.equal(receipt.decision, 'admitted');
    assert.equal(receipt.operation, operation);
  }
});

test('receipts and canonical path arrays are immutable', () => {
  const receipt = harness().evaluate(evaluation());
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
    assert.throws(() => gate.evaluate(evaluation()));
    assert.equal(gate.effectCount(), 0);
  }
});

test('a rejected valid intent reserves its message id against changed-payload reuse', () => {
  const gate = harness();
  rejected(
    gate.evaluate(evaluation({ authority: authority({ committed: false }) })),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate(evaluation({ intent: intent({ payload_sha256: 'b'.repeat(64) }) })),
    'message-replay-conflict',
  );
  assert.equal(gate.effectCount(), 0);
});

test('the exact rejected intent may be retried while it remains the newest channel message', () => {
  const gate = harness();
  rejected(
    gate.evaluate(evaluation({ authority: authority({ committed: false }) })),
    'authority-not-committed',
  );
  const admitted = gate.evaluate(evaluation());
  assert.equal(admitted.decision, 'admitted');
  assert.equal(admitted.side_effect_permitted, true);
  assert.equal(gate.effectCount(), 1);
});

test('callers cannot clear or replace private replay, sequencing, or time state', () => {
  const gate = harness();
  const first = gate.evaluate(evaluation());
  assert.equal(first.side_effect_permitted, true);

  gate.receiptsByMessage = new Map();
  gate.fingerprintsByMessage = new Map();
  gate.latestByChannel = new Map();
  gate.now = () => NOW - 1_000_000;

  const replay = gate.evaluate(evaluation());
  assert.equal(replay.replayed, true);
  assert.equal(replay.side_effect_permitted, false);
  assert.equal(gate.effectCount(), 1);
});

test('replay state fails closed at a configured hard capacity', () => {
  const gate = harness({ maxEntries: 1 });
  rejected(
    gate.evaluate(evaluation({ authority: authority({ committed: false }) })),
    'authority-not-committed',
  );
  rejected(
    gate.evaluate(evaluation({ intent: intent({ message_id: 'message-2', bridge_sequence: 42 }) })),
    'admission-capacity-exhausted',
  );
  const firstRetry = gate.evaluate(evaluation());
  assert.equal(firstRetry.decision, 'admitted');
  assert.equal(gate.effectCount(), 1);
});

test('invalid replay-state capacities are rejected at construction', () => {
  for (const maxEntries of [0, -1, 1.5, Number.NaN, 1_000_001]) {
    assert.throws(
      () => new AgentBridgeLeaseAdmission({ now: () => NOW, maxEntries }),
      TypeError,
    );
  }
});

test('Agent Pontifex running job envelope converts to the bounded claim contract', () => {
  const converted = claimFromAgentPontifexJob({
    id: 'job-1',
    org: 'fiducia-cloud-test',
    repo: 'control-plane-e2e',
    status: 'running',
    claimed_by: 'agent-a',
    lease_expires_at: new Date(NOW + 45_000).toISOString(),
    payload: { ignored: true },
  });
  assert.deepEqual(converted, {
    schema_version: 1,
    claimed: true,
    job_id: 'job-1',
    agent_key: 'agent-a',
    repository: 'fiducia-cloud-test/control-plane-e2e',
    claim_expires_ms: NOW + 45_000,
  });
  assert.equal(Object.isFrozen(converted), true);
});

test('Agent Pontifex claim adapter rejects terminal, unclaimed, invalid-time, and oversized jobs', () => {
  const base = {
    id: 'job-1',
    org: 'fiducia-cloud-test',
    repo: 'control-plane-e2e',
    status: 'running',
    claimed_by: 'agent-a',
    lease_expires_at: new Date(NOW + 45_000).toISOString(),
  };
  expectContractError(() => claimFromAgentPontifexJob({ ...base, status: 'queued' }), 'claim-not-active');
  expectContractError(() => claimFromAgentPontifexJob({ ...base, claimed_by: null }), 'claim-not-active');
  expectContractError(
    () => claimFromAgentPontifexJob({ ...base, lease_expires_at: '2026-02-31T12:00:00Z' }),
    'invalid-claim-expires-at',
  );
  expectContractError(
    () => claimFromAgentPontifexJob({ ...base, payload: 'x'.repeat(70 * 1024) }),
    'job-too-large',
  );
});

test('committed file-lease response converts to exact union authority', () => {
  const converted = authorityFromFileLeaseRead({
    response: {
      status: 200,
      envelope: { committed: true },
      output: {
        found: true,
        holder: 'agent-a',
        fencing_token: 17,
        lease_expires_ms: NOW + 60_000,
        keys: PATHS.map((path) => `git-file/${REPOSITORY}/${path}`),
      },
    },
    repository: REPOSITORY,
    paths: PATHS,
  });
  assert.equal(converted.committed, true);
  assert.equal(converted.found, true);
  assert.equal(converted.agent_key, 'agent-a');
  assert.equal(converted.repository, REPOSITORY);
  assert.deepEqual(converted.paths, PATHS);
  assert.match(converted.commitment_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(converted), true);
});

test('file-lease adapter rejects uncommitted, absent, mismatched, and noncanonical authority', () => {
  const baseResponse = {
    status: 200,
    envelope: { committed: true },
    output: {
      found: true,
      holder: 'agent-a',
      fencing_token: 17,
      lease_expires_ms: NOW + 60_000,
      keys: PATHS.map((path) => `git-file/${REPOSITORY}/${path}`),
    },
  };
  expectContractError(
    () => authorityFromFileLeaseRead({
      response: { ...baseResponse, envelope: { committed: false } },
      repository: REPOSITORY,
      paths: PATHS,
    }),
    'authority-not-committed',
  );
  expectContractError(
    () => authorityFromFileLeaseRead({
      response: { ...baseResponse, output: { ...baseResponse.output, found: false } },
      repository: REPOSITORY,
      paths: PATHS,
    }),
    'authority-not-found',
  );
  expectContractError(
    () => authorityFromFileLeaseRead({
      response: { ...baseResponse, output: { ...baseResponse.output, keys: [`git-file/${REPOSITORY}/src/other.mjs`] } },
      repository: REPOSITORY,
      paths: PATHS,
    }),
    'file-lease-key-mismatch',
  );
  expectContractError(
    () => authorityFromFileLeaseRead({
      response: { ...baseResponse, output: { ...baseResponse.output, keys: [...baseResponse.output.keys].reverse() } },
      repository: REPOSITORY,
      paths: PATHS,
    }),
    'noncanonical-file-lease-keys',
  );
});

test('actual FileLeaseClient committed response composes with Agent Pontifex job admission', async () => {
  const secret = 'test-only-internal-secret';
  const server = http.createServer((request, response) => {
    assert.equal(request.headers['x-internal-auth'], secret);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      committed: true,
      result: {
        output: {
          found: true,
          holder: 'agent-a',
          fencing_token: 17,
          lease_expires_ms: NOW + 60_000,
          keys: PATHS.map((path) => `git-file/${REPOSITORY}/${path}`),
        },
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new FileLeaseClient({ baseUrl, internalSecret: secret });
    const response = await client.raw(
      `/v1/file-leases?repository=${encodeURIComponent(REPOSITORY)}&path=${encodeURIComponent(PATHS[0])}`,
    );
    const fileLeaseAuthority = authorityFromFileLeaseRead({
      response,
      repository: REPOSITORY,
      paths: PATHS,
    });
    const jobClaim = claimFromAgentPontifexJob({
      id: 'job-1',
      org: 'fiducia-cloud',
      repo: 'control-plane-e2e',
      status: 'running',
      claimed_by: 'agent-a',
      lease_expires_at: new Date(NOW + 45_000).toISOString(),
    });
    const receipt = harness().evaluate({
      intent: intent(),
      claim: jobClaim,
      authority: fileLeaseAuthority,
    });
    assert.equal(receipt.decision, 'admitted');
    assert.equal(receipt.side_effect_permitted, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

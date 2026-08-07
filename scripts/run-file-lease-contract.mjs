import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { FileLeaseClient, FileLeaseContractError } from '../src/file-lease-client.mjs';

const requireLive = process.argv.includes('--require-live');
const baseUrl = process.env.CONTROL_PLANE_BASE_URL?.trim();
const internalSecret = process.env.FIDUCIA_CONTROL_PLANE_SECRET;

if (!baseUrl || !internalSecret) {
  const message = 'live file-lease E2E requires CONTROL_PLANE_BASE_URL and FIDUCIA_CONTROL_PLANE_SECRET';
  if (requireLive) {
    console.error(`error: ${message}`);
    process.exit(2);
  }
  console.log(`skipped: ${message}`);
  process.exit(0);
}

const runId = randomUUID();
const repository = 'fiducia-cloud-test/control-plane-e2e';
const pathA = `.e2e/${runId}/shared.lock`;
const pathB = `.e2e/${runId}/disjoint.lock`;
const oldAgent = `e2e-old-${runId}`;
const newAgent = `e2e-new-${runId}`;
const disjointAgent = `e2e-disjoint-${runId}`;
const client = new FileLeaseClient({ baseUrl, internalSecret, timeoutMs: 15_000 });
const cleanup = [];

try {
  const first = await client.acquire({
    repository,
    paths: [pathA],
    agent_key: oldAgent,
    ttl_ms: 1_500,
    wait: false,
  });
  assertState(first, 'acquired', 'first agent did not acquire shared path');
  cleanup.push({ agent_key: oldAgent, fencing_token: first.fencingToken });

  const conflict = await client.acquire({
    repository: repository.toUpperCase(),
    paths: [pathA],
    agent_key: newAgent,
    ttl_ms: 30_000,
    wait: false,
  });
  assertState(conflict, 'conflict', 'overlapping agent was not rejected');

  const disjoint = await client.acquire({
    repository,
    paths: [pathB],
    agent_key: disjointAgent,
    ttl_ms: 30_000,
    wait: false,
  });
  assertState(disjoint, 'acquired', 'disjoint path did not remain concurrently claimable');
  cleanup.push({ agent_key: disjointAgent, fencing_token: disjoint.fencingToken });

  await client.renew({
    repository,
    paths: [pathB],
    agent_key: disjointAgent,
    fencing_token: disjoint.fencingToken,
    ttl_ms: 30_000,
  });

  await delay(1_900);
  const successor = await client.acquire({
    repository,
    paths: [pathA],
    agent_key: newAgent,
    ttl_ms: 30_000,
    wait: false,
  });
  assertState(successor, 'acquired', 'successor did not acquire after expiry');
  if (!(successor.fencingToken > first.fencingToken)) {
    throw new Error('successor fencing token did not increase monotonically');
  }
  cleanup.push({ agent_key: newAgent, fencing_token: successor.fencingToken });

  await expectStale(() => client.release({ agent_key: oldAgent, fencing_token: first.fencingToken }));
  await expectStale(() =>
    client.renew({
      repository,
      paths: [pathA],
      agent_key: oldAgent,
      fencing_token: first.fencingToken,
      ttl_ms: 30_000,
    }),
  );

  const observed = await client.get({ repository, path: pathA });
  if (observed.output.fencing_token !== successor.fencingToken) {
    throw new Error('read path did not report the successor fencing token');
  }

  console.log(
    JSON.stringify({
      contract: 'fiducia-control-plane-file-leases/v1',
      runId,
      result: 'passed',
      assertions: [
        'overlap-excluded',
        'disjoint-concurrency',
        'renewal',
        'expiry-takeover',
        'monotonic-fencing',
        'stale-holder-rejected',
        'authoritative-read',
      ],
    }),
  );
} catch (error) {
  console.error(`error: ${safeError(error, internalSecret)}`);
  process.exitCode = 1;
} finally {
  for (const lease of cleanup.reverse()) {
    try {
      await client.release(lease);
    } catch (error) {
      if (!(error instanceof FileLeaseContractError && error.code === 'stale-lease')) {
        console.error(`cleanup-warning: ${safeError(error, internalSecret)}`);
        process.exitCode ||= 1;
      }
    }
  }
}

function assertState(result, expected, message) {
  if (result.state !== expected) throw new Error(`${message}; observed=${result.state}`);
}

async function expectStale(operation) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof FileLeaseContractError && error.code === 'stale-lease') return;
    throw error;
  }
  throw new Error('stale holder operation unexpectedly succeeded');
}

function safeError(error, secret) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(secret, '<redacted>').slice(0, 1000);
}

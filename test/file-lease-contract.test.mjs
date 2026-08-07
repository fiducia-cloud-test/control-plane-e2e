import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { FileLeaseClient, FileLeaseContractError } from '../src/file-lease-client.mjs';

const SECRET = 'test-internal-secret';
const REPOSITORY = 'fiducia-cloud/example.rs';

async function withServer(run) {
  const authority = new MockLeaseAuthority({ secret: SECRET });
  const server = http.createServer((request, response) => authority.handle(request, response));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run({ authority, baseUrl, client: new FileLeaseClient({ baseUrl, internalSecret: SECRET }) });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function expectContractError(error, code, status = undefined) {
  assert.ok(error instanceof FileLeaseContractError, String(error));
  assert.equal(error.code, code);
  if (status !== undefined) assert.equal(error.status, status);
  return true;
}

test('same canonical path cannot be held by two agents', async () => {
  await withServer(async ({ client }) => {
    const first = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/lib.rs'],
      agent_key: 'agent-a',
      ttl_ms: 30_000,
      wait: false,
    });
    const second = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/lib.rs'],
      agent_key: 'agent-b',
      ttl_ms: 30_000,
      wait: false,
    });
    assert.equal(first.state, 'acquired');
    assert.equal(second.state, 'conflict');
  });
});

test('repository case and path order share one authority namespace', async () => {
  await withServer(async ({ client }) => {
    const first = await client.acquire({
      repository: 'Fiducia-Cloud/Example.rs',
      paths: ['Cargo.lock', 'src/lib.rs', 'Cargo.lock'],
      agent_key: 'agent-a',
      ttl_ms: 30_000,
      wait: false,
    });
    const second = await client.acquire({
      repository: 'fiducia-cloud/example.rs',
      paths: ['src/lib.rs', 'Cargo.lock'],
      agent_key: 'agent-b',
      ttl_ms: 30_000,
      wait: false,
    });
    assert.equal(first.state, 'acquired');
    assert.equal(second.state, 'conflict');
  });
});

test('disjoint paths in one repository remain concurrently claimable', async () => {
  await withServer(async ({ client }) => {
    const [left, right] = await Promise.all([
      client.acquire({
        repository: REPOSITORY,
        paths: ['src/left.rs'],
        agent_key: 'agent-left',
        ttl_ms: 30_000,
        wait: false,
      }),
      client.acquire({
        repository: REPOSITORY,
        paths: ['src/right.rs'],
        agent_key: 'agent-right',
        ttl_ms: 30_000,
        wait: false,
      }),
    ]);
    assert.equal(left.state, 'acquired');
    assert.equal(right.state, 'acquired');
    assert.notEqual(left.fencingToken, right.fencingToken);
  });
});

test('union acquisition is atomic when one requested path overlaps', async () => {
  await withServer(async ({ client }) => {
    await client.acquire({
      repository: REPOSITORY,
      paths: ['Cargo.lock'],
      agent_key: 'lockfile-agent',
      ttl_ms: 30_000,
      wait: false,
    });
    const union = await client.acquire({
      repository: REPOSITORY,
      paths: ['Cargo.lock', 'src/new.rs'],
      agent_key: 'union-agent',
      ttl_ms: 30_000,
      wait: false,
    });
    assert.equal(union.state, 'conflict');
    const newPath = await client.get({ repository: REPOSITORY, path: 'src/new.rs' });
    assert.equal(newPath.output.found, false);
  });
});

test('renew requires the exact canonical union path set', async () => {
  await withServer(async ({ client, authority }) => {
    const lease = await client.acquire({
      repository: REPOSITORY,
      paths: ['Cargo.lock', 'src/lib.rs'],
      agent_key: 'agent-a',
      ttl_ms: 30_000,
      wait: false,
    });
    await assert.rejects(
      client.renew({
        repository: REPOSITORY,
        paths: ['Cargo.lock'],
        agent_key: 'agent-a',
        fencing_token: lease.fencingToken,
        ttl_ms: 30_000,
      }),
      (error) => expectContractError(error, 'stale-lease', 409),
    );
    const renewed = await client.renew({
      repository: 'FIDUCIA-CLOUD/EXAMPLE.RS',
      paths: ['src/lib.rs', 'Cargo.lock', 'src/lib.rs'],
      agent_key: 'agent-a',
      fencing_token: lease.fencingToken,
      ttl_ms: 30_000,
    });
    assert.ok(renewed.leaseExpiresMs > authority.nowMs);
  });
});

test('release frees the complete union and stale release replay is rejected', async () => {
  await withServer(async ({ client }) => {
    const lease = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/a.rs', 'src/b.rs'],
      agent_key: 'agent-a',
      ttl_ms: 30_000,
      wait: false,
    });
    await client.release({ agent_key: 'agent-a', fencing_token: lease.fencingToken });
    assert.equal((await client.get({ repository: REPOSITORY, path: 'src/a.rs' })).output.found, false);
    assert.equal((await client.get({ repository: REPOSITORY, path: 'src/b.rs' })).output.found, false);
    await assert.rejects(
      client.release({ agent_key: 'agent-a', fencing_token: lease.fencingToken }),
      (error) => expectContractError(error, 'stale-lease', 409),
    );
  });
});

test('expiry permits takeover with a strictly greater fencing token', async () => {
  await withServer(async ({ client, authority }) => {
    const first = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/expiring.rs'],
      agent_key: 'agent-old',
      ttl_ms: 25,
      wait: false,
    });
    authority.advance(26);
    const successor = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/expiring.rs'],
      agent_key: 'agent-new',
      ttl_ms: 30_000,
      wait: false,
    });
    assert.equal(successor.state, 'acquired');
    assert.ok(successor.fencingToken > first.fencingToken);
  });
});

test('stale holder cannot renew or release after takeover', async () => {
  await withServer(async ({ client, authority }) => {
    const first = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/fenced.rs'],
      agent_key: 'agent-old',
      ttl_ms: 20,
      wait: false,
    });
    authority.advance(21);
    const successor = await client.acquire({
      repository: REPOSITORY,
      paths: ['src/fenced.rs'],
      agent_key: 'agent-new',
      ttl_ms: 30_000,
      wait: false,
    });
    await assert.rejects(
      client.renew({
        repository: REPOSITORY,
        paths: ['src/fenced.rs'],
        agent_key: 'agent-old',
        fencing_token: first.fencingToken,
        ttl_ms: 30_000,
      }),
      (error) => expectContractError(error, 'stale-lease', 409),
    );
    await assert.rejects(
      client.release({ agent_key: 'agent-old', fencing_token: first.fencingToken }),
      (error) => expectContractError(error, 'stale-lease', 409),
    );
    assert.equal(
      (await client.get({ repository: REPOSITORY, path: 'src/fenced.rs' })).output.fencing_token,
      successor.fencingToken,
    );
  });
});

test('wrong or missing internal authentication fails closed', async () => {
  await withServer(async ({ baseUrl }) => {
    for (const internalSecret of ['wrong-secret', 'missing-is-tested-with-raw-fetch']) {
      const client = new FileLeaseClient({ baseUrl, internalSecret });
      const response = await client.raw('/v1/file-leases?repository=fiducia-cloud%2Fexample.rs&path=src%2Flib.rs');
      assert.equal(response.status, 401);
    }
    const response = await fetch(
      `${baseUrl}/v1/file-leases?repository=fiducia-cloud%2Fexample.rs&path=src%2Flib.rs`,
    );
    assert.equal(response.status, 401);
  });
});

test('invalid repository, paths, ttl, agent, and zero fencing token are rejected', async () => {
  await withServer(async ({ client }) => {
    const invalidAcquisitions = [
      { repository: 'bare-repo', paths: ['src/lib.rs'], agent_key: 'a', ttl_ms: 1, wait: false },
      { repository: 'owner/repo.git', paths: ['src/lib.rs'], agent_key: 'a', ttl_ms: 1, wait: false },
      { repository: REPOSITORY, paths: [], agent_key: 'a', ttl_ms: 1, wait: false },
      { repository: REPOSITORY, paths: ['../secret'], agent_key: 'a', ttl_ms: 1, wait: false },
      { repository: REPOSITORY, paths: ['src\\lib.rs'], agent_key: 'a', ttl_ms: 1, wait: false },
      { repository: REPOSITORY, paths: ['src/lib.rs'], agent_key: '', ttl_ms: 1, wait: false },
      { repository: REPOSITORY, paths: ['src/lib.rs'], agent_key: 'a', ttl_ms: 0, wait: false },
      { repository: REPOSITORY, paths: ['src/lib.rs'], agent_key: 'a', ttl_ms: 86_400_001, wait: false },
    ];
    for (const input of invalidAcquisitions) {
      const response = await client.raw('/v1/file-leases/acquire', { method: 'POST', body: input });
      assert.equal(response.status, 400, JSON.stringify(input));
    }
    const response = await client.raw('/v1/file-leases/release', {
      method: 'POST',
      body: { agent_key: 'a', fencing_token: 0 },
    });
    assert.equal(response.status, 400);
  });
});

test('client rejects malformed success envelopes instead of inventing authority', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(201, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { output: { acquired: true } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new FileLeaseClient({ baseUrl, internalSecret: SECRET });
    await assert.rejects(
      client.acquire({ repository: REPOSITORY, paths: ['src/lib.rs'], agent_key: 'a', ttl_ms: 1 }),
      (error) => expectContractError(error, 'invalid-response-number'),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('error bodies and exception messages redact the configured secret', async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end(`backend echoed ${SECRET}`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new FileLeaseClient({ baseUrl, internalSecret: SECRET });
    await assert.rejects(
      client.get({ repository: REPOSITORY, path: 'src/lib.rs' }),
      (error) => {
        assert.ok(error instanceof FileLeaseContractError);
        assert.equal(error.code, 'get-failed');
        assert.ok(!error.message.includes(SECRET));
        assert.match(error.message, /<redacted>/u);
        return true;
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('client aborts bounded requests and classifies timeout separately', async () => {
  const server = http.createServer(async (request, response) => {
    await delay(100);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ result: { output: { found: false } } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new FileLeaseClient({ baseUrl, internalSecret: SECRET, timeoutMs: 20 });
    await assert.rejects(
      client.get({ repository: REPOSITORY, path: 'src/lib.rs' }),
      (error) => expectContractError(error, 'request-timeout'),
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('constructor rejects credential-bearing or pathful base URLs', () => {
  for (const baseUrl of [
    'ftp://example.com',
    'https://user:pass@example.com',
    'https://example.com/control-plane',
    'https://example.com?token=x',
    'not-a-url',
  ]) {
    assert.throws(
      () => new FileLeaseClient({ baseUrl, internalSecret: SECRET }),
      (error) => expectContractError(error, 'invalid-base-url'),
    );
  }
});

class MockLeaseAuthority {
  constructor({ secret }) {
    this.secret = secret;
    this.nextToken = 0;
    this.nowMs = 1_700_000_000_000;
    this.leases = new Map();
    this.pathOwners = new Map();
  }

  advance(milliseconds) {
    this.nowMs += milliseconds;
  }

  async handle(request, response) {
    try {
      if (request.headers['x-internal-auth'] !== this.secret) {
        return json(response, 401, { error: 'invalid or missing internal auth' });
      }
      this.expire();
      const url = new URL(request.url, 'http://mock.local');
      if (request.method === 'POST' && url.pathname === '/v1/file-leases/acquire') {
        return this.acquire(await readJson(request), response);
      }
      if (request.method === 'POST' && url.pathname === '/v1/file-leases/renew') {
        return this.renew(await readJson(request), response);
      }
      if (request.method === 'POST' && url.pathname === '/v1/file-leases/release') {
        return this.release(await readJson(request), response);
      }
      if (request.method === 'GET' && url.pathname === '/v1/file-leases') {
        return this.get(url, response);
      }
      return json(response, 404, { error: 'not found' });
    } catch (error) {
      return json(response, error.status ?? 500, { error: error.message });
    }
  }

  acquire(input, response) {
    const agent = validateAgent(input.agent_key);
    const keys = fileLeaseKeys(input.repository, input.paths);
    const ttl = validateTtl(input.ttl_ms);
    if (keys.some((key) => this.pathOwners.has(key))) {
      return envelope(response, 409, { acquired: false, queued: Boolean(input.wait) });
    }
    const fencingToken = ++this.nextToken;
    const lease = {
      agent,
      keys,
      fencingToken,
      expiresAt: this.nowMs + ttl,
    };
    this.leases.set(fencingToken, lease);
    for (const key of keys) this.pathOwners.set(key, fencingToken);
    return envelope(response, 201, {
      acquired: true,
      queued: false,
      renewed: true,
      fencing_token: fencingToken,
      lease_expires_ms: lease.expiresAt,
    });
  }

  renew(input, response) {
    const agent = validateAgent(input.agent_key);
    const keys = fileLeaseKeys(input.repository, input.paths);
    const ttl = validateTtl(input.ttl_ms);
    const token = validateToken(input.fencing_token);
    const lease = this.leases.get(token);
    if (!lease || lease.agent !== agent || !sameArray(lease.keys, keys)) {
      return json(response, 409, { error: 'file lease is stale or path set changed' });
    }
    lease.expiresAt = this.nowMs + ttl;
    return envelope(response, 200, { renewed: true, lease_expires_ms: lease.expiresAt });
  }

  release(input, response) {
    const agent = validateAgent(input.agent_key);
    const token = validateToken(input.fencing_token);
    const lease = this.leases.get(token);
    if (!lease || lease.agent !== agent) {
      return json(response, 409, { error: 'file lease is stale or held by another agent' });
    }
    this.drop(lease);
    return envelope(response, 200, { released: true });
  }

  get(url, response) {
    const keys = fileLeaseKeys(url.searchParams.get('repository'), [url.searchParams.get('path')]);
    const token = this.pathOwners.get(keys[0]);
    if (!token) return envelope(response, 200, { found: false });
    const lease = this.leases.get(token);
    return envelope(response, 200, {
      found: true,
      holder: lease.agent,
      fencing_token: lease.fencingToken,
      lease_expires_ms: lease.expiresAt,
      keys: lease.keys,
    });
  }

  expire() {
    const now = this.nowMs;
    for (const lease of this.leases.values()) {
      if (lease.expiresAt <= now) this.drop(lease);
    }
  }

  drop(lease) {
    this.leases.delete(lease.fencingToken);
    for (const key of lease.keys) {
      if (this.pathOwners.get(key) === lease.fencingToken) this.pathOwners.delete(key);
    }
  }
}

function fileLeaseKeys(repository, paths) {
  if (typeof repository !== 'string') throw badRequest('repository is required');
  const trimmed = repository.trim();
  const components = trimmed.split('/');
  const validComponent = (component) =>
    component !== '' && component !== '.' && component !== '..' && /^[A-Za-z0-9._-]+$/u.test(component);
  if (
    trimmed === '' ||
    trimmed.length > 200 ||
    components.length !== 2 ||
    components[1].toLowerCase().endsWith('.git') ||
    !components.every(validComponent)
  ) {
    throw badRequest('repository must be canonical owner/repo');
  }
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 256) {
    throw badRequest('paths must contain between 1 and 256 entries');
  }
  const repositoryKey = trimmed.toLowerCase();
  const keys = paths.map((rawPath) => {
    if (typeof rawPath !== 'string') throw badRequest('path must be a string');
    const path = rawPath.trim();
    const valid =
      path !== '' &&
      path.length <= 800 &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      !path.includes('\\') &&
      !/[\u0000-\u001f\u007f]/u.test(path) &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
    if (!valid) throw badRequest(`invalid repository-relative file path: ${path}`);
    return `git-file/${repositoryKey}/${path}`;
  });
  return [...new Set(keys)].sort();
}

function validateAgent(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.trim().length > 120 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw badRequest('agent_key must be 1-120 non-control characters');
  }
  return value.trim();
}

function validateTtl(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 86_400_000) {
    throw badRequest('ttl_ms must be between 1 and 86400000');
  }
  return value;
}

function validateToken(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw badRequest('fencing_token must be non-zero');
  return value;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('invalid JSON');
  }
}

function envelope(response, status, output) {
  return json(response, status, { committed: true, result: { output } });
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

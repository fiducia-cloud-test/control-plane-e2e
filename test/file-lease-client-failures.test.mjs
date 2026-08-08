import assert from 'node:assert/strict';
import test from 'node:test';

import { FileLeaseClient, FileLeaseContractError } from '../src/file-lease-client.mjs';

const SECRET = 'test-internal-secret';
const REPOSITORY = 'fiducia-cloud/example.rs';

function expectContractError(error, code) {
  assert.ok(error instanceof FileLeaseContractError, String(error));
  assert.equal(error.code, code);
  return true;
}

test('caller cancellation is distinct from transport failure', async () => {
  const fetchImpl = async (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  const client = new FileLeaseClient({
    baseUrl: 'https://control-plane.example',
    internalSecret: SECRET,
    fetchImpl,
  });
  const controller = new AbortController();
  const operation = client.get(
    { repository: REPOSITORY, path: 'src/lib.rs' },
    { signal: controller.signal },
  );
  controller.abort(new Error('operator cancelled'));
  await assert.rejects(
    operation,
    (error) => expectContractError(error, 'request-cancelled'),
  );
});

test('response-body failures use a bounded contract error', async () => {
  const fetchImpl = async () => ({
    status: 200,
    text: async () => {
      throw new Error('body stream failed');
    },
  });
  const client = new FileLeaseClient({
    baseUrl: 'https://control-plane.example',
    internalSecret: SECRET,
    fetchImpl,
  });
  await assert.rejects(
    client.get({ repository: REPOSITORY, path: 'src/lib.rs' }),
    (error) => expectContractError(error, 'response-read-failed'),
  );
});

test('declared oversized responses fail before their body is consumed', async () => {
  let textCalls = 0;
  const fetchImpl = async () => ({
    status: 502,
    headers: new Headers({ 'content-length': '65537' }),
    body: null,
    text: async () => {
      textCalls += 1;
      return 'not read';
    },
  });
  const client = new FileLeaseClient({
    baseUrl: 'https://control-plane.example',
    internalSecret: SECRET,
    fetchImpl,
  });

  await assert.rejects(
    client.raw('/v1/file-leases'),
    (error) => expectContractError(error, 'response-too-large'),
  );
  assert.equal(textCalls, 0);
});

test('chunked oversized responses are cancelled at the byte ceiling', async () => {
  let cancelled = false;
  let emittedChunks = 0;
  const fetchImpl = async () => ({
    status: 502,
    headers: new Headers(),
    body: new ReadableStream({
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(new Uint8Array(32 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  const client = new FileLeaseClient({
    baseUrl: 'https://control-plane.example',
    internalSecret: SECRET,
    fetchImpl,
  });

  await assert.rejects(
    client.raw('/v1/file-leases'),
    (error) => expectContractError(error, 'response-too-large'),
  );
  assert.equal(cancelled, true);
  assert.ok(emittedChunks >= 3, `expected at least 3 chunks, got ${emittedChunks}`);
  assert.ok(emittedChunks <= 4, `stream read past one scheduler prefetch: ${emittedChunks} chunks`);
});

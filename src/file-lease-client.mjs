const MAX_ERROR_DETAIL = 512;
const DEFAULT_TIMEOUT_MS = 10_000;

export class FileLeaseContractError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'FileLeaseContractError';
    this.code = code;
    this.status = status;
  }
}

export class FileLeaseClient {
  constructor({ baseUrl, internalSecret, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.internalSecret = validateSecret(internalSecret);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new FileLeaseContractError(
        'invalid-timeout',
        'timeoutMs must be an integer from 1 through 120000',
      );
    }
    if (typeof fetchImpl !== 'function') {
      throw new FileLeaseContractError('invalid-fetch', 'fetchImpl must be a function');
    }
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async acquire(input, options = {}) {
    const response = await this.request('/v1/file-leases/acquire', {
      method: 'POST',
      body: input,
      signal: options.signal,
    });
    const output = response.output;

    if (response.status === 201) {
      if (output?.acquired !== true) {
        throw this.contractError('acquire-response-invalid', response, '201 response did not confirm acquisition');
      }
      const fencingToken = positiveInteger(output.fencing_token, 'fencing_token');
      const leaseExpiresMs = optionalPositiveInteger(output.lease_expires_ms, 'lease_expires_ms');
      return Object.freeze({
        state: 'acquired',
        fencingToken,
        leaseExpiresMs,
        output: Object.freeze({ ...output }),
      });
    }
    if (response.status === 202) {
      if (output?.queued !== true || output?.acquired === true) {
        throw this.contractError('acquire-response-invalid', response, '202 response did not confirm queued state');
      }
      return Object.freeze({ state: 'queued', fencingToken: null, leaseExpiresMs: null, output });
    }
    if (response.status === 409) {
      if (output && output.acquired === true) {
        throw this.contractError('acquire-response-invalid', response, '409 response claimed acquisition');
      }
      return Object.freeze({ state: 'conflict', fencingToken: null, leaseExpiresMs: null, output });
    }
    throw this.httpError('acquire-failed', response);
  }

  async renew(input, options = {}) {
    const response = await this.request('/v1/file-leases/renew', {
      method: 'POST',
      body: input,
      signal: options.signal,
    });
    if (response.status === 409) throw this.httpError('stale-lease', response);
    if (response.status !== 200) throw this.httpError('renew-failed', response);
    if (response.output?.renewed !== true) {
      throw this.contractError('renew-response-invalid', response, '200 response did not confirm renewal');
    }
    const leaseExpiresMs = optionalPositiveInteger(
      response.output.lease_expires_ms,
      'lease_expires_ms',
    );
    return Object.freeze({ leaseExpiresMs, output: Object.freeze({ ...response.output }) });
  }

  async release(input, options = {}) {
    const response = await this.request('/v1/file-leases/release', {
      method: 'POST',
      body: input,
      signal: options.signal,
    });
    if (response.status === 409) throw this.httpError('stale-lease', response);
    if (response.status !== 200) throw this.httpError('release-failed', response);
    if (response.output?.released !== true) {
      throw this.contractError('release-response-invalid', response, '200 response did not confirm release');
    }
    return Object.freeze({ output: Object.freeze({ ...response.output }) });
  }

  async get({ repository, path }, options = {}) {
    const query = new URLSearchParams({ repository, path });
    const response = await this.request(`/v1/file-leases?${query}`, {
      method: 'GET',
      signal: options.signal,
    });
    if (response.status !== 200) throw this.httpError('get-failed', response);
    if (!response.output || typeof response.output !== 'object' || Array.isArray(response.output)) {
      throw this.contractError('get-response-invalid', response, '200 response did not contain an output object');
    }
    return Object.freeze({ output: Object.freeze({ ...response.output }) });
  }

  async raw(path, { method = 'GET', body = undefined, signal = undefined } = {}) {
    return this.request(path, { method, body, signal });
  }

  async request(path, { method, body = undefined, signal = undefined }) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
      throw new FileLeaseContractError('invalid-path', 'request path must start with one slash');
    }
    const url = new URL(path, `${this.baseUrl}/`);
    if (url.origin !== new URL(this.baseUrl).origin) {
      throw new FileLeaseContractError('cross-origin-path', 'request path must remain on the configured origin');
    }

    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          'x-internal-auth': this.internalSecret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combinedSignal,
      });
    } catch (error) {
      const timedOut = timeoutSignal.aborted && !(signal?.aborted);
      throw new FileLeaseContractError(
        timedOut ? 'request-timeout' : 'transport-failed',
        timedOut ? `request exceeded ${this.timeoutMs}ms` : 'request transport failed',
        { cause: error },
      );
    }

    const text = await response.text();
    let envelope = null;
    if (text.trim() !== '') {
      try {
        envelope = JSON.parse(text);
      } catch {
        envelope = null;
      }
    }
    const output = envelope?.result?.output ?? null;
    return Object.freeze({
      status: response.status,
      output,
      envelope,
      detail: redactDetail(text, this.internalSecret),
    });
  }

  contractError(code, response, message) {
    return new FileLeaseContractError(code, `${message}; status=${response.status}`, {
      status: response.status,
    });
  }

  httpError(code, response) {
    const suffix = response.detail ? `: ${response.detail}` : '';
    return new FileLeaseContractError(code, `${code}; status=${response.status}${suffix}`, {
      status: response.status,
    });
  }
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') {
    throw new FileLeaseContractError('invalid-base-url', 'baseUrl must be a string');
  }
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new FileLeaseContractError('invalid-base-url', 'baseUrl must be a valid URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new FileLeaseContractError(
      'invalid-base-url',
      'baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment',
    );
  }
  return url.origin;
}

function validateSecret(value) {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new FileLeaseContractError(
      'invalid-internal-secret',
      'internalSecret must be 1-4096 non-control characters',
    );
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FileLeaseContractError('invalid-response-number', `${name} must be a positive safe integer`);
  }
  return value;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null) return null;
  return positiveInteger(value, name);
}

function redactDetail(value, secret) {
  if (!value) return '';
  return value
    .replaceAll(secret, '<redacted>')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, MAX_ERROR_DETAIL);
}

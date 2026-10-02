import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const verify = vi.hoisted(() => vi.fn());
vi.mock('jose', () => ({ createRemoteJWKSet: () => 'test-jwks', jwtVerify: verify }));
import { ChatGPTAuth, type SecretStore } from '../server/chatgpt-auth.js';
const instances: ChatGPTAuth[] = [];
afterEach(() => instances.splice(0).forEach((a) => a.cancel()));
beforeEach(() => {
  verify.mockReset();
});
function setup(saved: string | null = null) {
  let value = saved;
  let opened = '';
  const store: SecretStore = {
    load: async () => value,
    save: vi.fn(async (v) => {
      value = v;
    }),
    remove: async () => {
      value = null;
    },
  };
  const upstream = vi.fn<typeof fetch>();
  const auth = new ChatGPTAuth(
    store,
    async (url) => {
      opened = url;
    },
    upstream,
  );
  instances.push(auth);
  return { auth, store, upstream, saved: () => value!, url: () => new URL(opened) };
}
function callback(url: URL, params: Record<string, string> = {}) {
  const target = new URL(url.searchParams.get('redirect_uri')!);
  target.search = new URLSearchParams({
    state: url.searchParams.get('state')!,
    code: 'fake-code',
    client_id: 'issued-client',
    ...params,
  }).toString();
  return target;
}
async function signedIn(expires = 3600) {
  const test = setup();
  await test.auth.init();
  await test.auth.connect();
  const url = test.url();
  verify.mockResolvedValue({
    payload: {
      sub: 'subject',
      email: 'test@example.invalid',
      nonce: url.searchParams.get('nonce'),
    },
  });
  test.upstream.mockResolvedValueOnce(
    Response.json({
      access_token: 'secret-access',
      refresh_token: 'secret-refresh',
      id_token: 'secret-id',
      expires_in: expires,
      token_type: 'Bearer',
      scope: 'chatgpt.tokens.use.direct',
    }),
  );
  expect((await fetch(callback(url))).status).toBe(200);
  return test;
}
describe('ChatGPT OAuth connection', () => {
  it('uses PKCE, rejects wrong state before exchange, verifies identity and keeps tokens out of status', async () => {
    const test = setup();
    await test.auth.init();
    await test.auth.connect();
    const url = test.url();
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect((await fetch(callback(url, { state: 'wrong' }))).status).toBe(400);
    expect(test.upstream).not.toHaveBeenCalled();
    verify.mockResolvedValue({ payload: { sub: 'subject', nonce: url.searchParams.get('nonce') } });
    test.upstream.mockResolvedValueOnce(
      Response.json({
        access_token: 'secret-access',
        refresh_token: 'secret-refresh',
        id_token: 'secret-id',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: 'chatgpt.tokens.use.direct',
      }),
    );
    expect((await fetch(callback(url))).status).toBe(200);
    const form = test.upstream.mock.calls[0][1]!.body as URLSearchParams;
    expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge'),
    );
    expect(form.get('client_id')).toBe('issued-client');
    expect(verify).toHaveBeenCalledWith(
      'secret-id',
      'test-jwks',
      expect.objectContaining({
        issuer: 'https://auth.openai.com',
        audience: 'issued-client',
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'sub', 'nonce'],
      }),
    );
    expect(test.auth.status().connected).toBe(true);
    expect(JSON.stringify(test.auth.status())).not.toContain('secret-');
  });
  it.each(['nonce', 'signature', 'scope'])(
    'rejects invalid %s without saving tokens',
    async (failure) => {
      const test = setup();
      await test.auth.init();
      await test.auth.connect();
      if (failure === 'signature') verify.mockRejectedValue(new Error('bad signature'));
      else
        verify.mockResolvedValue({
          payload: {
            sub: 'subject',
            nonce: failure === 'nonce' ? 'wrong' : test.url().searchParams.get('nonce'),
          },
        });
      test.upstream.mockResolvedValueOnce(
        Response.json({
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
          id_token: 'secret-id',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: failure === 'scope' ? 'openid' : 'chatgpt.tokens.use.direct',
        }),
      );
      expect((await fetch(callback(test.url()))).status).toBe(400);
      expect(test.auth.status().connected).toBe(false);
      expect(test.saved()).not.toContain('secret-');
    },
  );
  it('restores a connection, filters models, and retains registration after sign-out', async () => {
    const first = await signedIn();
    const test = setup(first.saved());
    await test.auth.init();
    expect(await test.auth.accessToken()).toBe('secret-access');
    test.upstream.mockResolvedValueOnce(
      Response.json({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-6-luna', display_name: 'Luna', visibility: 'hidden' },
          { slug: 'gpt-4.1-mini', display_name: 'Old', visibility: 'list' },
        ],
      }),
    );
    expect(await test.auth.listModels()).toEqual([{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
    test.upstream.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await test.auth.disconnect();
    expect(test.saved()).not.toContain('secret-');
    await test.auth.connect('issued-client');
    expect(test.url().searchParams.get('client_id')).toBe('issued-client');
    expect(test.url().searchParams.get('ext_agent_host_id')).toBe(
      first.url().searchParams.get('ext_agent_host_id'),
    );
  });
  it('serializes refresh and persists rotated credentials', async () => {
    const test = await signedIn(1);
    test.upstream.mockResolvedValueOnce(
      Response.json({
        access_token: 'rotated-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    );
    expect(await Promise.all([test.auth.accessToken(), test.auth.accessToken()])).toEqual([
      'rotated-access',
      'rotated-access',
    ]);
    expect(test.upstream).toHaveBeenCalledTimes(2);
    expect(test.saved()).toContain('rotated-refresh');
    expect(test.saved()).not.toContain('secret-refresh');
  });
  it('does not open a browser if encrypted storage fails', async () => {
    const test = setup();
    await test.auth.init();
    vi.mocked(test.store.save).mockRejectedValueOnce(new Error('locked'));
    await expect(test.auth.connect()).rejects.toThrow();
    expect(test.auth.status().pending).toBe(false);
    expect(test.upstream).not.toHaveBeenCalled();
  });
});

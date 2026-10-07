import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import { ANSWER_MODELS } from '../shared/models.js';
import { PublicError } from './provider.js';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${AUTH}/.well-known/jwks.json`));
const credentialsSchema = z.object({
  access: z.string(),
  refresh: z.string(),
  idToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
});
const accountSchema = z.object({
  clientId: z.string(),
  subject: z.string(),
  email: z.string(),
  credentials: credentialsSchema.optional(),
});
const stateSchema = z.object({
  welcomeSeen: z.boolean().optional(),
  hostId: z.string(),
  activeId: z.string().optional(),
  accounts: z.array(accountSchema),
});
type Account = z.infer<typeof accountSchema>;
type State = z.infer<typeof stateSchema>;
export interface SecretStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  remove(): Promise<void>;
}
export function chatgptError(error: unknown): PublicError {
  if (error instanceof PublicError) return error;
  if (error instanceof Error && /abort|timeout/i.test(error.name))
    return new PublicError(
      'The ChatGPT request was cancelled or timed out. No API fallback was used.',
    );
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 0;
  if (status === 401 || status === 403)
    return new PublicError(
      'ChatGPT access expired or was declined. Reconnect in Settings. No API fallback was used.',
    );
  if (status === 429)
    return new PublicError(
      'Your ChatGPT plan limit was reached. Review ChatGPT Settings → Usage or try later. No API fallback was used.',
    );
  return new PublicError(
    'ChatGPT could not complete the request. Check your connection, selected model, and plan access. No API fallback was used.',
  );
}

/** OAuth public client. Tokens never enter renderer state, templates, or exports. */
export class ChatGPTAuth {
  private state: State = { hostId: `urn:uuid:${randomUUID()}`, accounts: [] };
  private pending?: { server: Server; timer: NodeJS.Timeout };
  private refreshing?: Promise<string>;
  private writes = Promise.resolve();
  private error = '';
  private epoch = 0;
  private models: Array<{ id: string; name: string }> = [];
  private modelCatalog:
    Array<{ id: string; name: string; visibility: string; supported: boolean }> | undefined;
  constructor(
    private store: SecretStore,
    private openBrowser: (url: string) => Promise<void>,
    private fetcher: typeof fetch = fetch,
  ) {}
  async init() {
    try {
      const saved = await this.store.load();
      if (saved) this.state = stateSchema.parse(JSON.parse(saved));
    } catch {
      this.error =
        'Saved ChatGPT credentials could not be unlocked. Reconnect to save a new connection.';
    }
  }
  private persist() {
    const value = JSON.stringify(this.state);
    const write = this.writes.then(() => this.store.save(value));
    this.writes = write.catch(() => undefined);
    return write;
  }
  private account() {
    return this.state.accounts.find((a) => a.clientId === this.state.activeId);
  }
  status() {
    return {
      welcomePending: Boolean(this.account()?.credentials) && !this.state.welcomeSeen,
      available: true,
      connected: Boolean(this.account()?.credentials),
      pending: Boolean(this.pending),
      activeId: this.state.activeId,
      error: this.error,
      models: this.models,
      modelCatalog: this.modelCatalog,
      accounts: this.state.accounts.map((a) => ({
        id: a.clientId,
        label: `${a.email || 'ChatGPT account'} · ${a.clientId.slice(-6)}`,
        connected: Boolean(a.credentials),
      })),
    };
  }
  cancel() {
    this.epoch++;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.server.close();
      this.pending.server.closeAllConnections();
      this.pending = undefined;
    }
  }
  async connect(clientId?: string) {
    this.cancel();
    const generation = this.epoch;
    this.error = '';
    const existing = clientId
      ? this.state.accounts.find((a) => a.clientId === clientId)
      : undefined;
    if (clientId && !existing)
      throw new PublicError('Select a saved ChatGPT account or add a new one.');
    await this.refreshing?.catch(() => undefined);
    await this.persist(); // Stable host ID must be saved before first authorization.
    if (generation !== this.epoch) return;
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    let redirect = '';
    let consumed = false;
    const callback = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer');
      const incoming = new URL(req.url ?? '/', redirect);
      const candidate = Buffer.from(incoming.searchParams.get('state') ?? '');
      const expected = Buffer.from(state);
      if (
        req.method !== 'GET' ||
        req.headers.host !== new URL(redirect).host ||
        incoming.pathname !== '/auth/callback' ||
        consumed ||
        candidate.length !== expected.length ||
        !timingSafeEqual(candidate, expected)
      ) {
        res.writeHead(400);
        res.end('Invalid sign-in callback.');
        return;
      }
      consumed = true;
      try {
        if (incoming.searchParams.has('error'))
          throw new PublicError('ChatGPT sign-in was declined. You can try again in Settings.');
        const issued = incoming.searchParams.get('client_id') ?? existing?.clientId;
        const code = incoming.searchParams.get('code');
        if (
          !issued ||
          issued === 'dynamic_agent_client' ||
          !code ||
          (existing && issued !== existing.clientId)
        )
          throw new PublicError(
            'ChatGPT returned an incomplete or mismatched registration. Try again.',
          );
        const tokens = await this.exchange({
          grant_type: 'authorization_code',
          client_id: issued,
          code,
          code_verifier: verifier,
          redirect_uri: redirect,
          resource: RESOURCE,
        });
        const { payload } = await jwtVerify(tokens.id_token, jwks, {
          issuer: AUTH,
          audience: issued,
          algorithms: ['RS256'],
          requiredClaims: ['exp', 'sub', 'nonce'],
        });
        if (
          payload.nonce !== nonce ||
          !payload.sub ||
          (existing && payload.sub !== existing.subject)
        )
          throw new PublicError('ChatGPT account verification failed. Try again.');
        const credentials = this.credentials(tokens);
        if (!credentials.scopes.includes(PLAN_SCOPE))
          throw new PublicError('ChatGPT plan access was not granted. Enable it when connecting.');
        if (generation !== this.epoch) throw new PublicError('This sign-in attempt was cancelled.');
        const account: Account = {
          clientId: issued,
          subject: payload.sub,
          email: typeof payload.email === 'string' ? payload.email : '',
          credentials,
        };
        const prior = this.state;
        this.state = {
          ...prior,
          activeId: issued,
          accounts: [...prior.accounts.filter((a) => a.clientId !== issued), account],
        };
        try {
          await this.persist();
        } catch {
          this.state = prior;
          throw new PublicError(
            'Could not securely save ChatGPT credentials. Try again after unlocking your system key store.',
          );
        }
        this.models = [];
        this.modelCatalog = undefined;
        res.end(
          'ChatGPT connected. Return to Callside. Audio processing uses your selected transcription settings.',
        );
      } catch (error) {
        this.error =
          error instanceof PublicError
            ? error.message
            : 'ChatGPT sign-in could not be verified or saved. Please try again.';
        res.writeHead(400);
        res.end(this.error);
      } finally {
        if (generation === this.epoch && this.pending) {
          clearTimeout(this.pending.timer);
          this.pending = undefined;
        }
        callback.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      callback.once('error', reject);
      callback.listen(0, '127.0.0.1', resolve);
    });
    if (generation !== this.epoch) {
      callback.close();
      return;
    }
    const address = callback.address();
    if (!address || typeof address === 'string')
      throw new PublicError('Could not start ChatGPT sign-in.');
    redirect = `http://127.0.0.1:${address.port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: existing?.clientId ?? 'dynamic_agent_client',
      ext_agent_host_id: this.state.hostId,
      response_type: 'code',
      redirect_uri: redirect,
      scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    });
    if (!existing) params.set('agent_name_hint', 'Callside');
    if (existing?.credentials?.idToken) params.set('id_token_hint', existing.credentials.idToken);
    const timer = setTimeout(() => {
      this.error = 'ChatGPT sign-in timed out. Try again.';
      this.cancel();
    }, 5 * 60_000);
    timer.unref();
    this.pending = { server: callback, timer };
    try {
      await this.openBrowser(`${AUTH}/api/accounts/authorize?${params}`);
    } catch {
      this.cancel();
      throw new PublicError('Could not open the system browser for ChatGPT sign-in.');
    }
  }
  private async exchange(fields: Record<string, string>) {
    const response = await this.fetcher(`${AUTH}/api/accounts/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new PublicError('ChatGPT authorization could not be renewed. Reconnect in Settings.');
    return z
      .object({
        access_token: z.string().min(1),
        refresh_token: z.string().min(1),
        id_token: z.string().optional().default(''),
        expires_in: z.number().positive(),
        scope: z.string().optional(),
        token_type: z.string(),
      })
      .parse(await response.json());
  }
  private credentials(
    tokens: Awaited<ReturnType<ChatGPTAuth['exchange']>>,
    previous?: z.infer<typeof credentialsSchema>,
  ) {
    if (tokens.token_type.toLowerCase() !== 'bearer')
      throw new PublicError('Unsupported ChatGPT credential type.');
    return {
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      idToken: tokens.id_token || previous?.idToken || '',
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: tokens.scope === undefined ? (previous?.scopes ?? []) : tokens.scope.split(/\s+/),
    };
  }
  async accessToken(): Promise<string> {
    const account = this.account();
    if (!account?.credentials)
      throw new PublicError(
        'Connect your ChatGPT account in Settings first. No API fallback was used.',
      );
    if (!account.credentials.scopes.includes(PLAN_SCOPE))
      throw new PublicError('ChatGPT plan access is not enabled. Reconnect in Settings.');
    if (account.credentials.expiresAt > Date.now() + 60_000) return account.credentials.access;
    if (!this.refreshing)
      this.refreshing = (async () => {
        const credentials = this.credentials(
          await this.exchange({
            grant_type: 'refresh_token',
            client_id: account.clientId,
            refresh_token: account.credentials!.refresh,
            resource: RESOURCE,
          }),
          account.credentials,
        );
        if (!credentials.scopes.includes(PLAN_SCOPE))
          throw new PublicError('ChatGPT plan access is no longer enabled. Reconnect in Settings.');
        account.credentials = credentials;
        await this.persist();
        return credentials.access;
      })().finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }
  async listModels() {
    const generation = this.epoch;
    const accountId = this.state.activeId;
    try {
      const access = await this.accessToken();
      const response = await this.fetcher(`${RESOURCE}/models`, {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw { status: response.status };
      const body = z
        .object({
          models: z.array(
            z.object({ slug: z.string(), display_name: z.string(), visibility: z.string() }),
          ),
        })
        .parse(await response.json());
      if (generation !== this.epoch || accountId !== this.state.activeId)
        throw new PublicError('ChatGPT account changed. Refresh models again.');
      this.modelCatalog = body.models.map((m) => ({
        id: m.slug,
        name: m.display_name,
        visibility: m.visibility,
        supported: (ANSWER_MODELS as readonly string[]).includes(m.slug),
      }));
      this.models = body.models
        .filter(
          (m) => m.visibility === 'list' && (ANSWER_MODELS as readonly string[]).includes(m.slug),
        )
        .map((m) => ({ id: m.slug, name: m.display_name }));
      this.error = this.models.length
        ? ''
        : 'No supported GPT-6 models are available for this ChatGPT account.';
      return this.models;
    } catch (error) {
      throw chatgptError(error);
    }
  }
  async select(clientId: string) {
    this.cancel();
    await this.refreshing;
    if (!this.state.accounts.some((a) => a.clientId === clientId))
      throw new PublicError('Unknown ChatGPT account.');
    this.state.activeId = clientId;
    this.models = [];
    this.modelCatalog = undefined;
    this.error = '';
    await this.persist();
  }
  async acknowledgeWelcome() {
    this.state.welcomeSeen = true;
    await this.persist();
  }
  async manageUsage() {
    await this.openBrowser('https://chatgpt.com/settings/usage');
  }
  async disconnect() {
    this.cancel();
    await this.refreshing?.catch(() => undefined);
    const account = this.account();
    let revoked = !account?.credentials;
    if (account?.credentials) {
      try {
        const response = await this.fetcher(`${AUTH}/api/accounts/oauth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token: account.credentials.refresh,
            token_type_hint: 'refresh_token',
            client_id: account.clientId,
          }),
          signal: AbortSignal.timeout(10000),
        });
        revoked = response.ok;
      } catch {
        /* Clear locally even if offline. */
      }
      delete account.credentials;
    }
    this.models = [];
    this.modelCatalog = undefined;
    this.error = revoked
      ? ''
      : 'Signed out locally. Remote revocation was not confirmed; disconnect Callside in ChatGPT Settings.';
    await this.persist();
  }
}

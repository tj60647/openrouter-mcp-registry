/**
 * /mcp-info — the integration reference for this registry's MCP endpoint.
 *
 * Section order follows the integrator-requested outline: base URL, auth,
 * transport, tools, record schema, retirement semantics, pagination/payload,
 * client config, sync cadence. Everything an integrator needs should be on this
 * one page — discovery, not archaeology.
 */

/** Tool argument/return reference, kept in sync with apps/mcp/src/lib/mcp-server.ts. */
const TOOLS = [
  {
    name: 'list_models',
    description:
      'List models in the registry with optional filtering and sorting. Retired models are included unless you pass availableOnly: true.',
    params:
      '{ limit?: number (omit = all records), offset?: number = 0, provider?: string, query?: string, sortBy?: string = "id", sortDir?: "asc" | "desc" = "asc", availableOnly?: boolean = false, verbose?: boolean = false, fields?: string[] }',
    returns: '{ models: Model[], count: number, total: number }',
    notes:
      'count is the number of records in this page; total is every record matching provider/query/availableOnly, ignoring limit and offset.',
  },
  {
    name: 'search_models',
    description:
      'Substring search across model ID, display name, and provider. Case-insensitive.',
    params:
      '{ query: string, limit?: number = 20 (1–100), offset?: number = 0, sortBy?: string = "id", sortDir?: "asc" | "desc" = "asc", verbose?: boolean = false, fields?: string[] }',
    returns: '{ models: Model[], count: number, total: number }',
    notes: 'No availability filter — retired models are included in search results.',
  },
  {
    name: 'find_models_by_criteria',
    description:
      'Filter by budget, context window, and modality. Every parameter is optional; omit the ones you do not care about.',
    params:
      '{ maxInputPricePer1k?: number, maxOutputPricePer1k?: number, minContextLength?: number, modality?: string, limit?: number = 50 (1–200), offset?: number = 0, sortBy?: string = "id", sortDir?: "asc" | "desc" = "asc", verbose?: boolean = false, fields?: string[] }',
    returns: '{ models: Model[], count: number, total: number }',
    notes:
      'Models with a NULL price pass the price filters — they are treated as free/unknown, not excluded. Prices are USD per 1,000 tokens.',
  },
  {
    name: 'semantic_search',
    description:
      'Find models by semantic similarity to a natural-language description. Powered by openai/text-embedding-3-small via OpenRouter.',
    params:
      '{ query: string, limit?: number = 10 (1–50), offset?: number = 0, verbose?: boolean = false, fields?: string[] }',
    returns: '{ models: Model[], count: number }',
    notes:
      'The only list-style tool with no total — results are ranked by vector distance, so "matching rows" is not a well-defined set. Only models that already have a description embedding are searchable.',
  },
  {
    name: 'resolve_model',
    description:
      'Resolve a possibly-aliased or non-canonical model ID to its canonical form and fetch its details.',
    params: '{ input: string }',
    returns:
      '{ input: string, resolved: string, source: string, found: boolean, model: Model | null }',
    notes: 'Returns the FULL record — never projected, so description and metadata are present.',
  },
  {
    name: 'get_model',
    description: 'Get full details for a single model by canonical ID.',
    params: '{ id: string }',
    returns: '{ found: boolean, model: Model | null }',
    notes:
      'ID matching is case-insensitive. Returns the FULL record — verbose/fields do not apply.',
  },
  {
    name: 'compare_models',
    description: 'Compare 2–5 models side-by-side on pricing, context length, and lifecycle.',
    params: '{ ids: string[] (2–5 canonical IDs) }',
    returns:
      '{ comparison: Array<{ id, found, displayName, provider, description, modality, contextLength, maxCompletionTokens, inputPricePer1k, outputPricePer1k, imagePricePer1k, createdAt, providerExpirationAt, lastSeenAt, retiredAt, isAvailable, metadata }> }',
    notes:
      'A condensed comparison row, not a raw Model: it includes description and metadata but omits supportedParameters and fetchedAt. Missing IDs come back with found: false and null fields rather than an error.',
  },
  {
    name: 'get_registry_status',
    description:
      'Current sync state plus live row counts, so list results can be reconciled against the last sync.',
    params: '{}',
    returns:
      '{ status: { lastSuccessfulSync, lastAttemptedSync, lastError, recordCount, totalCount, availableCount, retiredCount } | null }',
    notes:
      'status is null when no sync has ever been recorded — the counts are absent in that case. See "Counts" below for what each number means.',
  },
  {
    name: 'get_sync_history',
    description:
      'History of sync attempts, most recent first, with success/failure, record count, and error text.',
    params: '{ limit?: number = 50 (1–200) }',
    returns:
      '{ history: Array<{ id, syncedAt, status, success, recordCount, error, finishedAt, partial }>, count: number }',
    notes:
      'One row per sync attempt. The row is opened as status "running" (success: null) before OpenRouter is contacted and updated in place when the attempt ends, so success: false always means a real failure and always carries an error. syncedAt is the start, finishedAt the end (null while running). A "running" row older than the newest finished row is an attempt whose process died mid-sync.',
  },
] as const;

/** Every field of the shared `Model` record, as it appears in JSON tool output. */
const MODEL_FIELDS: Array<[string, string, string, string]> = [
  ['id', 'string', 'no', 'Canonical model ID, in provider/model-name form. Always returned, even when fields omits it.'],
  ['provider', 'string', 'no', 'Provider slug — the segment before the first slash in id.'],
  ['displayName', 'string', 'no', 'Human-readable name from OpenRouter.'],
  ['description', 'string | null', 'yes', 'Free-form model description. Omitted by the list-style tools unless verbose: true or listed in fields.'],
  ['modality', 'string | null', 'yes', 'Input/output modalities in inputs->outputs form. See the note below the table.'],
  ['contextLength', 'number | null', 'yes', 'Context window size, in tokens.'],
  ['maxCompletionTokens', 'number | null', 'yes', 'Maximum output tokens the top provider will generate.'],
  ['inputPricePer1k', 'number | null', 'yes', 'USD per 1,000 prompt tokens. null means free or not published.'],
  ['outputPricePer1k', 'number | null', 'yes', 'USD per 1,000 completion tokens. null means free or not published.'],
  ['imagePricePer1k', 'number | null', 'yes', 'USD per 1,000 image inputs (OpenRouter publishes a per-image price; the registry scales it by 1,000 the same way it scales token prices). null means not priced per image.'],
  ['createdAt', 'string (ISO-8601) | null', 'yes', 'When the model was published on OpenRouter.'],
  ['providerExpirationAt', 'string (ISO-8601) | null', 'yes', 'Provider-declared scheduled expiry, when OpenRouter supplies one. This is a provider announcement and is unrelated to retiredAt.'],
  ['supportedParameters', 'string[]', 'no', 'Parameters the model accepts, e.g. tools, reasoning, temperature. Empty array when OpenRouter publishes none.'],
  ['metadata', 'object', 'no', 'Everything in the OpenRouter model object that is not mapped to a field above. Omitted by the list-style tools unless verbose: true or listed in fields.'],
  ['fetchedAt', 'string (ISO-8601)', 'no', 'The sync that last wrote this row.'],
  ['lastSeenAt', 'string (ISO-8601) | null', 'yes', 'Last sync in which OpenRouter still listed this model.'],
  ['retiredAt', 'string (ISO-8601) | null', 'yes', 'When the registry marked this model unavailable. null while the model is available.'],
  ['isAvailable', 'boolean', 'no', 'Authoritative availability flag. See Retirement semantics.'],
];

const MUTED = { color: 'var(--text-muted)', fontSize: '0.9rem' } as const;
const SMALL_MUTED = { color: 'var(--text-muted)', fontSize: '0.85rem' } as const;
const SUBHEAD = { color: 'var(--text)', fontSize: '0.75rem', marginBottom: '0.4rem' } as const;
/** Nested panel inside a card — the studio's white-outer / bg-gray-50-inner pairing. */
const NESTED_CARD = { background: 'var(--bg-subtle)' } as const;
/**
 * Tool / resource / prompt identifiers. These used to be indigo, which is what
 * made them scan as headings; with a monochrome palette the signal has to come
 * from weight plus a 2px black rule instead of hue.
 */
const NAME = {
  fontSize: '0.9rem',
  fontWeight: 700,
  color: 'var(--text)',
  background: 'none',
  padding: '0 0 0.2rem',
  borderBottom: '2px solid var(--accent)',
  display: 'inline-block',
} as const;

export default function McpInfoPage() {
  const baseUrl = (process.env['NEXT_PUBLIC_MCP_URL'] ?? 'https://your-mcp-app.vercel.app').replace(
    /\/+$/,
    ''
  );

  return (
    <div className="stack">
      <div>
        <h1>MCP Integration</h1>
        <p style={MUTED}>
          Connect any AI client that supports the Model Context Protocol (MCP) to this registry.
          Everything you need to integrate — endpoint, auth, transport, tool arguments, record
          schema — is on this page.
        </p>
      </div>

      {/* ── 1. API base URL ─────────────────────────────────────────────── */}
      <div
        className="card"
        style={{ border: '2px solid var(--accent)', background: 'var(--bg-subtle)' }}
      >
        <h2 style={{ marginBottom: '0.5rem' }}>API base URL</h2>
        <p style={{ ...MUTED, marginBottom: '0.75rem' }}>
          <strong style={{ color: 'var(--text)' }}>This page is documentation, not the API.</strong>{' '}
          It is served from the docs host. Every API path lives on the MCP host:
        </p>
        <pre>
          <code>{`${baseUrl}/api/mcp                                  ← MCP Streamable HTTP endpoint
${baseUrl}/api/oauth/token                          ← OAuth token endpoint
${baseUrl}/api/oauth/authorize                      ← OAuth authorization endpoint
${baseUrl}/api/oauth/register                       ← Dynamic client registration (RFC 7591)
${baseUrl}/api/oauth/register/{client_id}           ← Client self-management (RFC 7592)
${baseUrl}/.well-known/oauth-authorization-server   ← AS metadata (RFC 8414)
${baseUrl}/.well-known/oauth-protected-resource     ← PR metadata (RFC 9728)`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          If you point a client at the docs host by mistake, it will not 404: the docs host{' '}
          <strong style={{ color: 'var(--text)' }}>308-redirects</strong> <code>/api/mcp</code>,{' '}
          <code>/api/mcp/*</code>, <code>/api/oauth/*</code> and all of <code>/.well-known/*</code>{' '}
          to the MCP host. A 308 preserves the request method and body, so a JSON-RPC{' '}
          <code>POST /api/mcp</code> and a form-encoded <code>POST /api/oauth/token</code> both
          survive the hop — provided your HTTP client follows redirects. Prefer configuring the MCP
          host directly and skip the extra round trip.
        </p>
        <p style={{ ...SMALL_MUTED, marginBottom: 0 }}>
          Operator note: those redirects are emitted from <code>next.config.ts</code> only when the
          docs deployment has <code>NEXT_PUBLIC_MCP_URL</code> set, and they are baked in at build
          time — setting the variable on an already-built deployment needs a redeploy. The MCP host
          likewise redirects <code>/mcp-info</code> back to the docs host when{' '}
          <code>NEXT_PUBLIC_WEB_URL</code> is set.
        </p>
      </div>

      {/* ── 2. Authentication ───────────────────────────────────────────── */}
      <div className="card">
        <h2>Authentication</h2>

        <h3 style={SUBHEAD}>Interactive clients</h3>
        <p style={MUTED}>
          Claude Code, Cursor, VS Code and Claude Desktop authenticate automatically — you don&apos;t
          need to create or paste a token. On first use the server replies with a <code>401</code>{' '}
          that points to its OAuth metadata; the client registers itself via dynamic client
          registration, opens a browser to authorize (authorization code + PKCE), and stores the
          resulting token. Because this registry serves public model data, the authorization step is
          auto-approved, so the browser tab simply flashes and returns.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Server-to-server (client credentials)</h3>
        <p style={MUTED}>
          Non-interactive services use the OAuth client-credentials grant. Two calls, copy-pasteable:
        </p>
        <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
          1. Exchange the client credentials for an access token. The token endpoint accepts{' '}
          <code>application/x-www-form-urlencoded</code> or JSON, and credentials either in the body
          (<code>client_secret_post</code>) or as HTTP Basic (<code>client_secret_basic</code>).
        </p>
        <pre>
          <code>{`curl -sS -X POST ${baseUrl}/api/oauth/token \\
  -H 'Content-Type: application/x-www-form-urlencoded' \\
  -d 'grant_type=client_credentials' \\
  -d 'client_id=YOUR_CLIENT_ID' \\
  -d 'client_secret=YOUR_CLIENT_SECRET' \\
  -d 'scope=mcp:read'

# → {"access_token":"eyJhbGciOiJIUzI1NiJ9...","token_type":"Bearer",
#    "expires_in":3600,"scope":"mcp:read"}`}</code>
        </pre>
        <p style={{ ...SMALL_MUTED, marginTop: '0.75rem', marginBottom: '0.4rem' }}>
          2. Call a tool. Both headers are mandatory: the bearer token, and an <code>Accept</code>{' '}
          that names <em>both</em> media types.
        </p>
        <pre>
          <code>{`curl -sS -X POST ${baseUrl}/api/mcp \\
  -H "Authorization: Bearer $ACCESS_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_models","arguments":{"limit":5}}}'

# → HTTP/1.1 200  Content-Type: text/event-stream
#   event: message
#   data: {"result":{"content":[{"type":"text","text":"{\\"models\\":[…],\\"count\\":5,\\"total\\":452}"}]},"jsonrpc":"2.0","id":1}`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          <strong style={{ color: 'var(--text)' }}>Cache the token.</strong>{' '}
          <code>expires_in</code> is <code>3600</code> (one hour) and the token endpoint is
          rate-limited to 20 requests per minute per IP. Mint a token once, reuse it until it is
          close to expiry, then mint another — do not request one per tool call. The
          client-credentials grant issues no refresh token; just request a new access token.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Registering your own client</h3>
        <p style={MUTED}>
          Dynamic client registration is <strong style={{ color: 'var(--text)' }}>intentionally
          open</strong> on this deployment: the catalogue is public, read-only data, and interactive
          MCP clients depend on self-registration to bootstrap. Registering with{' '}
          <code>{'grant_types: ["client_credentials"]'}</code> and{' '}
          <strong style={{ color: 'var(--text)' }}>no</strong> <code>redirect_uris</code> yields a
          confidential client with a secret — that is the shape a server-to-server integration
          wants:
        </p>
        <pre>
          <code>{`curl -sS -X POST ${baseUrl}/api/oauth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"client_name":"my-service","grant_types":["client_credentials"],"scope":"mcp:read"}'

# → 201 Created
# {
#   "client_id": "…",
#   "client_secret": "…",                 ← shown once, store it now
#   "client_secret_expires_at": 0,        ← 0 = never expires
#   "client_id_issued_at": 1753488000,
#   "grant_types": ["client_credentials"],
#   "token_endpoint_auth_method": "client_secret_post",
#   "scope": "mcp:read",
#   "registration_access_token": "…",     ← shown once, store it too
#   "registration_client_uri": "${baseUrl}/api/oauth/register/…",
#   "authorization_endpoint": "${baseUrl}/api/oauth/authorize",
#   "token_endpoint": "${baseUrl}/api/oauth/token"
# }`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          <code>grant_types</code> is honoured and echoed back exactly as resolved. The supported
          values are <code>authorization_code</code>, <code>refresh_token</code> and{' '}
          <code>client_credentials</code>. Omit the field and it defaults to{' '}
          <code>{'["authorization_code","refresh_token"]'}</code> when you supply{' '}
          <code>redirect_uris</code>, and <code>{'["client_credentials"]'}</code> when you do not.
        </p>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem', marginBottom: '0.75rem' }}>
          <li>
            A client registered <em>with</em> <code>redirect_uris</code> is{' '}
            <strong style={{ color: 'var(--text)' }}>public</strong>: no secret,{' '}
            <code>token_endpoint_auth_method: &quot;none&quot;</code>, PKCE required. Asking for{' '}
            <code>client_credentials</code> alongside <code>redirect_uris</code> is rejected with{' '}
            <code>400 invalid_client_metadata</code> — a public client holds no secret, so honouring
            that grant would hand tokens to anyone who learns the client_id.
          </li>
          <li>
            A client registered <em>without</em> <code>redirect_uris</code> is{' '}
            <strong style={{ color: 'var(--text)' }}>confidential</strong>: a secret is issued and{' '}
            <code>token_endpoint_auth_method</code> is <code>client_secret_post</code>.
          </li>
          <li>
            Other rejected combinations, all <code>400 invalid_client_metadata</code>: an empty{' '}
            <code>grant_types</code> array; any value outside the supported set;{' '}
            <code>refresh_token</code> without <code>authorization_code</code>; and{' '}
            <code>authorization_code</code>/<code>refresh_token</code> with no{' '}
            <code>redirect_uris</code>. Nothing is written to the database when one of these fires.
          </li>
          <li>
            At the token endpoint, requesting a grant your client is not registered for returns{' '}
            <code>400 unauthorized_client</code>. A grant this server does not implement at all
            (e.g. <code>password</code>) still returns <code>400 unsupported_grant_type</code>.
          </li>
        </ul>
        <p style={SMALL_MUTED}>
          Registration is rate-limited to 5 per 15 minutes per IP. Operators can require an initial
          access token by setting <code>OAUTH_REGISTRATION_ACCESS_TOKEN</code> (registration then
          needs <code>Authorization: Bearer &lt;that value&gt;</code> and returns{' '}
          <code>401 invalid_token</code> without it), or refuse registration entirely with{' '}
          <code>OAUTH_DISABLE_REGISTRATION=true</code>, which returns{' '}
          <code>400 registration_not_supported</code>.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Reading or deleting your registration</h3>
        <p style={MUTED}>
          The registration response includes a <code>registration_client_uri</code> and a{' '}
          <code>registration_access_token</code>. Together they let you inspect or delete your own
          client without involving an operator (RFC 7592):
        </p>
        <pre>
          <code>{`# Read the current registration (never returns the client_secret)
curl -sS ${baseUrl}/api/oauth/register/YOUR_CLIENT_ID \\
  -H "Authorization: Bearer $REGISTRATION_ACCESS_TOKEN"

# Delete it
curl -sS -X DELETE ${baseUrl}/api/oauth/register/YOUR_CLIENT_ID \\
  -H "Authorization: Bearer $REGISTRATION_ACCESS_TOKEN"
# → 204 No Content`}</code>
        </pre>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem', marginTop: '0.75rem', marginBottom: 0 }}>
          <li>
            <code>DELETE</code> revokes the client: it can no longer authorize or obtain tokens, and
            the token endpoint treats it as unknown. Access tokens already issued remain valid until
            they expire (within the hour).
          </li>
          <li>
            Every failure mode — missing header, wrong scheme, wrong token, unknown client_id,
            already-deleted client — returns the same flat{' '}
            <code>401 {'{"error":"invalid_token"}'}</code>. There is deliberately no{' '}
            <code>404</code>, so the endpoint cannot be used to enumerate client IDs. A second{' '}
            <code>DELETE</code> therefore looks like an auth failure.
          </li>
          <li>
            The <code>registration_access_token</code> is stored only as a hash. It is shown once,
            cannot be read back, and cannot be rotated. If you lose it, an operator must clean the
            client up from the admin panel. Clients registered before this endpoint existed have no
            management token and always receive <code>401</code> here.
          </li>
          <li>Rate-limited to 30 requests per 15 minutes per IP.</li>
        </ul>
      </div>

      {/* ── 3. Transport ────────────────────────────────────────────────── */}
      <div className="card">
        <h2>Transport</h2>
        <p style={MUTED}>
          <code>POST {baseUrl}/api/mcp</code> speaks MCP over{' '}
          <strong style={{ color: 'var(--text)' }}>Streamable HTTP, statelessly</strong>. A fresh
          transport and a fresh server instance are built for every POST, so no state survives
          between requests. The practical consequences are worth reading before you write a client
          by hand.
        </p>

        <h3 style={SUBHEAD}>Handshake — not required</h3>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem' }}>
          <li>
            <strong style={{ color: 'var(--text)' }}>
              <code>initialize</code> is NOT required
            </strong>{' '}
            before <code>tools/call</code> or <code>tools/list</code>. A bare tool call as the very
            first request returns a normal result.
          </li>
          <li>
            <strong style={{ color: 'var(--text)' }}>
              <code>notifications/initialized</code> is NOT required
            </strong>
            . If you do send it — or any POST containing only notifications and no JSON-RPC request
            — the server answers <code>202</code> with an empty body.
          </li>
          <li>
            You <em>may</em> send <code>initialize</code>; it succeeds and reports{' '}
            <code>{'serverInfo: { name: "openrouter-registry-mcp", version: "1.0.0" }'}</code> and{' '}
            <code>{'capabilities: { tools: { listChanged: true } }'}</code>. It establishes nothing
            that persists, so the next call still has to stand on its own. You cannot batch{' '}
            <code>initialize</code> together with another message — that is rejected with{' '}
            <code>400</code> / <code>-32600</code> (&quot;Only one initialization request is
            allowed&quot;).
          </li>
          <li>
            <strong style={{ color: 'var(--text)' }}>
              No <code>Mcp-Session-Id</code> is ever returned
            </strong>
            , so there is nothing to echo. If you send one anyway it is accepted and silently
            ignored, even if fabricated.
          </li>
        </ul>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Required request headers</h3>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Header</th>
                <th>Requirement</th>
                <th>On violation</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>Accept</code>
                </td>
                <td style={MUTED}>
                  Mandatory. Must literally contain <em>both</em> <code>application/json</code> and{' '}
                  <code>text/event-stream</code>. The check is a plain substring test — a bare{' '}
                  <code>*/*</code>, only one of the two, or omitting the header entirely all fail.
                </td>
                <td style={MUTED}>
                  <code>406</code> &quot;Not Acceptable: Client must accept both application/json
                  and text/event-stream&quot;
                </td>
              </tr>
              <tr>
                <td>
                  <code>Content-Type</code>
                </td>
                <td style={MUTED}>
                  Mandatory, must contain <code>application/json</code>.
                </td>
                <td style={MUTED}>
                  <code>415</code> &quot;Unsupported Media Type&quot;
                </td>
              </tr>
              <tr>
                <td>
                  <code>Authorization</code>
                </td>
                <td style={MUTED}>
                  <code>Bearer</code> token with the <code>mcp:read</code> scope, in production.
                </td>
                <td style={MUTED}>
                  <code>401 invalid_token</code>, or <code>403 insufficient_scope</code> for a valid
                  token without the scope. Both carry a <code>WWW-Authenticate</code> header
                  pointing at <code>/.well-known/oauth-protected-resource</code>.
                </td>
              </tr>
              <tr>
                <td>
                  <code>Mcp-Protocol-Version</code>
                </td>
                <td style={MUTED}>
                  Optional. If present it must be one of <code>2025-11-25</code>,{' '}
                  <code>2025-06-18</code>, <code>2025-03-26</code>, <code>2024-11-05</code>,{' '}
                  <code>2024-10-07</code>.
                </td>
                <td style={MUTED}>
                  <code>400</code> / <code>-32000</code> unsupported protocol version
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Response encoding — always SSE</h3>
        <p style={MUTED}>
          There is no JSON response mode. Any POST carrying a JSON-RPC{' '}
          <em>request</em> answers <code>200</code> with{' '}
          <code>Content-Type: text/event-stream</code>,{' '}
          <strong style={{ color: 'var(--text)' }}>regardless of your Accept header</strong> — the
          Accept requirement above is a gate, not a negotiation. The body is exactly one frame,
          after which the stream closes:
        </p>
        <pre>
          <code>{`event: message
data: {"result":{…},"jsonrpc":"2.0","id":1}

`}</code>
        </pre>
        <p style={MUTED}>
          There is no <code>id:</code> field and no keep-alive traffic, so a hand-rolled client can
          simply read to end-of-stream and parse the single <code>data:</code> line. Only
          transport-level errors come back as <code>application/json</code>.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Error model</h3>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Situation</th>
                <th>HTTP</th>
                <th>Body</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={MUTED}>Tool threw / returned an error</td>
                <td>
                  <code>200</code>
                </td>
                <td style={MUTED}>
                  SSE, a <em>successful</em> JSON-RPC result with{' '}
                  <code>result.isError: true</code> and the message in{' '}
                  <code>result.content[0].text</code>. Never an HTTP error.
                </td>
              </tr>
              <tr>
                <td style={MUTED}>Unknown tool name, or arguments failing the schema</td>
                <td>
                  <code>200</code>
                </td>
                <td style={MUTED}>
                  Same shape — <code>result.isError: true</code>, text prefixed{' '}
                  <code>MCP error -32602:</code>. Not a JSON-RPC error object.
                </td>
              </tr>
              <tr>
                <td style={MUTED}>Unknown JSON-RPC method</td>
                <td>
                  <code>200</code>
                </td>
                <td style={MUTED}>
                  SSE carrying a JSON-RPC <code>error</code> object,{' '}
                  <code>code: -32601 &quot;Method not found&quot;</code>, with your request{' '}
                  <code>id</code>.
                </td>
              </tr>
              <tr>
                <td style={MUTED}>
                  Bad <code>Accept</code>/<code>Content-Type</code>, unparseable JSON or JSON-RPC,
                  bad protocol version, illegal batch
                </td>
                <td style={MUTED}>
                  <code>400</code>/<code>406</code>/<code>415</code>
                </td>
                <td style={MUTED}>
                  <code>application/json</code>, never SSE:{' '}
                  <code>{'{"jsonrpc":"2.0","error":{"code":…,"message":…},"id":null}'}</code>. Note{' '}
                  <code>id</code> is always <code>null</code>, even when your request had one.
                </td>
              </tr>
              <tr>
                <td style={MUTED}>
                  <code>GET</code> or <code>DELETE</code> on <code>/api/mcp</code>
                </td>
                <td>
                  <code>405</code>
                </td>
                <td style={MUTED}>
                  <code>{'{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}'}</code>
                  . There is no standalone GET listening stream and no session-termination endpoint.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ ...SMALL_MUTED, marginTop: '0.75rem', marginBottom: 0 }}>
          Because tool failures arrive as <code>200</code>, a client that only checks the HTTP
          status will treat every error as success. Always inspect{' '}
          <code>result.isError</code>.
        </p>
      </div>

      {/* ── 4. Tool reference ───────────────────────────────────────────── */}
      <div className="card">
        <h2>Tool reference</h2>
        <p style={{ ...MUTED, marginBottom: '0.75rem' }}>
          <strong style={{ color: 'var(--text)' }}>Naming:</strong> every filter argument and every
          field of a returned record is <strong style={{ color: 'var(--text)' }}>camelCase</strong>{' '}
          (<code>maxInputPricePer1k</code>, <code>minContextLength</code>,{' '}
          <code>availableOnly</code>, <code>contextLength</code>…). The single exception is{' '}
          <code>sortBy</code>, which accepts{' '}
          <strong style={{ color: 'var(--text)' }}>both spellings</strong> and treats them
          identically.
        </p>
        <p style={{ ...MUTED, marginBottom: '0.75rem' }}>
          <code>sortBy</code> values: <code>id</code>, <code>provider</code>,{' '}
          <code>display_name</code>/<code>displayName</code>, <code>context_length</code>/
          <code>contextLength</code>, <code>max_completion_tokens</code>/
          <code>maxCompletionTokens</code>, <code>input_price_per_1k</code>/
          <code>inputPricePer1k</code>, <code>output_price_per_1k</code>/
          <code>outputPricePer1k</code>, <code>image_price_per_1k</code>/
          <code>imagePricePer1k</code>, <code>created_at</code>/<code>createdAt</code>. Default{' '}
          <code>id</code>. <code>sortDir</code> is <code>asc</code> (default) or <code>desc</code> —
          use <code>sortBy: &quot;createdAt&quot;, sortDir: &quot;desc&quot;</code> for newest-first.
          Nullable sort columns place NULLs last.
        </p>
        <p style={{ ...MUTED, marginBottom: '1rem' }}>
          <code>verbose</code> and <code>fields</code> control payload size on the four list-style
          tools — see <strong style={{ color: 'var(--text)' }}>Pagination &amp; payload size</strong>{' '}
          below. <code>Model[]</code> in the return shapes means an array of the record documented in{' '}
          <strong style={{ color: 'var(--text)' }}>Model record schema</strong>.
        </p>
        <div className="stack">
          {TOOLS.map((tool) => (
            <div key={tool.name} className="card" style={NESTED_CARD}>
              <code style={NAME}>{tool.name}</code>
              <p style={{ margin: '0.4rem 0', ...MUTED }}>{tool.description}</p>
              <p style={{ ...SMALL_MUTED, margin: '0.6rem 0 0.2rem' }}>Arguments</p>
              <pre>
                <code>{tool.params}</code>
              </pre>
              <p style={{ ...SMALL_MUTED, margin: '0.6rem 0 0.2rem' }}>Returns (JSON text content)</p>
              <pre>
                <code>{tool.returns}</code>
              </pre>
              {tool.notes ? (
                <p style={{ ...SMALL_MUTED, marginTop: '0.6rem', marginBottom: 0 }}>{tool.notes}</p>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {/* ── Resources ───────────────────────────────────────────────────── */}
      <div className="card">
        <h2>Available Resources</h2>
        <p style={{ ...MUTED, marginBottom: '0.75rem' }}>
          Read registry data directly via MCP resource URIs (read-only, accessible via{' '}
          <code>resources/read</code>). Resources are never projected — they always return full
          records including <code>description</code> and <code>metadata</code>.
        </p>
        <div className="stack">
          {[
            {
              uri: 'registry://models',
              description:
                'Full list of models in the registry (every record, unfiltered, sorted by id — includes retired models)',
            },
            {
              uri: 'registry://status',
              description:
                'Current sync status (lastSuccessfulSync, lastAttemptedSync, lastError, recordCount). Unlike get_registry_status it does NOT include the live totalCount/availableCount/retiredCount.',
            },
            {
              uri: 'registry://models/{id}',
              description:
                'Details for a specific model — URL-encode the canonical ID (e.g. registry://models/anthropic%2Fclaude-sonnet-4-5)',
            },
          ].map((resource) => (
            <div key={resource.uri} className="card" style={NESTED_CARD}>
              <code style={NAME}>{resource.uri}</code>
              <p style={{ margin: '0.4rem 0', ...MUTED }}>{resource.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Prompts ─────────────────────────────────────────────────────── */}
      <div className="card">
        <h2>Available Prompts</h2>
        <p style={{ ...MUTED, marginBottom: '0.75rem' }}>
          Reusable prompt templates that guide model-selection and comparison workflows (accessible
          via <code>prompts/get</code>).
        </p>
        <div className="stack">
          {[
            {
              name: 'select_model',
              description: 'Generate a structured prompt to select the best model for a task',
              params:
                '{ task_description: string, budget_usd_per_1k_tokens?: string, min_context_length?: string }',
            },
            {
              name: 'compare_models_prompt',
              description: 'Generate a structured prompt to compare a set of models side-by-side',
              params: '{ model_ids: string }',
            },
          ].map((prompt) => (
            <div key={prompt.name} className="card" style={NESTED_CARD}>
              <code style={NAME}>{prompt.name}</code>
              <p style={{ margin: '0.4rem 0', ...MUTED }}>{prompt.description}</p>
              <pre>
                <code>{prompt.params}</code>
              </pre>
            </div>
          ))}
        </div>
      </div>

      {/* ── 5. Model record schema ──────────────────────────────────────── */}
      <div className="card">
        <h2>Model record schema</h2>
        <p style={MUTED}>
          Every tool that returns a model returns this record.{' '}
          <strong style={{ color: 'var(--text)' }}>
            All prices are USD per 1,000 tokens
          </strong>{' '}
          — the registry rescales OpenRouter&apos;s per-token figures on ingest, so no conversion is
          needed on your side. Timestamps are serialized as ISO-8601 UTC strings in JSON.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Meaning / units</th>
              </tr>
            </thead>
            <tbody>
              {MODEL_FIELDS.map(([field, type, nullable, meaning]) => (
                <tr key={field}>
                  <td>
                    <code>{field}</code>
                  </td>
                  <td style={SMALL_MUTED}>
                    <code>{type}</code>
                  </td>
                  <td style={SMALL_MUTED}>{nullable}</td>
                  <td style={SMALL_MUTED}>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>Reading modality</h3>
        <p style={MUTED}>
          OpenRouter writes modality as {'"inputs->outputs"'}, with <code>+</code>-separated
          modalities on each side — e.g. <code>{'text->text'}</code>,{' '}
          <code>{'text+image->text'}</code>, <code>{'text+image+file->text'}</code>,{' '}
          <code>{'text->image'}</code>.
        </p>
        <p style={MUTED}>
          <code>find_models_by_criteria</code>&apos;s <code>modality</code> filter is a{' '}
          <strong style={{ color: 'var(--text)' }}>case-insensitive substring match over the whole
          string</strong>, arrow included. That makes it easy to get vision detection backwards:
        </p>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem', marginBottom: 0 }}>
          <li>
            To find models that <em>accept</em> images, match the{' '}
            <strong style={{ color: 'var(--text)' }}>left (input) side</strong>:{' '}
            <code>{'modality: "image->"'}</code>, or the more specific{' '}
            <code>{'modality: "text+image->text"'}</code>.
          </li>
          <li>
            <code>{'text->image'}</code> is an image <strong style={{ color: 'var(--text)' }}>
              generator
            </strong>
            , not a vision model. A bare <code>{'modality: "image"'}</code> matches both, because it
            is a substring of each.
          </li>
        </ul>
      </div>

      {/* ── 6. Retirement semantics ─────────────────────────────────────── */}
      <div className="card">
        <h2>Retirement semantics</h2>
        <p style={MUTED}>
          The registry keeps every model it has ever seen. Models that vanish from OpenRouter&apos;s
          catalogue are flagged, not deleted, so historical IDs stay resolvable.
        </p>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem' }}>
          <li>
            <code>isAvailable</code> —{' '}
            <strong style={{ color: 'var(--text)' }}>this is the authoritative field</strong>. It is
            the only column the query layer ever filters on: <code>availableOnly: true</code>{' '}
            compiles to <code>is_available = TRUE</code>. If you need one boolean, use this one.
          </li>
          <li>
            <code>retiredAt</code> — a timestamp annotation only; it is never used as a filter. It
            marks when the <em>current</em> retirement episode began. If a model disappears and
            later returns, the upsert clears <code>retiredAt</code> back to <code>null</code>, so it
            is not a &quot;was ever retired&quot; history — it is reset on every comeback.
          </li>
          <li>
            <code>lastSeenAt</code> — the last sync in which OpenRouter still listed the model. For
            every row a sync touches it is written from the same timestamp as{' '}
            <code>fetchedAt</code>, so the two are identical. For a retired model both freeze at the
            last sync where the model was still present, because the retirement sweep updates only{' '}
            <code>isAvailable</code> and <code>retiredAt</code>.
          </li>
        </ul>
        <p style={MUTED}>
          <strong style={{ color: 'var(--text)' }}>Can they disagree?</strong> No.{' '}
          <code>isAvailable</code> and <code>retiredAt</code> are written together by the same
          statements inside a single transaction — the upsert sets{' '}
          <code>retired_at = NULL, is_available = TRUE</code> together, and the retirement sweep
          sets <code>is_available = FALSE</code> and <code>retired_at</code> together. A partial or
          failed sync rolls back both, so it cannot leave a mixed state. A read of the whole
          production table found zero rows in either inconsistent combination.
        </p>
        <p style={MUTED}>
          <strong style={{ color: 'var(--text)' }}>Whole-provider disappearances are covered.</strong>{' '}
          The sweep is a single global <code>UPDATE</code> over every row the current sync did not
          touch, so a provider vanishing from OpenRouter&apos;s catalogue entirely is retired like
          any other absence. It used to run per provider, over only the providers present in the
          response — which by construction could never see a provider that had gone.
        </p>
        <p style={MUTED}>
          <strong style={{ color: 'var(--text)' }}>Guarded by volume, not by partitioning.</strong>{' '}
          A global sweep makes a truncated upstream response dangerous, so if a sync fetches fewer
          than 80% of the models currently marked available, the sweep is skipped and the run is
          recorded with <code>partial: true</code> in <code>get_sync_history</code>. The catalogue
          still updates; only retirement waits for a sync that looks whole. Deferring retirement by
          a day is recoverable — retiring most of the catalogue on one bad response is not. A run
          of consecutive <code>partial</code> entries means retirement data is going stale and
          upstream should be checked.
        </p>
        <p style={{ ...SMALL_MUTED, marginBottom: 0 }}>
          Historical footnote: a small number of rows were retired before the{' '}
          <code>retiredAt</code> column existed, and had it backfilled to equal{' '}
          <code>fetchedAt</code>. For those rows <code>retiredAt</code> is the last sync the model{' '}
          <em>was</em> present rather than the first sync it was missing. They are identifiable by{' '}
          <code>retiredAt === lastSeenAt</code>; every row retired since then has{' '}
          <code>retiredAt &gt; lastSeenAt</code>. Separately, note that{' '}
          <code>providerExpirationAt</code> is a provider-announced expiry date and is completely
          independent of these three fields.
        </p>
      </div>

      {/* ── 7. Pagination & payload size ────────────────────────────────── */}
      <div className="card">
        <h2>Pagination &amp; payload size</h2>

        <h3 style={SUBHEAD}>limit / offset</h3>
        <p style={MUTED}>
          All list-style tools take <code>limit</code> and <code>offset</code>, applied after
          sorting. Defaults and caps differ per tool:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Tool</th>
                <th>Default limit</th>
                <th>Max limit</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['list_models', '50', '500'],
                ['search_models', '20', '100'],
                ['find_models_by_criteria', '50', '200'],
                ['semantic_search', '10', '50'],
                ['get_sync_history', '50', '200'],
              ].map(([tool, def, max]) => (
                <tr key={tool}>
                  <td>
                    <code>{tool}</code>
                  </td>
                  <td style={SMALL_MUTED}>{def}</td>
                  <td style={SMALL_MUTED}>{max}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          <code>list_models</code>&apos; default limit is{' '}
          <strong style={{ color: 'var(--text)' }}>50</strong> (it was 500) — raise it explicitly for
          bulk pulls. With the default <code>sortBy: &quot;id&quot;</code> paging is exact:{' '}
          <code>id</code> is unique, so successive pages are stable and disjoint. When you sort by
          any other column there is no secondary tiebreak, so rows that tie can shift between pages;
          for an exhaustive pull, either keep the default sort or pull everything in one page and
          sort client-side.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>verbose and fields</h3>
        <p style={MUTED}>
          <code>list_models</code>, <code>search_models</code>, <code>find_models_by_criteria</code>{' '}
          and <code>semantic_search</code> accept two projection arguments.{' '}
          <code>get_model</code>, <code>resolve_model</code>, <code>compare_models</code> and the{' '}
          <code>registry://</code> resources ignore them and always return full records.
        </p>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem' }}>
          <li>
            <code>verbose</code> (boolean, default{' '}
            <strong style={{ color: 'var(--text)' }}>false</strong>) — when false,{' '}
            <code>description</code> and <code>metadata</code> are{' '}
            <strong style={{ color: 'var(--text)' }}>omitted from every record</strong>. Those two
            are by far the largest fields (free-form prose, and the entire unmapped remainder of
            OpenRouter&apos;s model object), which is why they are off by default. Pass{' '}
            <code>verbose: true</code> if you need them.
          </li>
          <li>
            <code>fields</code> (string array, no default) — explicit projection using camelCase{' '}
            <code>Model</code> field names. It{' '}
            <strong style={{ color: 'var(--text)' }}>wins over verbose</strong>. <code>id</code> is
            always included and comes first; the rest appear in the order you list them. Only the
            names in the Model field table above are accepted — an unrecognised one is a{' '}
            <strong style={{ color: 'var(--text)' }}>validation error</strong>, not a silently
            missing field, so a typo cannot be mistaken for absent data. Note that{' '}
            <code>fields</code> takes camelCase only, unlike <code>sortBy</code>, which accepts
            both spellings. An empty array is treated as not supplied.
          </li>
        </ul>
        <pre>
          <code>{`// Cheapest possible catalogue pull: 4 fields per record, no limit
await mcp.callTool('list_models', {
  fields: ['displayName', 'contextLength', 'inputPricePer1k', 'outputPricePer1k'],
});
// → { models: [{ id, displayName, contextLength, inputPricePer1k, outputPricePer1k }, …],
//      count: 452, total: 452 }`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          <strong style={{ color: 'var(--text)' }}>Omitting <code>limit</code> returns everything</strong>{' '}
          — there is no cap, so a full-catalogue pull needs no pagination and no size probe. Confirm you
          got it all by checking <code>count === total</code>. Supply <code>limit</code> only when you
          deliberately want a page, and pair it with <code>offset</code>.
        </p>

        <h3 style={{ ...SUBHEAD, marginTop: '1.25rem' }}>
          Counts: count vs total vs recordCount vs totalCount
        </h3>
        <p style={MUTED}>
          These four numbers legitimately differ. They answer different questions:
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Where</th>
                <th>Means</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>count</code>
                </td>
                <td style={SMALL_MUTED}>list-style tool responses</td>
                <td style={SMALL_MUTED}>
                  Records in <em>this page</em>. Affected by <code>limit</code> and{' '}
                  <code>offset</code>.
                </td>
              </tr>
              <tr>
                <td>
                  <code>total</code>
                </td>
                <td style={SMALL_MUTED}>
                  <code>list_models</code>, <code>search_models</code>,{' '}
                  <code>find_models_by_criteria</code>
                </td>
                <td style={SMALL_MUTED}>
                  Records matching your filter/search/criteria, ignoring <code>limit</code> and{' '}
                  <code>offset</code>. Use it to drive pagination.{' '}
                  <code>semantic_search</code> has no <code>total</code>.
                </td>
              </tr>
              <tr>
                <td>
                  <code>recordCount</code>
                </td>
                <td style={SMALL_MUTED}>
                  <code>get_registry_status</code>
                </td>
                <td style={SMALL_MUTED}>
                  How many models OpenRouter returned during the last{' '}
                  <strong style={{ color: 'var(--text)' }}>successful</strong> sync — a
                  point-in-time count of that fetch, not a count of table rows. A failed sync never
                  overwrites it.
                </td>
              </tr>
              <tr>
                <td>
                  <code>totalCount</code>
                </td>
                <td style={SMALL_MUTED}>
                  <code>get_registry_status</code>
                </td>
                <td style={SMALL_MUTED}>
                  Live row count of the registry, which accumulates every model ever seen.{' '}
                  <code>totalCount = availableCount + retiredCount</code>.
                </td>
              </tr>
              <tr>
                <td>
                  <code>availableCount</code> / <code>retiredCount</code>
                </td>
                <td style={SMALL_MUTED}>
                  <code>get_registry_status</code>
                </td>
                <td style={SMALL_MUTED}>
                  Live rows with <code>isAvailable</code> true / false respectively.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p style={{ ...MUTED, marginTop: '0.75rem', marginBottom: 0 }}>
          So <code>list_models</code> reporting a larger <code>total</code> than{' '}
          <code>recordCount</code> is expected, not a bug: the default{' '}
          <code>availableOnly: false</code> includes retired rows. Note also that{' '}
          <code>availableCount</code> is not exactly the last sync&apos;s catalogue — it is that
          catalogue plus any rows stranded by the whole-provider gap described under{' '}
          <strong style={{ color: 'var(--text)' }}>Retirement semantics</strong>. Do not assume{' '}
          <code>availableOnly: true</code> returns exactly <code>recordCount</code> records; it
          normally returns slightly more.
        </p>
      </div>

      {/* ── 8. Client configuration ─────────────────────────────────────── */}
      <div className="card">
        <h2>Claude Code</h2>
        <p style={MUTED}>
          Add the server with one command — Claude Code runs the OAuth browser login itself:
        </p>
        <pre>
          <code>{`claude mcp add --transport http registry ${baseUrl}/api/mcp`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          The first time an agent uses a registry tool, a browser opens to authorize; after that it
          stays connected.
        </p>
      </div>

      <div className="card">
        <h2>Cursor</h2>
        <p style={MUTED}>
          Add to <code>~/.cursor/mcp.json</code> (or the project&apos;s <code>.cursor/mcp.json</code>).
          Cursor completes the OAuth flow in the browser on first use:
        </p>
        <pre>
          <code>
            {JSON.stringify(
              {
                mcpServers: {
                  'openrouter-registry': {
                    url: `${baseUrl}/api/mcp`,
                  },
                },
              },
              null,
              2
            )}
          </code>
        </pre>
      </div>

      <div className="card">
        <h2>Claude Desktop Configuration</h2>
        <p style={MUTED}>
          Add this to your Claude Desktop MCP configuration. It will prompt you to authorize in the
          browser on first use:
        </p>
        <pre>
          <code>
            {JSON.stringify(
              {
                mcpServers: {
                  'openrouter-registry': {
                    url: `${baseUrl}/api/mcp`,
                    transport: 'streamable-http',
                  },
                },
              },
              null,
              2
            )}
          </code>
        </pre>
      </div>

      <div className="card">
        <h2>GitHub Copilot (VS Code)</h2>
        <p style={MUTED}>
          Add to your workspace{`'`}s <code>.vscode/mcp.json</code> (or under{' '}
          <code>&quot;mcp&quot;</code> in <code>settings.json</code>):
        </p>
        <pre>
          <code>
            {JSON.stringify(
              {
                servers: {
                  'openrouter-registry': {
                    type: 'http',
                    url: `${baseUrl}/api/mcp`,
                  },
                },
              },
              null,
              2
            )}
          </code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          VS Code completes the OAuth browser login automatically. Only if your client can&apos;t do
          OAuth discovery, fall back to a bearer token in a <code>headers</code> object as{' '}
          <code>{`"Authorization": "Bearer YOUR_ACCESS_TOKEN"`}</code>.
        </p>
      </div>

      <div className="card">
        <h2>OpenAI Codex CLI</h2>
        <p style={MUTED}>
          Add to <code>~/.codex/config.toml</code>:
        </p>
        <pre>
          <code>{`[mcp_servers.openrouter-registry]\nurl = "${baseUrl}/api/mcp"`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          Codex performs OAuth discovery automatically. Only if it can&apos;t, add{' '}
          <code>bearer_token = &quot;YOUR_ACCESS_TOKEN&quot;</code> as a fallback.
        </p>
      </div>

      {/* ── Usage examples ──────────────────────────────────────────────── */}
      <div className="card">
        <h2>Usage Examples</h2>
        <div className="stack">
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Resolve a model ID in your agent:
            </p>
            <pre>
              <code>{`// In your agent/assistant:
const result = await mcp.callTool('resolve_model', { input: 'anthropic/claude-sonnet-4-5' });
// → { resolved: 'anthropic/claude-sonnet-4-5', source: 'canonical', found: true, model: {...} }`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Page through the catalogue using <code>total</code>:
            </p>
            <pre>
              <code>{`const page = await mcp.callTool('list_models', { limit: 50, offset: 0 });
// → { models: [...50], count: 50, total: 452 }   ← keep paging while offset + count < total`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Search models by name or provider, newest first:
            </p>
            <pre>
              <code>{`const results = await mcp.callTool('search_models', {
  query: 'claude',
  limit: 10,
  sortBy: 'createdAt',   // camelCase and created_at are equivalent
  sortDir: 'desc',
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Find models by natural language description:
            </p>
            <pre>
              <code>{`const results = await mcp.callTool('semantic_search', {
  query: 'fast cheap summarization model with large context',
  limit: 10,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Filter for vision models — match the INPUT side of the modality arrow:
            </p>
            <pre>
              <code>{`const visionModels = await mcp.callTool('find_models_by_criteria', {
  modality: 'image->',   // NOT 'text->image', which is an image GENERATOR
  limit: 20,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Find models within a budget and context window (prices are USD per 1,000 tokens):
            </p>
            <pre>
              <code>{`const models = await mcp.callTool('find_models_by_criteria', {
  maxInputPricePer1k: 0.005,
  maxOutputPricePer1k: 0.015,
  minContextLength: 32000,
  limit: 20,
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Ask for a description without pulling every field:
            </p>
            <pre>
              <code>{`const models = await mcp.callTool('list_models', {
  limit: 20,
  fields: ['displayName', 'description'],   // id is always included
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>Compare models side-by-side:</p>
            <pre>
              <code>{`const comparison = await mcp.callTool('compare_models', {
  ids: ['anthropic/claude-sonnet-4-5', 'openai/gpt-4o', 'google/gemini-pro-1.5'],
});`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Reconcile counts before a bulk pull:
            </p>
            <pre>
              <code>{`const status = await mcp.callTool('get_registry_status', {});
// → { status: { lastSuccessfulSync, lastAttemptedSync, lastError,
//               recordCount, totalCount, availableCount, retiredCount } }`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Read the model list as a resource:
            </p>
            <pre>
              <code>{`const result = await mcp.readResource('registry://models');
// → { contents: [{ mimeType: 'application/json', text: '{"models":[...]}' }] }`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Use the select_model prompt to guide model selection:
            </p>
            <pre>
              <code>{`const prompt = await mcp.getPrompt('select_model', {
  task_description: 'Summarize long legal documents',
  budget_usd_per_1k_tokens: '0.005',
  min_context_length: '32000',
});
// → prompt messages that instruct the model how to pick the best option`}</code>
            </pre>
          </div>
          <div>
            <p style={{ ...SMALL_MUTED, marginBottom: '0.4rem' }}>
              Use the compare_models_prompt for a structured comparison:
            </p>
            <pre>
              <code>{`const prompt = await mcp.getPrompt('compare_models_prompt', {
  model_ids: 'anthropic/claude-sonnet-4-5,openai/gpt-4o',
});`}</code>
            </pre>
          </div>
        </div>
      </div>

      {/* ── 9. Sync cadence & on-demand trigger ─────────────────────────── */}
      <div className="card">
        <h2>Sync cadence &amp; on-demand trigger</h2>
        <p style={MUTED}>
          The registry refreshes <strong style={{ color: 'var(--text)' }}>daily at 00:00 UTC</strong>{' '}
          via Vercel Cron, configured in <code>apps/mcp/vercel.json</code>. Each run fetches
          OpenRouter&apos;s entire catalogue in one unpaginated request, upserts it, and sweeps
          models that have disappeared.
        </p>
        <pre>
          <code>{`// apps/mcp/vercel.json
{
  "crons": [
    {
      "path": "/api/cron/sync",
      "schedule": "0 0 * * *"
    }
  ]
}`}</code>
        </pre>
        <p style={{ ...MUTED, marginTop: '0.75rem' }}>
          The same endpoint can be triggered on demand (it is also wired to the admin panel&apos;s
          Sync action):
        </p>
        <pre>
          <code>{`curl -sS ${baseUrl}/api/cron/sync -H "Authorization: Bearer $CRON_SECRET"`}</code>
        </pre>
        <ul style={{ ...MUTED, paddingLeft: '1.25rem', marginTop: '0.75rem', marginBottom: 0 }}>
          <li>
            <code>GET</code>, not <code>POST</code>. When <code>CRON_SECRET</code> is set the bearer
            token must match exactly, otherwise the route returns <code>401</code>.
          </li>
          <li>
            In production with <code>CRON_SECRET</code> unset, the route fails closed with{' '}
            <code>503 &quot;Cron auth not configured&quot;</code> on every invocation — set the
            secret and redeploy.
          </li>
          <li>
            A sync writes one <code>get_sync_history</code> row. It is opened as{' '}
            <code>status: &quot;running&quot;</code> (<code>success: null</code>) before OpenRouter
            is contacted and updated in place when the attempt ends, so a{' '}
            <code>success: false</code> row is always a genuine failure and always carries an{' '}
            <code>error</code>. Rows written before this fix show as <code>running</code> when they
            were start markers.
          </li>
          <li>
            After a successful sync, embeddings are generated for any models that gained a
            description, so <code>semantic_search</code> coverage catches up on the following run.
          </li>
        </ul>
      </div>
    </div>
  );
}

# Next

Updated: 2026-11-27

## Where it stands

An MCP server that gives coding assistants one current list of OpenRouter models, with alias resolution and validation, plus a reference web app with a chat demo and an admin page. It answers at https://openrouter-registry.aroughidea.com/ (the docs and demo) and https://openrouter-registry-mcp.aroughidea.com/ (the MCP server).

On 2026-11-27 TJ asked for sign-in: "The demo should require workos, correct? Perhaps the mcp as well? The demo should register like any other client", with a list of addresses he keeps, and any model for those signed in. Built on `claude/graphwise-pr2-review-publish-gbkfax`:
- The MCP server's authorization endpoint sends a person to WorkOS AuthKit and issues a code only for a verified address on `ALLOWED_EMAILS`; every token carries the person and is checked against the list on each use.
- The chat lives in the demo, which owns its model (TJ: "rework 38 so the demo owns its model"): it runs on the web site's own OpenRouter key and calls the registry's tools through `/api/mcp` with the visitor's token. The MCP server's own `/api/chat` is removed, so its key pays only for sync and embeddings.
- Registering a service client needs `OAUTH_REGISTRATION_ACCESS_TOKEN`; interactive clients may still register, since they must sign in.
- The web demo is an ordinary public client of the MCP server: the visitor signs in through it, and each message goes with the visitor's own token.
The same day, sign-up was briefly closed (`OAUTH_DISABLE_REGISTRATION=true`) and reopened at TJ's word.

## Next step

TJ sets the sign-in up, then merges the pull request:
1. In WorkOS, add the redirect URI `https://openrouter-registry-mcp.aroughidea.com/api/oauth/workos/callback`.
2. On the MCP site on Vercel (`openrouter-mcp-registry-mcp`): `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI` (that address), `ALLOWED_EMAILS` (his address, and anyone else's).
3. Claude registers the demo as a client and sets `MCP_OAUTH_CLIENT_ID` and `CHAT_SESSION_SECRET` on the web site (`openrouter-mcp-registry-web`). The two sites get a key each: the current shared key becomes the MCP server's (`aroughidea-openrouter-mcp-registry-mcp-prod`), and the web site gets a new one (`aroughidea-openrouter-mcp-registry-web-prod`) for the chat.
Then a real sign-in from Claude and from the demo.

## After that

- Pull request #36 (GitHub sign-in for `/admin`, and the demo renamed to Registry Chat) touches the demo page and needs rebasing onto this work.
- Check the admin page's list of registered clients for service clients registered by others before 2026-11-27; they keep working until revoked.
- Check the changelog and README still match the code.

## Blocked or waiting

- The sign-in settings above, from TJ. Until they are on the MCP site, production refuses every interactive client once this is merged, so merge only after setting them.

## Open questions

- Should Agent Design Studio's service client keep calling `semantic_search` (it spends a little, per search), or move to a person's sign-in?

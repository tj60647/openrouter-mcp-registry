# Next

Updated: 2026-11-22

## Where it stands

An MCP server that gives coding assistants one current list of OpenRouter models, with alias resolution and validation, plus a reference web app with a chat demo and an admin page. It answers at https://openrouter-registry.aroughidea.com/ and its `/api/health` returns 200; the last merged work (2026-07-30) brought the docs in line with the code, added a changelog and guarded `/mcp-info` against drifting from the real tool schemas.

## Next step

Finish pull request #36 (GitHub sign-in for `/admin`, and the demo renamed to Registry Chat): its checks pass and it can merge. Create the GitHub OAuth app with the callback URL its description gives, set its variables on the web app, then merge and try a sign-in.

## After that

- Check the changelog and README still match the code after #36.

## Blocked or waiting

- Pull request #36 waits on TJ's review and the OAuth app's setup.

## Open questions

- This plan was drafted by Claude on 2026-11-22 from the code and its history. Is the next step right?

# KAP server

## Experimental Kiki MCP edge

External delegation is off by default. Start KAP with both
`KIMI_CODE_EXPERIMENTAL_EXTERNAL_DELEGATION_MCP=true`, one admitted
`KIKI_EXTERNAL_PRINCIPAL_ID`, `KIKI_EXTERNAL_SESSION_ID`, and a dedicated
`KIKI_EXTERNAL_DELEGATION_TOKEN`. A host may also provision that exact Session
at startup by passing `KIKI_EXTERNAL_WORKSPACE_PATH`,
`KIKI_EXTERNAL_MODEL_ALIAS`, and `KIKI_EXTERNAL_THINKING_EFFORT` together;
an existing Session must retain the same workspace/model binding. Then launch
`kiki-mcp` with these environment variables:

- `KIKI_KAP_ENDPOINT`: KAP origin, such as `http://127.0.0.1:58627`
- `KIKI_KAP_TOKEN`: KAP bearer token
- `KIKI_DELEGATION_TOKEN`: the dedicated external-delegation credential
- `KIKI_SESSION_ID`: the operator-selected Session
- `KIKI_WORKSPACE_PATH`: the absolute workspace bound to that Session

The MCP caller can choose a listed named profile, task name, and prompt. It
cannot choose the endpoint, token, Session, workspace, model credentials,
permission mode, tools, or profile definitions.

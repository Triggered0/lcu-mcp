# Phase 3: LCU OpenAPI / Swagger Schema Introspection (`lol_schema`)

## Goal

Provide zero-guesswork exploration of the internal League Client API by querying the client's built-in Swagger/OpenAPI v2 specifications (`GET /swagger/v2/swagger.json`):
1. **Endpoint Introspection**: Query exact path parameters, query parameters, request bodies, and responses for any LCU endpoint.
2. **Model & Type Definitions**: Resolve `$ref` schemas and view model structures (e.g. `LolChampSelectChampSelectSession`).
3. **In-Memory Caching & $ref Resolution**: Cache the ~3MB Swagger JSON in memory with optional `refresh: true`, and automatically dereference nested definition references for developer and LLM convenience.

## Architecture

```
                          ┌───────────────────────────┐
                          │   GET /swagger/v2/swagger.json
                          └─────────────┬─────────────┘
                                        │
                                        ▼
                             ┌─────────────────────┐
                             │   LcuSchemaService  │ (In-memory cached)
                             └──────────┬──────────┘
                                        │
                         ┌──────────────┴──────────────┐
                         ▼                             ▼
                 Query by Path/Method          Query by Model Name
                 (with auto $ref expand)       (definitions look up)
                         │                             │
                         └──────────────┬──────────────┘
                                        ▼
                               ┌─────────────────┐
                               │   lol_schema    │
                               └─────────────────┘
```

## Locked Decisions

| Decision | Rationale |
|---|---|
| In-memory caching with on-demand refresh | `swagger.json` is large (~2-5 MB) and static during a game session. Fetching it repeatedly is wasteful and adds latency. Caching in memory with `refresh: true` provides instant responses. |
| In-place `$ref` expansion | LLMs consume extra tokens and turns when they have to chase references. Resolving the immediate referenced definition inline saves context and round-trips. |
| Substring path search | Endpoints can be searched flexibly (e.g., `"champ-select"` finds `/lol-champ-select/v1/session`). |
| Read-only safe | `GET /swagger/v2/swagger.json` is a safe, idempotent read-only endpoint. |

## Tool Specification: `lol_schema`

- **Input Schema**:
  ```ts
  {
    path: z.string().optional().describe('LCU path or keyword to search (e.g. /lol-lobby/v2/lobby or "gameflow")'),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('Filter operations by HTTP method'),
    model: z.string().optional().describe('Look up a specific definition/model schema name (e.g. "LolLobbyLobbyDto")'),
    refresh: z.boolean().default(false).describe('Force re-fetch the swagger schema from the League Client')
  }
  ```
- **Responses**:
  - If no filters: returns API metadata, tags, and summary list of paths.
  - If `path` provided: returns matching paths, operations, parameters, request body schemas, and expanded definitions.
  - If `model` provided: returns matching definition schema.

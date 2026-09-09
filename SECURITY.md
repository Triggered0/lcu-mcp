# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2.0 | No        |

## Security Architecture & Design Guarantees

`lcu-mcp` is designed to interact with a locally running League of Legends client. Security boundaries are maintained through:

1. **Pinned TLS Verification:** The server validates the League Client's self-signed TLS certificates against Riot's vendored root CA (`certs/riotgames.pem`). It never disables certificate validation (`rejectUnauthorized: false`).
2. **Ingest-Time Credential Scrubbing:** Authentication passwords discovered from the client lockfile are used strictly in-process for HTTP headers. Passwords are scrubbed at ingest time before entering buffers, logs, CDP URLs, error messages, or MCP tool returns.
3. **Write Allowlist Guardrails:** Mutating verbs (`POST`, `PUT`, `PATCH`, `DELETE`) are refused by default unless explicitly configured in the write allowlist (`config/allowlist.json`).
4. **Local Transport Only:** Operates exclusively over `stdio` without opening external network ports.

## Reporting a Vulnerability

If you discover a potential security vulnerability in `lcu-mcp`, please report it responsibly:

- Please **do not** open a public issue.
- Report security issues via [GitHub Private Vulnerability Reporting](https://github.com/Triggered0/lcu-mcp/security/advisories/new) or by emailing the maintainer.
- Include detailed reproduction steps and affected versions.

We appreciate your efforts to keep this project secure.

# Contributing to lcu-mcp

Thank you for your interest in contributing to `lcu-mcp`!

## Prerequisites

- **Node.js**: >= 24.0.0 (native ESM, no transpilation step)
- **Operating System**: Windows (required for League client lockfile and Pengu Loader integration)
- **Git**

## Getting Started

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/Triggered0/lcu-mcp.git
   cd lcu-mcp
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Run the test suite:**
   ```bash
   npm test
   ```

## Development Guidelines

- **Test-Driven Development (TDD):**
  Write tests before implementing features or fixing bugs. Unit tests use Node's native test runner (`node:test`) and strict assertions (`node:assert/strict`).
- **Zero-Bloat Dependency Policy:**
  Runtime dependencies are strictly limited to core essentials (`@modelcontextprotocol/sdk`, `zod`, `ws`). Do not introduce new runtime dependencies without prior discussion.
- **Security & Password Sanitization:**
  Passwords must never appear in buffers, logs, tool outputs, or error messages. Use `redactSecrets` at ingest time.
- **Pure ESM:**
  The project uses native ECMAScript Modules (`"type": "module"`). Use `#private` fields for encapsulation.
- **Linting & Syntax Check:**
  Verify syntax across all JavaScript files prior to committing:
  ```bash
  npm run lint
  ```

## Pull Request Process

1. Create a feature branch:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Commit your changes following conventional commit style (`feat:`, `fix:`, `docs:`, `chore:`).
3. Ensure all tests pass and linting is clean (`npm run lint && npm test`).
4. Submit a Pull Request describing your changes, motivation, and verification steps.

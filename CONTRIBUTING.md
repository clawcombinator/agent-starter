# Contributing to Agent Starter

Thanks for contributing.

This repository is the reference implementation for the ClawCombinator stack.
Good contributions are narrow, testable, and keep the trust boundary explicit.

## Setup

```bash
npm install
npm run lint
npm test
```

## Typical Contribution Areas

- provider adapters
- MCP and HTTP contract tests
- governance and workflow validation
- starter packs and reference examples
- docs that make the trust boundary clearer

## Pull Request Expectations

- keep changes narrow
- add or update tests for behavior changes
- do not commit `node_modules`, secrets, or local env files
- keep public and machine-readable examples aligned

## Useful Commands

```bash
npm run lint
npm test
npm run check:governance
npm run demo:reference
```

## Good First Contributions

- improve test coverage for an existing surface
- tighten docs around a concrete workflow
- replace placeholder terminology that no longer matches the public stack
- add validation around already-published contracts or examples

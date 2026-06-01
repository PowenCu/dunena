# Claude Agent Workspace

This file serves as a verification and workflow synchronization point for Claude agents working on the Dunena project.

## Responsibilities
- Maintain and enhance user-facing documentation.
- Sync documentation changes with any updates to the REST API, WebSocket API, CLI, or configuration parameters.

## Current Status
- **Active Task**: Redesigned static HTML/CSS/JS documentation site.
- **Workspace**: Operations should be localized to `packages/platform/docs`.

## Workflows
1. Update static HTML documentation pages in `packages/platform/docs/` directly when adding or modifying features.
2. Regenerate the OpenAPI specification when changing API endpoints by running `bun run docs:api`.
3. Test documentation locally by running `bun run dev` and browsing to `/docs`.

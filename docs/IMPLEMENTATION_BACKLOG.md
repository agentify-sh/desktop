# Troly Win Agent - Implementation Backlog

## Milestone 0 - Bootstrap (current)
- [x] Clone fork and verify baseline structure
- [x] Rebrand package/runtime labels to Troly Win Agent
- [x] Keep compatibility aliases for existing commands
- [x] Document foundation decision (ADR)

## Milestone 1 - Troly Identity and Config Foundation
- [ ] Introduce a central Troly config module for:
  - [ ] API base URL
  - [ ] Auth endpoint paths
  - [ ] Key sync endpoint paths
  - [ ] Environment variable naming policy
- [ ] Add runtime guardrails:
  - [ ] Validate required env at startup
  - [ ] Clear error messages for missing config
- [ ] Define state versioning strategy for future migrations

## Milestone 2 - Auth and Key Sync Integration
- [ ] Implement Troly login/session handshake client
- [ ] Replace/extend provider-centric session assumptions with Troly session model
- [ ] Add key sync client and refresh policy
- [ ] Add token/key failure recovery paths
- [ ] Add tests for auth/key success and failure flows

## Milestone 3 - Workflow Parity with Troly Mac Agent
- [ ] Map core mac-agent workflow contracts to Windows implementation
- [ ] Implement prompt/profile sync primitives
- [ ] Implement artifact upload/download flow compatible with Troly backend
- [ ] Define Windows startup behavior and tray policy

## Milestone 4 - Packaging and Internal Release
- [ ] Finalize Windows build and installer metadata
- [ ] Internal release channel process
- [ ] Crash/log collection policy for internal support
- [ ] Security review checklist and sign-off

## Testing Strategy
- [ ] Unit tests for config/auth/key modules
- [ ] Integration tests for HTTP API + session lifecycle
- [ ] Smoke script for Windows startup, login, query, shutdown

## Open Decisions
- [ ] Endpoint contract parity with existing mac agent (exact payload shapes)
- [ ] Backward compatibility policy for existing agentify_* MCP tool names
- [ ] Scope for first production milestone (minimum usable feature set)

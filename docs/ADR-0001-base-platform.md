# ADR-0001: Use Agentify Desktop as the Base Platform for Troly Win Agent

## Status
Accepted - 2026-05-15

## Context
Troly needs a Windows desktop agent with feature parity to the current mac agent direction:
- Local control center UI
- Stable session/tab management
- Local automation runtime with MCP integration
- Practical Windows packaging and operations

The product direction is explicit: prioritize existing open-source foundations and avoid building from scratch.

## Decision
Use the current repository (Agentify Desktop fork) as the foundation for Troly Win Agent.

## Why This Decision
1. Architecture is already close to target use case:
- Main process orchestrator and local UI
- HTTP local control API
- MCP server/tooling
- State/token/artifact handling

2. Windows viability already exists in code paths:
- Windows spawn behavior and packaging config
- Cross-platform backend modes

3. Security model is workable for internal rollout:
- Loopback-only local API
- Local bearer token flow

4. Time-to-value is better than greenfield:
- Fork + phased integration is faster than building core runtime, control plane, and tooling from zero.

## Consequences
Positive:
- Faster delivery for first Troly Win Agent milestone.
- Lower implementation risk on desktop runtime concerns.
- Easier iterative replacement of provider-specific logic with Troly logic.

Negative:
- Must manage MPL-2.0 obligations correctly.
- Existing assumptions around external vendor tabs need adaptation for Troly-first workflows.
- Rebrand and compatibility cleanup is required across docs, CLI, runtime labels, and APIs.

## Scope of Phase 1
- Rebrand package/runtime labels for trolywin identity.
- Keep backward-compatible CLI aliases temporarily.
- Introduce implementation backlog and milestones.

## Out of Scope for This ADR
- Final Troly auth endpoint design details.
- Protocol details for key sync and policy sync.
- Full UI redesign.

# Engineering Hub — Business Analysis and Product Requirements
**Version:** 1.0 draft | **Date:** 2026-11-21 | **Status:** Proposed for stakeholder review | **Baseline:** `main` as inspected 2026-11-21

## Document control
Owner: Product owner (TBD). Business analyst: initial research draft. Approval: not yet obtained. This package is a proposal, not a claim that the features exist or have been approved.

## Reading order
1. [01 Product vision and business case](01-product-vision.md)
2. [02 Current-state assessment and competitive research](02-discovery-and-benchmark.md)
3. [03 Product requirements document](03-product-requirements.md)
4. [04 User journeys and UX](04-user-journeys.md)
5. [05 Integration and technical requirements](05-integrations-and-architecture.md)
6. [06 Data, security and non-functional requirements](06-data-security-nfr.md)
7. [07 Prioritized backlog and delivery roadmap](07-backlog-and-roadmap.md)
8. [08 Acceptance criteria, UAT and traceability](08-acceptance-and-uat.md)
9. [09 Decisions, assumptions, dependencies and risks](09-decisions-and-risks.md)
10. [10 Comprehensive UX audit and redesign](10-ux-audit-and-redesign.md)
11. [11 Red-team product feasibility and negative business review](11-red-team-product-feasibility.md)
12. [12 Business operations growth strategy and 2026 market research](12-business-operations-growth-strategy.md)
13. [13 Market-led product change request](13-market-led-product-change-request.md)
14. [14 MVP functional requirements and acceptance](14-mvp-functional-requirements-and-acceptance.md)
15. [15 Stakeholder business case and validation plan](15-stakeholder-business-case-and-validation-plan.md)

## Executive decision
**Updated recommendation (documents 11–15):** Validate a narrow local-first **unfinished-work continuity and recovery** wedge before broad provider generalization. The earlier multi-provider vision remains a longer-term option, not approved MVP scope. **Do not** replace coding agents, Git clients, or issue trackers.

## Priority legend
P0 = required for portable foundation/MVP; P1 = high-value next release; P2 = later/experimental. Must/Should/Could/Won't are proposed MoSCoW designations. Every requirement has an ID for traceability.

## Research method and limits
Evidence includes direct review of repository tree and selected source files, the repository README, and external project/API documentation listed in 02. No stakeholder interviews, user telemetry, production deployment review, or end-to-end test execution were conducted. Product assumptions and effort estimates require validation.

## Change management
Requirements should be refined through issues/PRs. Track requirement ID, owner, acceptance tests, dependency, and decision. Changes affecting safety, permissions, identity, storage, or existing behavior require explicit review. Do not treat estimates or mock examples as observed production metrics.

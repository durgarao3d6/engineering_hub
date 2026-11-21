# 15 — Stakeholder Business Case, Prioritization and Validation Plan
**Date:** 2026-11-21 | **Status:** Decision proposal | **Approval:** Pending

## Stakeholder recommendation
**Conditional GO:** invest in a short discovery-and-prototype cycle, not a generalized platform build. Preserve the personal-use product even if commercialization fails. Product outcome: find, resume and safely hand off unfinished local engineering work.

## Alternatives considered
| Option | Value | Cost/risk | Stakeholder view |
|---|---|---|---|
| A: Maintain personal tool | Certain value to current user | Low scope, limited revenue | Safe fallback |
| B: Radar + handoff + recovery evidence | Reuses existing code, testable outcome | Demand unproven; Git safety | **Recommended experiment** |
| C: Universal multi-agent dashboard | Broad narrative | Vendor feature overlap, high maintenance | Reject initially |
| D: Team verification SaaS | Potential team budgets | Security, shared state, sales burden | Explore only after B |
| E: Agent-neutral CLI only | Lower adoption friction | Less visual discovery; smaller packaging | A/B test with B |

## Competitor-informed build/buy/avoid
| Capability | External reference | Decision |
|---|---|---|
| Worktree creation/switching | Worktrunk: https://github.com/max-sixty/worktrunk | **Avoid parity**; focus on recovery context |
| Multi-agent session monitoring | AgentHUD: https://github.com/neochoon/agenthud | **Avoid as flagship**; consume optional metadata |
| Session replay/analytics | AgentLens: https://github.com/QJ-Chen/agentlen | **Avoid** full transcript viewer |
| Interactive agent terminals | AI Agent Session Center: https://github.com/coding-by-feng/ai-agent-session-center | **Avoid** terminal orchestration |
| Existing agent ecosystems | Claude Code and Codex official docs | Integrate through portable CLI/export, don't replace |
| GitHub issues/PRs | GitHub REST API | **Defer** until pilot requests justify maintenance |

**Research limitation:** External projects were reviewed through public documentation/repository information, not independently installed and benchmarked. Features and maintenance status may change.

## Prioritized delivery backlog
| Rank | ID | Work package | Size estimate* | Prerequisite | Decision |
|---:|---|---|---|---|---|
| 0 | DISC-01 | 12–15 interviews + 5 baseline observations | 1–2 weeks | Recruit users | Start |
| 1 | MKT-FR-001/002/007 | Radar and explainable findings | 4–7 dev days | Git fixtures | Prototype |
| 2 | MKT-FR-004 | Context handoff Markdown/JSON | 2–4 dev days | Export/redaction review | Prototype |
| 3 | MKT-FR-003 | Recovery Ledger | 4–8 dev days | Failure-injection baseline | Prototype |
| 4 | MKT-FR-005/008 | Local onboarding and safety tests | 3–6 dev days | OS/test matrix | MVP |
| 5 | MKT-FR-009 | CLI JSON | 2–4 dev days | Contract review | Should |
| 6 | MKT-FR-010 | Local search | 3–6 dev days | Data indexing | Should |
| 7 | MKT-FR-011 | Readiness Passport MVP | 5–10 dev days | Evidence provenance | Later |
| 8 | MKT-FR-012 | One GitHub read-only adapter | 10–20 dev days | Pilot demand | Later |

*Directional engineering estimates, not measured; exclude broad hardening, unforeseen migration and customer recruitment.

## 30/60/90-day plan
**Days 1–30:** interview target engineers; observe current workflow; run tests and safety audit; prototype Radar; instrument local first-value funnel with consent.
**Days 31–60:** refine Radar, add portable handoff and recovery evidence; recruit 5–8 independent pilots; measure repeat usage, setup and incident rate.
**Days 61–90:** validate repeat outcomes; test pricing/paid commitments if desired; decide on readiness evidence or GitHub adapter only if user demand is demonstrated.

## Pilot recruitment and interview guide
Recruit experienced engineers managing multiple repos/worktrees, with and without AI agents. Avoid only interviewing friends or people enthusiastic about the idea. Ask:
1. Tell me about the last time you resumed interrupted work.
2. How did you find the correct branch, stash, task and notes?
3. What did you do when unsure whether changes were recoverable?
4. Which tools did you use, and how long did it take?
5. What went wrong, and how often does it happen?
6. What would you do if Hub did not exist?
7. After an unguided trial, what would you miss if the tool disappeared?
8. Would you commit money or time to keep using it? Seek concrete action, not hypothetical praise.

## Measurement plan
- **North star:** weekly verified work-continuity outcomes (find/resume/handoff with user action).
- **Activation:** first actionable finding or completed handoff in first session.
- **Retention:** meaningful second-week use without prompting.
- **Quality:** false-positive findings, unknown-state correctness, recoverability test pass rate, critical incidents.
- **Operations:** setup support minutes, provider breakages, maintenance hours.
- **Business:** actual paid commitments, retention of paid pilots, acquisition source.
No raw repository names, paths, prompts, tokens or credentials sent as analytics by default.

## Proposed decision thresholds (not observed)
- >=8/12 interviewees report costly recurring recovery pain.
- >=6/8 pilot users activate independently.
- >=5/8 repeat a meaningful action in week two.
- Zero unresolved critical data-loss/privacy incidents.
- >=2 credible paid commitments before paid-product investment.
If thresholds are missed: pivot to CLI-only, recovery-specialist utility, or maintain personal OSS. Small samples are directional, not proof of PMF.

## Risks and mitigation
| Risk | Owner | Mitigation |
|---|---|---|
| No repeatable customer demand | Product owner | Interview before building, predefine stop gates |
| Native Claude/Codex features substitute Hub | Product | Test replacement workflows, avoid parity roadmap |
| Unsafe Git operations | Engineering + QA | Backups, fault injection, recovery runbooks, stop-the-line |
| Sensitive exports | Security + engineering | Preview/redaction, local-only default |
| Feature sprawl | Product owner | Scope lock and change control |
| Support overload | Maintainer | Limited OS/provider matrix and compatibility tests |
| Price resistance | Product owner | Paid pilot and one-time-license experiment |

## Stakeholder decision log (to fill)
| Decision | Options | Recommended | Owner | Status |
|---|---|---|---|---|
| First commercial wedge | Recovery / attention / verification | Recovery + continuity | Founder | Open |
| Initial packaging | Free / Pro Local / team SaaS | Free pilot, then paid test | Founder | Open |
| Supported OS | Windows only / cross-platform | Windows baseline; validate others | Engineering | Open |
| Next provider | GitHub / Azure / none | None until pilot | Product | Open |
| Data collection | Local metrics / opt-in remote | Local or opt-in | Security/product | Open |
| Release criteria | Feature complete / outcome verified | Outcome + safety | Product/QA | Open |

## Business case and economics
**Benefits hypothesis:** fewer context-reconstruction minutes, fewer missed handoffs, safer recovery, faster review evidence. No quantified benefit has been verified.
**Costs:** engineering and QA, compatibility upkeep, support, distribution and possible licensing.
**Illustrative calculation only:** 100 paying users at $10/month = $1,000 gross monthly revenue before fees, support, taxes and engineering; **not** a forecast.
**Investment rule:** no enterprise architecture or broad provider investment until external activation, repeat use and willingness to pay are demonstrated.

## Formal stakeholder approval
- Decision: **PENDING** (Approve pilot / Request revision / Reject)
- Sponsor: **TBD**
- Product owner: **TBD**
- Engineering: **TBD**
- QA/security: **TBD**
- Budget/time cap: **TBD**
- Review date: **TBD**

This document is a stakeholder decision aid, not a representation of approval or actual customer evidence.

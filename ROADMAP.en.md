# Bittune Roadmap

Bittune is a local inference-service harness running on the user's GPU machine. The Agent selects investigations and experiments; managed tools execute, validate and retain evidence.

## Current product foundation

- TypeScript/Node/Pi Agent and TUI, Python Core, stdio JSONL and SQLite/Artifact storage.
- Four generic tools and ten local managed tools for environment, plans, services, measurement, comparison, reporting and export.
- Docker and existing vLLM/SGLang adapters, fixed model/image identities and managed ownership checks.
- EvalScope normalization, versioned workloads and SLOs, per-request goodput, bounded suites and experiment budgets.
- Source-backed reports, XLSX and evidence ZIPs; authorized history queries and session entry points.
- Linux x86_64 installation, offline Core dependency installation and local diagnostics.

Implemented adapters, validated model/hardware combinations and published releases are separate statuses. Adapter availability does not prove every quantization, hardware, context or parallelism combination.
Offline capability covers the local Core, existing assets, facts and exports. A remote Agent API still requires network access for decisions.

## Near term: Local user workflow

1. Improve task recovery and authorized-resource continuity without expanding host authorization.
2. Clarify narrative-only report revisions and new versions with additional sources, retaining fact and reference integrity.
3. Make report files, deliverables and continuation entry points clear to users.
4. Extend engine combinations, correctness and cache analysis when required, reusing the existing execution and measurement paths.

The Agent chooses the next action and the Core is the sole canonical fact writer. New features do not require another Agent framework, execution protocol or fact database.

## Later: Optimization priors

Use comparable history and explainable rules to propose candidates, then evaluate prediction providers against evidence.
Keep predictions separate from measurements. Candidates require user confirmation and real local execution; estimates are not performance conclusions.

## Long-term directions

| Direction | Scope |
|---|---|
| Cloud and multiple devices | Optional connection, certified catalogs, organization/device management and authorized summary synchronization |
| Community and reproducible cases | Sharing, reproduction and comparable-cohort rankings; sensitive raw material stays local |
| Knowledge feedback | Treat success, no gain and failure separately; priors only produce candidates |
| Router | Service sandbox integration, metering and publication, separate from the current Local lifecycle |
| Clusters and hardware | Multi-GPU topology, disaggregated inference and more accelerators, scheduled for concrete needs |

These directions are not claims of complete implementation or release. Existing optional Cloud client code and server-platform capability have separate statuses.

## Documentation and support boundaries

The [user guide](guide/README.md) documents product capabilities and entry points.
The public repository contains source, generic documentation and fixed test fixtures. Device-specific records, internal handovers, raw logs and customer data remain local.

Performance comparisons require compatible model, environment, workload, cache policy and measurement provenance. Small samples, configuration declarations and P/D estimates do not establish production capacity or measured cluster performance.

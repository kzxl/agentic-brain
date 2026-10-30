# 🧠 agentic-brain — Episodic Semantic Memory Engine for AI Agents

**agentic-brain** is an offline, high-performance episodic and semantic memory engine for autonomous AI coding agents (Claude, Gemini, Cursor, Cline, OpenCode). Powered by PostgreSQL with `pgvector` and local BGE-M3 embeddings, it functions as the long-term memory substrate (Tier L2/L3) within the [agentic-core](https://github.com/kzxl/agentic-core) enterprise operating system.

> Documentation: [docs/README.md](docs/README.md) · Remaining work: [docs/next-steps.md](docs/next-steps.md)

**Status:** Phase 0–3 implemented (scope, atomic ingestion, project_id/trust, ANN-first, lifecycle, parent context). 27/27 tests; fresh-install migrations verified. Production hardening and Phase 4–5 are tracked in [next-steps.md](docs/next-steps.md).

---

## 🏛️ Ecosystem Architecture

```mermaid
graph TD
    Agent(["Autonomous Coding Agent / IDE"]) -->|"1. PRE: Query Context"| CoreBridge["Agent Core Bridge (tools/brain.js)"]
    CoreBridge -->|"L0 Compact Index"| FindQA["find-qa-context.js"]
    FindQA -->|"ANN + FTS + RRF"| DB[("PostgreSQL + pgvector")]

    Agent -->|"2. L1: Deep View (Selective)"| ViewQA["view-qa.js"]
    ViewQA -->|"Full Context, Parent, History"| DB

    Agent -->|"3. Execute & Verify Code"| Workspace["Codebase & Tests"]

    Agent -->|"4. POST: Atomic Atoms"| Ingest["ingest-knowledge.js"]
    Ingest -->|"Validate + Dedup + Scope + Trust"| DB

    Agent -->|"5. Review & Verify"| Review["review-scope.js / promote-trust.js"]
    Review --> DB

    Cron(["Periodic Curation"]) -->|"6. Status Lifecycle"| Curate["curate.js / qa-health.js"]
    Curate -->|"active -> stale -> archived"| DB
```

---

## ✨ Core Capabilities

### 1. Progressive 2-Tier Knowledge Retrieval (L0 / L1)
- **Tier L0 (Compact Index):** `find-qa-context.js` outputs lightweight 1-line signatures (`[ID] Problem (Score, Tags)`) to preserve the agent's context window.
- **Tier L1 (Selective Deep View):** `view-qa.js <id>` inspects the full resolution root-cause, actionable code fix, and historical revisions only when directly relevant.

### 2. Harvest Quality Guard & Anti-Hallucination
- Rejects transient environment noise (VPN drops, expired auth tokens, full disks, missing system packages).
- Blocks negative tool assertions that induce permanent false refusals.
- Enforces durable 3-part engineering structure: `<Symptom/Problem> | <Root Cause> | <Solution & Invariants>`.
- Supports `--pinned` to protect architectural invariants from automated lifecycle decay.

### 2.1. Atomic Ingestion & Scope Resolution
- The calling agent provides **atomic Q&A lessons** as JSON; no local LLM re-analyzes the summary.
- `tools/ingest-knowledge.js` validates each atom, gives it its own embedding, and links it to a parent `document` row via `parent_id` / `source_ref`.
- Scope resolution is deterministic: explicit `--scope` wins, project-specific identifiers stay project-scoped, generic lessons inside a project become **global candidates** for review.
- `save-qa` rejects answers over 2000 characters unless `--allow-long`; `post-task --direct` requires `<problem> | <cause> | <fix>`.
- Review candidates with `node tools/review-scope.js`; approve promotes to global, reject keeps project scope.

### 2.2. Trust & Provenance
- Every atom has `trust_level`: `observation`, `hypothesis`, `inference`, `verified_fact`, or `user_decision`.
- `verified_fact` requires `verifier` or `evidence`; otherwise it is downgraded to `hypothesis`.
- `project_id`, `source_type`, `evidence`, `verifier`, `verified_at`, `valid_from`/`valid_to`, and `status` are stored as columns.
- Retrieval only returns `status='active'` rows that are not expired.

### 3. Semantic Deduplication & Reinforcement ($\ge 85\%$)
- Compares new knowledge embeddings against existing entries within the same project.
- Instead of creating duplicate records, matches $\ge 85\%$ similarity strengthen retrieval/use counters, update guidance, and archive previous answers into `agent_qa_history`.

### 4. Continuous Lifecycle Curation Engine
- Uses the `status` column and `retrieval_count`/`use_count`, not the legacy `hit_count`.
- Classifies knowledge into **Active**, **Stale** (no retrieval/use signal > 60 days), and **Archived** (planned retention job).
- Audits semantic overlap across active atoms and flags consolidation candidates.
- Safe `--dry-run` inspection before executing status mutations.

### 4.1. Parent Context & ANN-first Retrieval
- Atoms carry `parent_id`; `--with-parent` / `include_parent=true` fetches the parent document on demand.
- Retrieval runs with index-first planning (`RETRIEVAL_FORCE_INDEX=true`) because pgvector's planner can choose Seq Scan at 50k.
- 3.4k: global ~8 ms, ERP ~49 ms. 50k forced HNSW: ~57 ms (planner default ~522 ms).

### 5. Transparent OpenAI Proxy (`:3458`)
- Simulates an OpenAI-compatible endpoint (`/v1/chat/completions`) wrapped around local LLMs (Ollama, vLLM).
- Automatically intercepts prompt streams to inject relevant architectural context. It does **not** analyze or persist completions; the calling agent writes atoms through `/ingest` or `tools/ingest-knowledge.js`.

---

## 🛠️ Technology Stack

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Embedding** | `@xenova/transformers` | BGE-M3 (1024-dimension, local inference, ~570MB) |
| **Vector Database** | PostgreSQL 16 + `pgvector` | HNSW index. Production force-index: 3.4k global p50 ~8 ms, ERP ~49 ms; 50k forced HNSW ~57 ms. |
| **Search Strategy** | Hybrid RRF | ANN candidate + full-text candidate + Reciprocal Rank Fusion |
| **LLM Backend** | Ollama / Cloud Fallback | Local Qwen / Llama models with optional cloud provider failover |
| **Runtime** | Node.js (ES6+) | Standalone lightweight micro-services and CLI utilities |

---

## 🚀 Quick Start

### Option A: Docker Compose (Recommended)

Run PostgreSQL, pgvector, and all services in isolated containers:

```bash
git clone https://github.com/kzxl/agentic-brain.git
cd agentic-brain

# Launch vector database and services
docker compose up -d
```

- **Port 3457**: RAG Engine Core API.
- **Port 3458**: OpenAI-Compatible Proxy (connect your IDE or agent here).

### Option B: Local Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# 3. Initialize database schema (migrations run automatically)
npm run setup

# 3.5. Optional: run migrations without re-indexing skills/workflows
npm run migrate

# 4. Start core service
npm run start

# 5. Start OpenAI proxy (separate terminal)
npm run proxy
```

---

## 🔐 Security & runtime defaults

- The server binds to `127.0.0.1` by default (`BIND_HOST`).
- Set `SEMANTIC_API_TOKEN` to require `Authorization: Bearer <token>` on every route except `/health` and `/ready`.
- Set `PROXY_API_TOKEN` for the OpenAI proxy.
- Request bodies are capped at 1 MB (`MAX_BODY_BYTES`).
- Retrieval runs with index-first planning (`RETRIEVAL_FORCE_INDEX=true`); set false to let pgvector's planner choose.
- Unsafe defaults are off: `AME_WRITE=false`, no implicit harvest, no auto-answer on MISS.
- Knowledge writes are agent-side and explicit: `tools/ingest-knowledge.js` or `POST /ingest` with atomic JSON atoms. No local LLM re-analyzes summaries.
- PostgreSQL is the canonical store; AME is not written unless explicitly enabled.
- Queries without a project scope return **only `project:global`**. Use `--all-projects` (CLI) or `all_projects=true` (HTTP) for explicit cross-project search.

Verify the Phase 0–3 contract:

```bash
npm test
npm run verify:phase0
npm run verify:phase1
npm run verify:phase2
npm run verify:phase3
npm run baseline
npm run bench:ann50k
```

---

## 💻 CLI Tool Reference

All commands support project-level multi-tenancy via `--project=<name>`.

```bash
# 1. Pre-Fetch: Progressive L0 Index retrieval before task execution
node tools/find-qa-context.js "Fix database deadlock during inventory sync" --project=erp --tags=inventory
# Add --with-parent (or --full) to fetch the parent document for an atom.

# 2. Inspect: Deep L1 examination of specific QA record
node tools/view-qa.js 42

# 3. Post-Harvest: Store one structured lesson
node tools/post-task.js "Deadlock on RefInId | Missing composite index on (DocId, RefInId) | Added composite index and sorted lock acquisitions" --project=erp --tags=inventory,database

# 3b. Atomic JSON ingestion (agent-provided atoms; no local LLM)
node tools/ingest-knowledge.js --file=atoms.json --project=erp --tags=inventory,database

# 4. Pin Invariant: Store non-decaying fundamental architectural standard
node tools/save-qa.js "How to structure WPF controllers?" "Always inherit from BaseForm and use RunAfterShown." --project=erp --tags=csharp,wpf --pinned --trust=verified_fact --verifier=user --evidence=code-review

# 5. Curation: Audit stale entries and semantic overlap (Dry-Run)
node tools/curate.js --dry-run

# 6. Mark Stale: set status='stale' on dormant, low-value records
node tools/curate.js --mark-stale --stale-days=60

# 7. Review global-scope candidates (generic lessons written inside a project)
node tools/review-scope.js
node tools/review-scope.js --approve=123
node tools/review-scope.js --reject=124

# 8. Promote trust after deterministic verification
node tools/promote-trust.js --id=123 --to=verified_fact --verifier=build --evidence=build:ok

# 9. Lifecycle and benchmark jobs
npm run verify:phase3
npm run bench:ann50k
```

`save-qa` accepts an explicit scope when needed:

```bash
node tools/save-qa.js "How should a generic service be structured?" "Separate contracts, application, and infrastructure." --scope=global
```

---

## 🔗 Ecosystem Integration

`agentic-brain` is paired with [agentic-core](https://github.com/kzxl/agentic-core). In any client project containing `.project-rule.md`, agents invoke `agentic-brain` directly through the unified bridge:

```bash
# SSoT Bridge from agentic-core
node [AgentOption]/tools/brain.js pre "task description"
node [AgentOption]/tools/brain.js view 42
node [AgentOption]/tools/brain.js post "problem | cause | fix"
node [AgentOption]/tools/brain.js ingest --file=atoms.json
node [AgentOption]/tools/brain.js curate --dry-run
```

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

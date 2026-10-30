# Semantic Brain — Next Steps

- **Snapshot:** 2026-10-30
- **Branch:** `feat/phase0-stabilization`
- **Trạng thái:** Phase 0–3 đã triển khai; Phase 4–7 chưa.
- **Mục đích:** một danh sách duy nhất cho các việc còn lại, có thứ tự ưu tiên và tiêu chí nghiệm thu.

---

## 1. Trạng thái hiện tại

| Hạng mục | Hiện tại |
| :--- | :--- |
| Tests | 27/27 pass |
| Verify Phase 0/1/2/3 | 31 / 27 / 28 / 15 |
| Fresh install | 11 migration pass |
| Dữ liệu | 3.411 row, 18 project, 0 null project_id |
| Trust | 2.871 observation, 407 inference, 132 verified_fact |
| Status | toàn bộ `active`; curate chưa chạy định kỳ |
| Retrieval | global ~8 ms, ERP ~49 ms; 50k forced HNSW ~57 ms |
| Planner 50k | 522 ms (Seq Scan) nếu không force index |
| AME | không ghi mới; legacy vẫn lệch, chưa reconcile |

---

## 2. Bảng ưu tiên

| ID | Ưu tiên | Việc | Effort | Phụ thuộc |
| :--- | :--- | :--- | ---: | :--- |
| NS-01 | P0 | Scheduled lifecycle: curate/qa-health + archive | 2 pd | — |
| NS-02 | P0 | Review/promote 2.871 observation | 2 pd | NS-01 |
| NS-03 | P0 | CI + fresh-install + golden gate | 2 pd | — |
| NS-04 | P0 | Rate limit, token rotation, audit log | 2 pd | — |
| NS-05 | P0 | Benchmark trên dữ liệu thật 50k; chốt force-index | 1 pd | NS-03 |
| NS-06 | P0 | Đối soát/archive AME legacy | 1–2 pd | — |
| NS-07 | P0 | Dashboard lifecycle/trust/status | 1 pd | NS-01 |
| NS-08 | P1 | Context builder + budget + compression | 4 pd | NS-01 |
| NS-09 | P1 | Citation, provenance, conflict flags | 3 pd | NS-08 |
| NS-10 | P1 | Model gateway + adaptive routing | 4 pd | — |
| NS-11 | P1 | Reasoning orchestrator + sufficiency | 4 pd | NS-08, NS-10 |
| NS-12 | P1 | Parent-child ranking + code-aware retrieval | 3 pd | NS-08 |
| NS-13 | P2 | Consolidation/merge/versioning | 3 pd | NS-02 |
| NS-14 | P2 | Temporal validity + conflict resolution | 2 pd | NS-13 |
| NS-15 | P2 | Golden set + metrics + A/B | 3 pd | NS-03 |
| NS-16 | P3 | MCP server + SDK + CLI facade | 3 pd | NS-04 |
| NS-17 | P3 | Auth scopes + multi-client concurrency | 2 pd | NS-04 |

---

## 3. P0 — Production hardening

### NS-01 — Scheduled lifecycle

**Vấn đề:** `curate`/`qa-health` đã dùng `status` và counters nhưng chưa chạy định kỳ; DB hiện toàn `active`.

**Làm:**
- Tạo `tools/lifecycle-worker.js` hoặc dùng Windows Task Scheduler/cron gọi:
  - `node tools/curate.js --mark-stale --stale-days=60`
  - `node tools/qa-health.js --fix`
- Thêm archive: `status='archived'` cho stale >180 ngày, trừ `pinned`.
- Log số row theo status trước/sau; không xóa cứng.

**Nghiệm thu:**
- Sau job: có `stale`/`archived` hợp lý; `active` giảm.
- Không mất row; `view-qa` vẫn xem được row archived nếu explicit.
- Chạy lại job idempotent.

**Files:** `tools/curate.js`, `tools/qa-health.js`, `tools/lifecycle-worker.js` (mới), `docs/architecture/results/phase3-results.md`.

---

### NS-02 — Review/promote trust

**Vấn đề:** 2.871 observation chưa được kiểm chứng; `promote-trust` mới là CLI thủ công.

**Làm:**
- `node tools/promote-trust.js --list` theo project/limit.
- Batch review: lọc theo tag/domain, promote có evidence.
- Ghi rõ `verifier`, `evidence`, `verified_at`.
- Không auto-promote output LLM.

**Nghiệm thu:**
- Mỗi promotion có evidence/verifier.
- `verified_fact` không tăng nếu thiếu evidence.
- Báo cáo số observation còn lại theo project.

**Files:** `tools/promote-trust.js`, `core/trust.js`, `README.md`.

---

### NS-03 — CI + fresh-install gate

**Vấn đề:** test/verify mới chạy local; fresh install mới test thủ công một lần.

**Làm:**
- `.github/workflows/ci.yml` (hoặc CI tương đương) với PostgreSQL + pgvector.
- Chạy: `npm ci`, `npm test`, `verify:phase0..3`.
- Tạo DB trống → `migrations/run.js` → schema check.
- Golden gate: precision@5 không giảm >3%; P95 không tăng >20%.

**Nghiệm thu:**
- PR fail nếu test/migration/golden gate fail.
- Fresh DB tạo đủ 11 migration, 8 bảng, 3 view.

**Files:** `.github/workflows/ci.yml`, `tests/`, `tools/verify-phase*.js`, `eval/`.

---

### NS-04 — Rate limit, token rotation, audit

**Vấn đề:** có Bearer auth + body limit, chưa có rate limit/rotation/audit.

**Làm:**
- Rate limit theo token/IP (60 req/phút; write 20/phút).
- Token lưu hash; hỗ trợ rotate không downtime.
- Audit log: actor, project, action, item_id, before/after hash.
- `/shutdown`, `/ingest`, `/save-qa` yêu cầu admin/scope phù hợp.

**Nghiệm thu:**
- 61 request/phút → 429.
- Token cũ bị từ chối sau rotation.
- Mọi write có audit row.

**Files:** `server.js`, `openai-proxy.js`, `core/auth/*` (mới), `docs/architecture/design/target-architecture.md`.

---

### NS-05 — Benchmark dữ liệu thật 50k

**Vấn đề:** 50k hiện là synthetic random; planner mặc định chọn Seq Scan (522 ms), forced HNSW 57 ms.

**Làm:**
- Export snapshot thật (hoặc nhân bản có kiểm soát) lên bảng bench.
- Đo planner vs forced HNSW; recall@10 so với brute force.
- Quyết định `RETRIEVAL_FORCE_INDEX` mặc định; ghi ADR nếu đổi.

**Nghiệm thu:**
- Có p50/p95, recall, plan lines trên dữ liệu thật.
- Quyết định force-index có số liệu và rollback.

**Files:** `tools/benchmark-ann-50k.js`, `core/retrieval-db.js`, `docs/architecture/baselines/`.

---

### NS-06 — Đối soát/archive AME

**Vấn đề:** AME legacy vẫn lệch; đã dừng ghi mới nhưng chưa reconcile.

**Làm:**
- Export AME một lần (hoặc thêm `ame export`).
- Diff theo `content_hash` với PostgreSQL.
- Import bản ghi chỉ có trong AME với `trust_level='observation'`, project review.
- Archive `.ame`; không xóa.

**Nghiệm thu:**
- Báo cáo diff đầy đủ; không mất bản ghi.
- Không còn dual-write.

**Files:** `tools/migrate-pg-to-ame.js`, `core/storage-ame.js`, `docs/architecture/results/phase3-results.md`.

---

### NS-07 — Dashboard lifecycle/trust

**Vấn đề:** dashboard cũ dùng view counters mới nhưng chưa hiển thị status/trust/project.

**Làm:**
- Dashboard hiển thị: active/stale/archived, trust distribution, project distribution.
- Cảnh báo observation tồn, stale tồn, conflict mở.

**Nghiệm thu:**
- `node tools/dashboard.js` phản ánh đúng DB.
- Không dùng `hit_count`/`useful_count` legacy.

**Files:** `tools/dashboard.js`, `tools/stats.js`, `docs/architecture/baselines/`.

---

## 4. P1 — Phase 4: Context & Hybrid Reasoning

### NS-08 — Context builder + budget + compression

- Sections: task, project facts, experience, code pointers, procedure, unknowns, instructions.
- Budget theo task type: lookup 1.5k, bug 4k, feature 8k, refactor 12k, architecture 16k.
- Extractive compression trước; giữ citation.
- `context-fetch` dùng builder; `--full` vẫn xem raw.

**Files:** `core/context/*` (mới), `tools/context-fetch.js`.
**Nghiệm thu:** giảm ≥30% token context, precision không giảm.

### NS-09 — Citation, provenance, conflict flags

- Mọi block có `id`, `trust_level`, `project_id`, `valid_from`.
- Conflict mở hiển thị cả hai; không tự chọn.
- Citation bắt buộc cho câu trả lời dùng internal knowledge.

**Files:** `core/context/citations.js`, `core/knowledge/conflict.js`.
**Nghiệm thu:** 100% claim có citation hoặc nhãn `external`.

### NS-10 — Model gateway + adaptive routing

- Provider adapters: Ollama, OpenAI-compatible, Gemini, Anthropic.
- Router theo task/risk/context/cost/latency.
- Timeout, retry, circuit breaker, token/cost log.
- Local-first; cloud có lý do.

**Files:** `core/gateway/*` (mới).
**Nghiệm thu:** local/cloud fallback; cost log; P95.

### NS-11 — Reasoning orchestrator

- Workflow: intent → retrieval → sufficiency → context → model → verify → conflict → answer → harvest gate.
- `insufficient_knowledge` thay vì bịa.
- Verification deterministic cho code/build/test.

**Files:** `core/reasoning/orchestrator.js`, `tools/reason.js`.
**Nghiệm thu:** miss/insufficient trả đúng; không lưu output chưa verify.

### NS-12 — Parent-child ranking + code-aware

- Ranking ưu tiên atom; parent chỉ fetch khi cần.
- Code index chunk theo symbol/method, `file:line`.
- `find-code` nối vào retrieval cho code intent.

**Files:** `core/parents.js`, `tools/codebase-indexer.js`, `core/retrieval/planner.js`.
**Nghiệm thu:** query code trả file:line; parent không lấn top-k.

---

## 5. P2 — Phase 5: Knowledge Evolution

### NS-13 — Consolidation/merge/versioning

- Cluster gần trùng, merge có kiểm soát, `supersedes_id`, history.
- Không merge cross-project; không merge user_decision.
- Dry-run/apply; event log.

### NS-14 — Temporal validity + conflict resolution

- `valid_from/to` được dùng trong retrieval (đã có filter).
- Conflict classifier: factual/temporal/scope/version.
- Resolution queue; không auto-resolve fact.

### NS-15 — Golden set + metrics + A/B

- 200 câu hỏi có nhãn; precision@k/recall/nDCG.
- Context token efficiency, hallucination/conflict rate, latency/cost.
- A/B có/không memory, cùng model/budget.

---

## 6. P3 — Phase 7: Ecosystem

### NS-16 — MCP + SDK + CLI facade

- MCP tools: search/get/write/feedback/session/context/reason/conflicts.
- SDK JS mỏng; CLI wrapper gọi service.
- Không nhân bản logic.

### NS-17 — Auth scopes + multi-client

- Token scopes theo project/action.
- Idempotency key; optimistic lock.
- Test 10 client ghi đồng thời.

---

## 7. Thứ tự 2 tuần đề xuất

| Tuần | Việc |
| :--- | :--- |
| 1 | NS-01, NS-02, NS-03 |
| 2 | NS-04, NS-05, NS-06, NS-07 |
| Sau đó | NS-08 → NS-09 → NS-10 → NS-11 → NS-12 |

Lý do: lifecycle + trust + CI là điều kiện để mọi thay đổi sau đó có số liệu và không làm bẩn dữ liệu.

---

## 8. Definition of Done

Một việc chỉ xong khi:

1. Có test hoặc verify gate tương ứng.
2. Có số liệu trước/sau nếu ảnh hưởng retrieval/lifecycle.
3. Không làm mất dữ liệu; có rollback.
4. Cập nhật tài liệu trong `docs/architecture/` nếu quyết định thay đổi.
5. Không thêm dependency nặng nếu không có lý do.

---

## 9. Không làm

- Không viết lại toàn bộ.
- Không bật dual-write AME trở lại.
- Không tự promote output LLM thành `verified_fact`.
- Không merge tri thức khác project.
- Không thêm graph database khi `memory_edge` chưa có nhu cầu thật.
- Không bật force-index mù quáng nếu filter rộng làm chậm.

---

## 10. Liên kết

- [Architecture index](architecture/README.md)
- [Audit](architecture/audit/current-state-audit.md)
- [Memory design](architecture/design/memory-system.md)
- [Hybrid reasoning](architecture/design/hybrid-reasoning.md)
- [Target architecture](architecture/design/target-architecture.md)
- [Roadmap](architecture/roadmap/implementation-roadmap.md)
- [Remediation](architecture/roadmap/remediation-plan.md)
- [Phase 3 results](architecture/results/phase3-results.md)
- [Baselines](architecture/baselines/)

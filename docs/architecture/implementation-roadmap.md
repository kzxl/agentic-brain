# Semantic Brain — Lộ trình triển khai

Lộ trình này chuyển hệ thống hiện tại sang kiến trúc đích **tăng dần, có thể rollback**, ưu tiên ổn định và đo lường trước khi thêm năng lực. Ước lượng theo **person-day (pd)** cho một kỹ sư quen codebase; tổng ~65–85 pd.

---

## 0. Tóm tắt lộ trình

| Phase | Tên | Mục tiêu chính | Effort | Phụ thuộc |
| :--- | :--- | :--- | ---: | :--- |
| **0** | Ổn định | Sửa lỗi chặn: schema drift, dual-write, security, baseline | 9–11 pd | — |
| **1** | Foundation | Schema memory, trust/provenance, project isolation, một đường ghi | 12–15 pd | Phase 0 |
| **2** | Advanced Retrieval | ANN-first, filter, code-aware, graph, rerank, sufficiency | 12–15 pd | Phase 1 |
| **3** | Context Intelligence | Budget, compression, citation, conflict flag | 8–10 pd | Phase 2 |
| **4** | Hybrid Reasoning | Gateway, router, orchestrator, verification | 12–15 pd | Phase 1–3 |
| **5** | Knowledge Evolution | Consolidation, promotion, versioning, temporal | 10–12 pd | Phase 1, 4 |
| **6** | Evaluation | Golden set, metrics, CI, A/B, observability | 8–10 pd | Phase 0–5 |
| **7** | Ecosystem | MCP, SDK, CLI facade, multi-client | 6–8 pd | Phase 4–6 |

**Thứ tự thực tế:** Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Tuy nhiên **golden set v0 và harness đo phải bắt đầu ngay trong Phase 0**, không đợi Phase 6; Phase 6 chỉ mở rộng và tự động hóa.

---

## Phase 0 — Ổn định (9–11 pd)

### Mục tiêu

Hệ thống cài mới chạy được, không mất dữ liệu, không rò rỉ, có baseline đo trước khi thay đổi.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P0-01 | Backup + verify restore PostgreSQL và AME | `maintenance/export.js`, `data/backup/` | 1 |
| P0-02 | Viết migration runner; sửa schema thiếu `useful_count`, `agent_qa_querylog`, view, index | `maintenance/setup.js` → `migrations/` | 2 |
| P0-03 | Tắt dual-write AME mặc định (`AME_WRITE=false`); sửa `backend=ame` mất dữ liệu | `tools/save-qa.js`, `core/config.js` | 1 |
| P0-04 | Auth token, rate limit, body limit, CORS cho REST/proxy | `server.js`, `openai-proxy.js` | 2 |
| P0-05 | Structured logging + request id; bỏ `catch {}` ở đường ghi/đọc chính | `core/`, `server.js` | 1 |
| P0-06 | Baseline benchmark: 50 query, latency, precision thủ công; lưu kết quả | `benchmark/` | 1 |
| P0-07 | Bỏ hardcode path ERP; `setup.js` dùng `process.cwd()` | `core/config.js`, `maintenance/setup.js`, `storage-ame.js` | 1 |
| P0-08 | Tắt `auto-qa` tự lưu mặc định; nếu giữ, trust=observation, confidence ≤0.5 | `tools/find-qa.js`, `tools/auto-qa.js` | 0.5 |

### Tiêu chí hoàn thành

- `npm run setup` trên DB trống tạo đủ schema; `/find-qa` trả 200.
- `MEMORY_BACKEND=ame` không còn mất dữ liệu (hoặc bị từ chối rõ ràng nếu AME down).
- REST/proxy từ chối request không có token (trừ `/health`).
- Retrieval MISS không tự tạo bản ghi confidence 1.0.
- Có file baseline `docs/architecture/baseline.json` với 50 query + latency + top-5 id.

### Test

- Fresh install test trong Docker.
- Restore từ backup vào DB mới, đếm khớp.
- Gửi request không token → 401; body 2 MB → 413.
- Query MISS không tạo bản ghi `auto-qa` confidence 1.0.
- Chạy 50 query baseline, lưu kết quả.

### Rủi ro

- Migration trên DB thật có thể lâu/khóa bảng; chạy trong transaction, backup trước.
- Auth có thể làm hỏng client hiện tại; dùng feature flag + token mặc định local.

---

## Phase 1 — Foundation (12–15 pd)

### Mục tiêu

Chuẩn hóa memory model, trust/provenance, project isolation; chỉ còn một đường ghi.

### Việc cần làm

| ID | Việc | File/thư mục | Effort |
| :--- | :--- | :--- | ---: |
| P1-01 | `memory_item` schema + index + migration additive | `migrations/002_memory_item.sql` | 2 |
| P1-02 | Backfill `project_id`, `memory_type`, `trust_level`, `content_hash` | `migrations/003_backfill.sql` | 2 |
| P1-03 | `MemoryRepository` (PG) + interface | `core/storage/repository.js` | 2 |
| P1-04 | `KnowledgeWriter`: normalize/classify/validate/dedup | `core/knowledge/writer.js` | 3 |
| P1-05 | Chuyển `save-qa`, `post-task`, `auto-harvest`, `server`, `proxy` sang writer | `tools/`, `server.js`, `openai-proxy.js` | 3 |
| P1-06 | Compatibility view `agent_qa_cache`; giữ CLI cũ | `migrations/004_view.sql` | 1 |
| P1-07 | Project isolation predicate + test | `core/storage/repository.js`, `tests/` | 1 |
| P1-08 | `memory_session` + checkpoint API (working memory) | `core/memory/session.js` | 2 |
| P1-09 | Trust rules: producer → max trust; bỏ confidence 1.0 mặc định | `core/knowledge/trust.js` | 1 |

### Tiêu chí hoàn thành

- Mọi ghi đi qua `KnowledgeWriter`; không còn `INSERT INTO agent_qa_cache` ngoài repository.
- Query mặc định chỉ trả cùng `project_id` hoặc `scope='global'`.
- Proxy/LLM output có `trust_level='observation'`, confidence ≤0.6.
- Session mở/checkpoint/promote hoạt động; promote tạo episodic.
- 100% bản ghi cũ có `project_id`, `memory_type`, `trust_level`, `content_hash`.

### Test

- MS-01 → MS-08 (xem [memory-system.md](memory-system.md) §7).
- Query project A không trả project B.
- Backfill đếm: tổng = 3.407 (hoặc số hiện tại), không mất dòng.
- Ghi proxy → không xuất hiện trong semantic default.

### Rủi ro

- Backfill sai project do tag thiếu; log danh sách `unknown` để review.
- Thay đổi confidence có thể làm giảm kết quả retrieval; so sánh baseline.

---

## Phase 2 — Advanced Retrieval (12–15 pd)

### Mục tiêu

ANN-first, filter đầy đủ, code-aware, graph, rerank, sufficiency; P95 <100 ms ở 50k bản ghi.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P2-01 | Query ANN-first: `ORDER BY embedding <=> $1 LIMIT k`, sau đó FTS/RRF | `core/retrieval/engine.js`, `core/queries.js` | 3 |
| P2-02 | Metadata filter: project, scope, type, trust, status, time | `core/retrieval/filters.js` | 1 |
| P2-03 | FTS cải thiện: `unaccent`, generated `tsvector`, config `simple` | `migrations/005_fts.sql` | 1.5 |
| P2-04 | Code chunking theo symbol/method, lưu `file:line` | `tools/codebase-indexer.js` | 2.5 |
| P2-05 | Nối `find-code` vào retrieval (code intent) | `core/retrieval/planner.js` | 1 |
| P2-06 | `memory_edge` + expand 1–2 hop | `core/retrieval/graph.js` | 1.5 |
| P2-07 | Rerank: local cross-encoder hoặc LLM rerank có budget | `core/retrieval/rerank.js` | 2 |
| P2-08 | Query expansion động (angle + entity từ task) | `tools/decompose-angles.json`, `planner.js` | 1 |
| P2-09 | Sufficiency signals (score, trust, coverage) | `core/retrieval/sufficiency.js` | 1.5 |
| P2-10 | Load test 50k synthetic + EXPLAIN gate | `benchmark/` | 1 |

### Tiêu chí hoàn thành

- `EXPLAIN` cho thấy Index Scan HNSW cho candidate generation, không Seq Scan toàn bảng.
- P95 retrieval <100 ms ở 50k bản ghi (đo trên máy mục tiêu).
- Code query trả file:line đúng, không dump toàn file.
- Multi-hop trả reference đúng, có visited set.
- Precision@5 tăng ≥15% so baseline trên golden set.

### Test

- 50k synthetic: latency, recall@10.
- Query code: "IStockOutService" → đúng file/service.
- Query multi-hop: answer có "see QA #n" → lấy đúng id.
- Filter trust: chỉ verified_fact.
- Project isolation vẫn đúng.

### Rủi ro

- ANN + filter có thể giảm recall nếu filter chọn lọc cao; dùng pre-filter hoặc tăng `ef_search`.
- Rerank tăng latency; chỉ bật khi budget cho phép.

---

## Phase 3 — Context Intelligence (8–10 pd)

### Mục tiêu

Context có cấu trúc, ngân sách, citation, conflict flag; giảm token mà không mất thông tin.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P3-01 | Context builder theo section | `core/context/builder.js` | 2 |
| P3-02 | Budget theo task type/risk | `core/context/budget.js` | 1.5 |
| P3-03 | Extractive compression + summary | `core/context/compress.js` | 2 |
| P3-04 | Citation/provenance formatter | `core/context/citations.js` | 1 |
| P3-05 | Conflict flag trong context | `core/context/conflicts.js` | 1 |
| P3-06 | Context snapshot lưu vào session | `core/memory/session.js` | 1 |
| P3-07 | `context-fetch` dùng builder | `tools/context-fetch.js` | 1.5 |

### Tiêu chí hoàn thành

- Cùng một task, token context giảm ≥30% so baseline mà precision không giảm.
- Mỗi block có id/trust/valid_from.
- Conflict hiển thị rõ, không tự chọn.
- Budget không vượt; item bị cắt được log.

### Test

- Task lookup/bug/refactor/architecture: budget đúng.
- Context 16k token: không tràn model window.
- Conflict: hiển thị cả hai.
- Citation: mọi claim có nguồn hoặc đánh dấu external.

### Rủi ro

- Compression làm mất invariant; ưu tiên giữ nguyên verified_fact/user_decision.

---

## Phase 4 — Hybrid Reasoning (12–15 pd)

### Mục tiêu

Gateway đa provider, routing theo task/risk/cost, orchestrator có sufficiency/verification, không lưu output chưa kiểm chứng.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P4-01 | Provider adapters: Ollama, OpenAI-compatible, Gemini, Anthropic | `core/gateway/providers/` | 3 |
| P4-02 | Router theo bảng routing | `core/gateway/router.js` | 1.5 |
| P4-03 | Timeout, retry, circuit breaker, health | `core/gateway/health.js` | 1.5 |
| P4-04 | Token/cost accounting + trace log | `core/gateway/accounting.js` | 1.5 |
| P4-05 | Orchestrator workflow 15 bước (rút gọn theo task) | `core/reasoning/orchestrator.js` | 3 |
| P4-06 | Verification hooks: build/test/schema | `core/reasoning/verify.js` | 2 |
| P4-07 | Conflict resolution API | `core/knowledge/conflict.js`, `server.js` | 1.5 |
| P4-08 | Sửa streaming parse + JSON schema validation | `core/gateway/stream.js` | 1 |
| P4-09 | `/v1/reason` endpoint | `server.js` | 1 |

### Tiêu chí hoàn thành

- Mọi call LLM đi qua gateway; có timeout/retry/log.
- Task đơn giản chạy local; task code/architecture escalate có lý do.
- Retrieval thiếu → `insufficient_knowledge`, không gọi LLM.
- Output không verify → chỉ `observation`/`inference`.
- JSON output validate schema; sai → retry 1 → fail rõ.

### Test

- Ollama down → cloud fallback; cloud down → local; cả hai down → retrieval-only.
- Streaming không mất token khi chunk cắt giữa dòng.
- LLM trả JSON sai → không lưu.
- Conflict user_decision vs LLM → giữ user decision.
- Cost log khớp token thực tế (sai số <5%).

### Rủi ro

- Orchestrator quá nhiều nhánh; bắt đầu bằng 3 mode (lookup/task/architecture).
- Cloud chi phí tăng; đặt budget cứng/ngày.

---

## Phase 5 — Knowledge Evolution (10–12 pd)

### Mục tiêu

Consolidation, promotion, versioning, temporal, recipe lifecycle; giảm trùng lặp và tri thức cũ.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P5-01 | Consolidation job: cluster, merge, archive | `core/knowledge/consolidate.js` | 3 |
| P5-02 | Promotion rules episodic→semantic | `core/knowledge/promote.js` | 2 |
| P5-03 | Temporal validity + versioning | `migrations/006_temporal.sql` | 1.5 |
| P5-04 | Review queue cho merge/conflict | `core/knowledge/review.js`, CLI | 1.5 |
| P5-05 | Recipe lifecycle + `mark-recipe` bắt buộc | `tools/find-recipe.js`, `server.js` | 1.5 |
| P5-06 | Archive/retention job; không xóa cứng | `maintenance/retention.js` | 1 |
| P5-07 | Contradiction classifier (rule + LLM optional) | `core/knowledge/conflict.js` | 1.5 |

### Tiêu chí hoàn thành

- Consolidation dry-run báo đúng cặp; apply tạo event + supersedes.
- Không merge cross-project; không merge user_decision.
- 72% bản ghi cũ được phân loại stale/archive theo chính sách.
- Recipe success rate có dữ liệu thật; recipe fail 2 lần → stale.
- Mọi thay đổi có `memory_event`.

### Test

- MS-13, MS-14.
- Chạy consolidation trên bản sao DB; đếm trước/sau; rollback.
- Recipe: 2 success → active; 2 fail → stale.
- Temporal: item hết hạn không trả mặc định.

### Rủi ro

- Merge sai làm mất chi tiết; luôn giữ history và dry-run.
- Tự động archive có thể ẩn tri thức còn giá trị; dùng ngưỡng bảo thủ + review.

---

## Phase 6 — Evaluation (8–10 pd)

### Mục tiêu

Chứng minh cải tiến bằng số liệu; CI chặn regression.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P6-01 | Golden set 200 câu hỏi có nhãn (project, item đúng) | `eval/golden/` | 2 |
| P6-02 | Retrieval metrics: precision@k, recall@k, nDCG | `eval/retrieval.js` | 2 |
| P6-03 | End-to-end metrics: answer correctness, citation, conflict | `eval/e2e.js` | 2 |
| P6-04 | A/B harness có/không memory, cùng model/budget | `eval/ab.js` | 1.5 |
| P6-05 | CI: lint, unit, migration, golden gate | `.github/workflows/` | 1 |
| P6-06 | Metrics endpoint + dashboard + alert | `server.js`, `core/metrics.js` | 1 |
| P6-07 | Regression gate: precision không giảm >3%, P95 không tăng >20% | `eval/gate.js` | 1 |

### Tiêu chí hoàn thành

- `npm test` chạy unit + integration + eval.
- CI fail nếu gate vi phạm.
- Dashboard có retrieval precision, latency, cost, conflict rate.
- Báo cáo A/B có/không memory trên cùng bộ câu hỏi.

### Test

- Golden set chạy <5 phút.
- Gate chặn một thay đổi cố tình làm giảm precision.
- Metrics khớp log.

### Rủi ro

- Golden set thiên lệch ERP; bổ sung project khác và câu hỏi "không biết".
- Đánh giá answer correctness cần người/LLM judge; dùng rubric rõ.

---

## Phase 7 — Ecosystem (6–8 pd)

### Mục tiêu

Nhiều client dùng chung service layer; MCP/SDK/CLI; multi-client an toàn.

### Việc cần làm

| ID | Việc | File | Effort |
| :--- | :--- | :--- | ---: |
| P7-01 | MCP server (stdio/HTTP) | `mcp/server.js` | 2 |
| P7-02 | SDK JS tối giản | `sdk/js/` | 1.5 |
| P7-03 | CLI facade gọi service | `tools/*` | 1.5 |
| P7-04 | Idempotency, optimistic lock, multi-client test | `core/storage/`, `tests/` | 1.5 |
| P7-05 | Docs + ví dụ tích hợp ZCode/Claude/OpenCode | `docs/integration/` | 1 |
| P7-06 | Docker production + healthcheck + migration job | `Dockerfile`, `docker-compose.yml` | 1 |

### Tiêu chí hoàn thành

- MCP client đọc/ghi/retrieve được.
- SDK dùng được từ Node; REST vẫn tương thích.
- Hai client ghi đồng thời cùng item → không lost update.
- Docker compose khởi động sạch từ volume trống.

### Test

- MCP tool call end-to-end.
- Concurrent writes 10 client.
- Fresh docker compose up → health OK → eval smoke.

### Rủi ro

- MCP protocol thay đổi; dùng SDK chính thức, version pin.
- SDK thành abstraction thừa; giữ mỏng, chỉ HTTP client.

---

## 8. Backlog chi tiết theo thứ tự ưu tiên

| Ưu tiên | ID | Task | Phase | Effort |
| :--- | :--- | :--- | :--- | ---: |
| P0 | P0-02 | Migration runner + schema đầy đủ | 0 | 2 |
| P0 | P0-03 | Tắt dual-write, sửa mất dữ liệu | 0 | 1 |
| P0 | P0-01 | Backup + restore verify | 0 | 1 |
| P0 | P0-04 | Auth/rate limit/body limit | 0 | 2 |
| P0 | P0-06 | Baseline + golden set v0 | 0 | 1 |
| P1 | P1-01/02 | memory_item + backfill | 1 | 4 |
| P1 | P1-03/04 | Repository + KnowledgeWriter | 1 | 5 |
| P1 | P1-05 | Chuyển các đường ghi (save-qa, auto-harvest, server, proxy, auto-qa) | 1 | 3 |
| P1 | P1-07 | Project isolation | 1 | 1 |
| P1 | P1-08 | Working memory | 1 | 2 |
| P2 | P2-01 | ANN-first | 2 | 3 |
| P2 | P2-04/05 | Code-aware retrieval | 2 | 3.5 |
| P2 | P2-06 | Graph expand | 2 | 1.5 |
| P2 | P2-07 | Rerank | 2 | 2 |
| P2 | P2-09 | Sufficiency | 2 | 1.5 |
| P3 | P3-01/02/03 | Context builder/budget/compress | 3 | 5.5 |
| P3 | P3-04/05 | Citation/conflict | 3 | 2 |
| P4 | P4-01/02/03 | Gateway/router/health | 4 | 6 |
| P4 | P4-05 | Orchestrator | 4 | 3 |
| P4 | P4-06 | Verification | 4 | 2 |
| P5 | P5-01/02 | Consolidation/promotion | 5 | 5 |
| P5 | P5-05 | Recipe lifecycle | 5 | 1.5 |
| P6 | P6-01/02/03 | Golden set + metrics | 6 | 6 |
| P6 | P6-05/07 | CI + gate | 6 | 2 |
| P7 | P7-01/02 | MCP + SDK | 7 | 3.5 |

---

## 9. Tái sử dụng / Refactor / Viết mới theo phase

| Phase | Tái sử dụng | Refactor | Viết mới |
| :--- | :--- | :--- | :--- |
| 0 | `embed.js`, `keywords.js`, quality guard | `setup.js`, `server.js` auth, `config.js` path | migration runner, baseline harness |
| 1 | `find-qa-context`, `post-task`, `project-helper` | 5 write paths, `server.js` handler | repository, writer, trust, session |
| 2 | `queries.js`, `decompose-angles.json`, `codebase-indexer` parser | query SQL ANN-first, `find-code` | retrieval engine, filters, graph, rerank |
| 3 | L0/L1 formatting | `context-fetch` | context builder/budget/compress |
| 4 | `llm-local` prompts, `route-decision` risk/tag | proxy RAG/harvest, streaming | gateway, router, orchestrator, verifier |
| 5 | `curate`, `qa-health`, `agent_qa_history` | recipe tools | consolidate, promote, temporal, review |
| 6 | `benchmark-pg-vs-ame` latency | `stats`, dashboards | golden set, eval, CI, metrics |
| 7 | CLI suite | CLI wrappers | MCP, SDK, idempotency |

---

## 10. Test strategy tổng thể

| Tầng | Công cụ | Phạm vi | Khi nào |
| :--- | :--- | :--- | :--- |
| Unit | `node:test`/Vitest | trust rules, normalize, filters, budget | mỗi PR |
| Integration | PostgreSQL test container | repository, writer, retrieval, migration | mỗi PR |
| Contract | HTTP/MCP | API schema, auth, error codes | mỗi PR |
| Eval | Golden set | precision/recall/nDCG, e2e | nightly + release |
| Load | 50k synthetic | latency, memory | trước release lớn |
| Security | token/rate/body, injection | 401/403/413, SQL param | mỗi PR |

**CI gate tối thiểu:**

1. Lint + type check (JSDoc/tsc `checkJs` nếu chấp nhận).
2. Unit + integration pass.
3. Migration từ DB trống + từ snapshot hiện tại pass.
4. Golden gate: precision@5 không giảm >3%; P95 không tăng >20%.
5. Không có `catch {}` mới ở đường ghi/đọc chính (lint rule).

---

## 11. Risk register

| Rủi ro | Xác suất | Tác động | Giảm thiểu | Owner phase |
| :--- | :--- | :--- | :--- | :--- |
| Migration mất dữ liệu | Thấp | Cao | Backup, dry-run, idempotent, rollback | 0–1 |
| Project isolation làm mất kết quả | Trung bình | Trung bình | Global scope có kiểm soát; log cross-project | 1 |
| ANN + filter giảm recall | Trung bình | Cao | Đo trên golden set; tăng ef_search; pre-filter | 2 |
| Rerank tăng latency | Trung bình | Trung bình | Bật theo budget; cache | 2 |
| Orchestrator phức tạp | Cao | Trung bình | 3 mode; feature flag; test từng bước | 4 |
| Cloud cost tăng | Trung bình | Trung bình | Local-first; budget; cost log | 4 |
| Golden set thiên lệch | Cao | Cao | Đa project; câu hỏi "không biết"; review định kỳ | 6 |
| Scope creep | Cao | Trung bình | Bám phase; mỗi phase có acceptance | all |
| Bảo mật API | Trung bình | Cao | Auth, rate, audit, pen test nhẹ | 0, 7 |
| Không ai dùng feedback | Cao | Trung bình | Bắt buộc `mark-recipe`; UI/CLI đơn giản | 5 |

---

## 12. Definition of Done cho từng phase

Một phase chỉ được coi là xong khi:

1. Tất cả task ID của phase đã merge.
2. Test của phase pass trong CI.
3. Không có regression trên golden gate.
4. Tài liệu trong `docs/architecture/` được cập nhật (nếu quyết định thay đổi).
5. Có số liệu trước/sau cho ít nhất một chỉ số.
6. Feature flag có thể tắt, và đã thử tắt.
7. Backup/rollback đã thử trên bản sao.
8. Không thêm dependency nặng nếu không có lý do và số liệu.

---

## 13. Kế hoạch 4 tuần đầu (ví dụ thực thi)

| Tuần | Việc | Kết quả |
| :--- | :--- | :--- |
| 1 | P0-01..03, P0-06 | Backup, migration runner, tắt dual-write, baseline 50 query |
| 2 | P0-04, P0-05, P0-07, P1-01 | Auth, logging, path, schema memory_item |
| 3 | P1-02..04 | Backfill, repository, writer |
| 4 | P1-05..08 | Chuyển write paths, project isolation, session, test |

Sau 4 tuần: hệ thống có một nguồn sự thật, schema đầy đủ, baseline đo được; bắt đầu Phase 2.

---

## 14. Những quyết định cần chốt trước khi code

| Quyết định | Khuyến nghị | Lý do |
| :--- | :--- | :--- |
| PostgreSQL vs AME canonical | PostgreSQL | Chất lượng tiếng Việt, SQL linh hoạt, đã có dữ liệu |
| Có giữ AME không | Giữ như adapter/archive, không write path | Không mất giá trị single-file; tránh dual-write |
| Một bảng memory hay nhiều bảng | Một `memory_item` cho episodic+semantic | Chung retrieval/lifecycle |
| Có dùng graph DB riêng | Không | `memory_edge` đủ; graph thật chưa có nhu cầu |
| Có dùng Kafka/Redis | Không | Overkill cho 16 GB |
| Trust mặc định cho agent-direct | `observation` (cần review để lên verified) | Chống tự đầu độc |
| Có tự động promote semantic | Không; chỉ rule + evidence/user | Tránh fact giả |
| Auth mặc định | Bật, trừ health | An toàn mặc định |
| Giữ REST cũ | Có, map sang service mới | Tương thích client |

---

## 15. Kết luận lộ trình

- **Tuần 1–4:** ổn định và một nguồn sự thật. Đây là phần bắt buộc; mọi thứ khác đều vô nghĩa nếu dữ liệu tiếp tục lệch và query hỏng.
- **Tuần 5–10:** retrieval thực chất và context có ngân sách. Đây là nơi mang lại phần lớn giá trị cho agent.
- **Tuần 11–16:** hybrid reasoning và knowledge evolution. Đây là nơi Semantic Brain trở thành hệ thống tri thức thay vì cache.
- **Tuần 17–20:** evaluation và ecosystem. Đây là nơi chứng minh và mở rộng.

Không cần viết lại toàn bộ. Ước tính 55–65% code hiện tại có thể tái sử dụng; phần lớn công sức nằm ở **tầng dữ liệu, retrieval và kiểm chứng**, không phải UI/CLI.

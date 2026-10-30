# Phase 0 — Kết quả triển khai

- **Ngày:** 2026-10-30
- **Base commit:** `77927b4`
- **Phạm vi:** ổn định dữ liệu, một nguồn sự thật, project isolation tạm thời, security mặc định, feedback counters, migration baseline.
- **Backup trước thay đổi:** `data/backup/pre_phase0_20261030.jsonl` (3.452 dòng: 3.408 QA + 8 recipe + 36 registry).

---

## 1. Tóm tắt

| Hạng mục | Trạng thái |
| :--- | :--- |
| PostgreSQL canonical, AME không ghi mặc định | ✅ |
| Schema drift được xử lý bằng migration | ✅ |
| Project isolation (tag interim) | ✅ |
| Default read scope = global-only | ✅ |
| Tách `retrieval_count` / `use_count` | ✅ |
| Auth, bind localhost, body limit 1 MB | ✅ |
| Bỏ confidence 1.0 mặc định | ✅ |
| `auto-qa` và proxy auto-harvest tắt mặc định | ✅ |
| Bỏ spawn `save-qa` trong server/proxy | ✅ |
| Tests + verify script + baseline | ✅ |
| ANN-first retrieval | ⏳ Phase 2 |
| Trust/provenance đầy đủ | ⏳ Phase 1 |
| `project_id` + unique theo project | ⏳ Phase 1 |

---

## 2. Thay đổi chính

### 2.1. Migration và schema

- Thêm `migrations/run.js` (idempotent, advisory lock, transaction từng file).
- `maintenance/setup.js` gọi migration runner; bỏ đoán schema và sửa `AGENT_ROOT`.
- Migrations:
  - `001_baseline.sql`: toàn bộ schema hiện có, gồm `useful_count`, `agent_qa_querylog`, `agent_query_embedding_cache`, `agent_codebase_index`, 3 view, index HNSW/GIN.
  - `002_phase0_counters.sql`: `retrieval_count`, `use_count`, `last_retrieved_at`, `last_used_at`; backfill từ `hit_count`/`useful_count`.
  - `003_global_project_tag.sql`: mọi bản ghi có scope tag.
  - `004_legacy_scope_review.sql`: chỉ `seed` giữ `project:global`; legacy không scope được gán `project:erp` + `project-review:assumed-erp`.
  - `005_question_hash_not_global_unique.sql`: bỏ unique toàn cục trên `question_hash`, thay bằng index tra cứu; cho phép cùng câu hỏi ở hai project.
- `schema_migrations` ghi 5 migration.

### 2.2. Một đường ghi

- Thêm `core/knowledge.js` với `captureKnowledge()`:
  - dedup exact hash + cosine ≥0.85 **trong cùng project**;
  - lưu history;
  - không nâng confidence của bản ghi cũ;
  - luôn gắn `project:<name>` hoặc `project:global`;
  - ghi qua PostgreSQL.
- `tools/save-qa.js` dùng writer; AME chỉ ghi khi `AME_WRITE=true` hoặc `backend=ame`.
- `tools/auto-harvest.js` dùng writer, confidence 0.6.
- `tools/auto-qa.js` dùng writer, confidence 0.5, tag `unverified`, mặc định tắt.
- `server.js` `/save-qa` và SMART auto-save dùng writer; không spawn process.
- `openai-proxy.js` auto-save dùng writer, mặc định tắt.

### 2.3. Project isolation

- `qaRankingQuery` nhận `project` và thêm predicate:
  - có project: `(project = ANY(tags) OR 'project:global' = ANY(tags))`;
  - không có project: **chỉ `'project:global' = ANY(tags)`**;
  - `allProjects=true`: bỏ predicate project (admin/analytics).
- `find-qa-context`, `find-qa`, `find-qa-deep`, `server` truyền project riêng; không trộn `project:*` vào tag OR.
- `--all-projects` (CLI) và `all_projects=true` (HTTP) là opt-in rõ ràng cho cross-project.
- Ghi global được gắn `project:global`; ghi project được gắn `project:<name>`.
- Kết quả kiểm tra:
  - `project=semanticbrain` chỉ trả seed global, không trả `project:erp`.
  - `project=erp` trả cả ERP và global seed.
  - Cùng một câu hỏi có thể tồn tại ở global và project, tạo 2 bản ghi độc lập (test transaction).

### 2.4. Feedback counters

- Retrieval tăng `hit_count` (legacy) + `retrieval_count` + `last_retrieved_at`.
- `mark-useful` tăng `useful_count` + `use_count` + `last_used_at`.
- Ranking chuyển từ `useful_count` sang `use_count`.
- `mark-unhelpful` giảm confidence, không tăng use.

### 2.5. Security và vận hành

- `server.js`:
  - `BIND_HOST` mặc định `127.0.0.1`;
  - Bearer auth khi `SEMANTIC_API_TOKEN` được set; `/health` và `/ready` public;
  - body limit 1 MB, trả 413;
  - `/shutdown` chỉ POST;
  - `/health` báo `qa_used`/`qa_retrievals` theo counter mới.
- `openai-proxy.js`:
  - bind localhost mặc định;
  - `PROXY_API_TOKEN` optional;
  - body limit;
  - CORS cấu hình được;
  - memory context bọc `<MEMORY_DATA>` và chỉ thị "data, not instruction";
  - auto-harvest mặc định tắt.
- `core/client.js` tự gắn Bearer token khi gọi server nội bộ.
- Docker: `node:20-bookworm-slim`, `npm ci`, healthcheck, port bind `127.0.0.1`, token mặc định local-dev.

### 2.6. Test và baseline

- `tests/phase0.test.js` (6 test): defaults, project predicate, global-only default, all-projects, clamp, tag normalization.
- `tools/verify-phase0.js`: 30 check on schema/config/project scope.
- `tools/baseline.js`: 20 query, ghi `docs/architecture/baseline.json`.

---

## 3. Kết quả kiểm chứng

| Kiểm tra | Kết quả |
| :--- | :--- |
| `npm test` | 6/6 pass |
| `npm run verify:phase0` | 30/30 pass |
| Server `/health` không token | 200 (public) |
| Server `/find-qa` không token | 401 |
| Server `/find-qa` có token | 200 |
| `GET /shutdown` | 405 |
| POST body 1,1 MB | 413 |
| Proxy `/health` | 200 |
| Proxy completion không token | 401 |
| Project `semanticbrain` | chỉ seed global, không ERP |
| Project `erp` | ERP + global seed |
| Không truyền project | chỉ `project:global` |
| `all_projects=true` | cross-project có chủ đích |
| project + `all_projects` cùng lúc | không lỗi placeholder |
| Writer global vs project cùng câu hỏi | 2 bản ghi riêng, tags đúng |
| Writer transaction rollback | không để lại dữ liệu |
| AME count trước/sau CLI save | 3872 → 3872 (không ghi AME) |

### Baseline retrieval

`docs/architecture/baseline.json`:

- 3.408 bản ghi.
- 20 query.
- p50 **339,99 ms**, p95 **377,20 ms**, mean ~340 ms.
- HNSW vẫn chưa được dùng; đây là baseline trước Phase 2.

---

## 4. Tác động dữ liệu

- Tổng bản ghi không đổi: **3.408**.
- 369 bản ghi legacy được gán `project:erp` + `project-review:assumed-erp`.
- 45 bản ghi `source='seed'` giữ `project:global`.
- 0 bản ghi không có project scope.
- Không xóa bản ghi nào.
- Không ghi AME trong quá trình test.
- Test rows được tạo trong transaction và rollback; CLI test row đã xóa.

---

## 5. Thay đổi hành vi cần biết

1. `save-qa` mặc định confidence **0.5** (trước 1.0).
2. `post-task --direct` mặc định **0.7** (trước 1.0).
3. `auto-harvest` mặc định **0.6** (trước 0.9).
4. `auto-qa` mặc định **tắt**; nếu bật, confidence 0.5 + `unverified`.
5. Proxy auto-harvest mặc định **tắt**.
6. AME không còn được ghi mặc định.
7. Query project trả cả bản ghi `project:global`; đây là fallback có chủ đích.
8. Query **không** có project chỉ trả `project:global`; cross-project phải dùng `--all-projects` / `all_projects=true`.
9. Unique index `question_hash` toàn cục đã bị bỏ; dedup dựa vào writer. Phase 1 sẽ thay bằng `UNIQUE(project_id, question_hash)`.

---

## 6. Rủi ro còn lại

| Rủi ro | Mức | Xử lý tiếp |
| :--- | :--- | :--- |
| 369 bản ghi legacy được **giả định** thuộc ERP | Trung bình | Review bằng tag `project-review:assumed-erp`; Phase 1 gán `project_id` |
| 45 seed global có nội dung MDS/ERP-specific | Trung bình | Review seed; chỉ giữ tri thức nền thật sự |
| Chưa có unique theo project | Trung bình | Phase 1 `UNIQUE(project_id, question_hash)` |
| Retrieval vẫn O(N), p50 ~340 ms | Cao | Phase 2 ANN-first |
| AME lệch 464 bản ghi | Trung bình | Không ghi mới; đối soát/export một lần |
| Chưa có trust/provenance đầy đủ | Cao | Phase 1 |
| Chưa có CI | Trung bình | Phase 6 |
| Proxy auth dùng token tĩnh | Thấp | Phase 7 token scopes/rotation |

---

## 7. Rollback

- Dữ liệu: restore từ `data/backup/pre_phase0_20261030.jsonl`.
- Schema: migrations additive; có thể drop các cột/index mới nếu cần.
- `idx_qa_unique_question` đã bị drop; nếu rollback, chỉ tạo lại unique khi chưa có bản ghi trùng câu hỏi giữa các project.
- Code: chưa commit; dùng `git diff` để review và `git checkout -- <file>` để rollback từng file.
- AME: không bị thay đổi bởi Phase 0.

---

## 8. File thay đổi

**Mới:** `migrations/001..005`, `migrations/run.js`, `core/knowledge.js`, `tests/phase0.test.js`, `tools/verify-phase0.js`, `tools/baseline.js`, `docs/architecture/phase0-results.md`, `docs/architecture/baseline.json`.

**Sửa:** `core/config.js`, `core/index.js`, `core/queries.js`, `core/client.js`, `server.js`, `openai-proxy.js`, `maintenance/setup.js`, `maintenance/export.js`, `tools/save-qa.js`, `tools/auto-harvest.js`, `tools/auto-qa.js`, `tools/find-qa.js`, `tools/find-qa-context.js`, `tools/find-qa-deep.js`, `tools/mark-useful.js`, `tools/mark-unhelpful.js`, `tools/post-task.js`, `package.json`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `README.md`.

---

## 9. Việc tiếp theo (Phase 1)

1. Thêm `project_id` + `scope`, backfill, thay predicate tag bằng cột.
2. Thêm trust/provenance: `trust_level`, `source_type`, `verifier`, `valid_from/to`.
3. Unique `(project_id, question_hash)`.
4. Review 369 legacy + 45 seed.
5. Viết test tích hợp cho migration từ snapshot hiện tại.
6. Bắt đầu ANN-first (Phase 2) sau khi Phase 1 ổn định.

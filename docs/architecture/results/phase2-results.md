# Phase 2 — Kết quả triển khai: project_id, trust/provenance, ANN-first

- **Ngày:** 2026-10-30
- **Branch:** `feat/phase0-stabilization`
- **Migrations:** `008_project_id.sql`, `009_trust_provenance.sql`, `010_ann_first_retrieval.sql`

---

## 1. Tóm tắt

| Năng lực | Trạng thái |
| :--- | :--- |
| `project_id` cột thật | ✅ |
| Unique `(project_id, question_hash)` cho atom | ✅ |
| Trigger suy `project_id` cho direct insert | ✅ |
| `trust_level` 5 mức | ✅ |
| `source_type`, `evidence`, `verifier`, `verified_at` | ✅ |
| `valid_from` / `valid_to` / `status` | ✅ |
| Query lọc `status='active'` + hết hạn | ✅ |
| ANN-first candidate + FTS candidate | ✅ |
| `tsv` generated + GIN index | ✅ |
| Baseline global p50 | **5,53 ms** |
| Baseline ERP p50 | **48,22 ms** |
| Phase 0/1/2 verify | 31 / 27 / 28 |

---

## 2. project_id

### 2.1. Schema

```sql
project_id TEXT NOT NULL
CREATE UNIQUE INDEX idx_qa_unique_project_question
  ON agent_qa_cache(project_id, question_hash)
  WHERE COALESCE(chunk_type, 'atom') = 'atom';
```

- Backfill từ `scope` + tag `project:*`; global → `project_id='global'`.
- Kết quả: 3.410 row, 18 project, 0 null.
- Trigger `sync_qa_scope` set `project_id` cho direct insert (seed/import/replay).
- Query dùng `project_id = $5` thay vì so tag.

### 2.2. Hệ quả

- Cùng một câu hỏi có thể tồn tại ở hai project khác nhau; unique chỉ trong cùng project.
- Global là `project_id='global'` + `scope='global'`.
- Dedup writer dùng `project_id`; không còn phụ thuộc tag.

---

## 3. Trust & provenance

### 3.1. Cột

```sql
trust_level    TEXT NOT NULL DEFAULT 'observation'
source_type    TEXT
evidence       JSONB DEFAULT '[]'
verifier       TEXT
verified_at    TIMESTAMPTZ
valid_from     TIMESTAMPTZ
valid_to       TIMESTAMPTZ
status         TEXT NOT NULL DEFAULT 'active'
```

- 5 mức: `observation`, `hypothesis`, `inference`, `verified_fact`, `user_decision`.
- `verified_fact` chỉ khi có `verifier` hoặc `evidence`; nếu thiếu → hạ về `hypothesis`.
- `user_decision` chỉ nhận khi source `user`.
- Agent write mặc định `observation`; có evidence → `hypothesis`.
- Seed/teach/manual/reviewed → `verified_fact`.
- `auto-harvest`/proxy/smart-rag cũ → `inference` (legacy).
- Query chỉ trả `status='active'` và `valid_to` chưa hết hạn.
- Trust hiện được trả trong kết quả retrieval và REST HIT.

### 3.2. Backfill hiện tại

| Trust | Số row |
| :--- | ---: |
| observation | 2.871 |
| inference | 407 |
| verified_fact | 132 |

Không có `user_decision` hay `hypothesis` trong dữ liệu cũ. Agent writes mới sẽ tạo đúng mức.

---

## 4. ANN-first retrieval

### 4.1. Cấu trúc query

```
ann:  ORDER BY embedding <=> $1 LIMIT candidateK
fts:  tsv @@ plainto_tsquery(...) ORDER BY ts_rank_cd LIMIT candidateK
cand: UNION(ann, fts)
base: score candidates (vector + FTS + freshness + confidence + use)
rank: RRF + final order
```

- `candidateK` mặc định 100, cấu hình qua `opts.candidateK`.
- `tsv` generated column + GIN index `idx_qa_tsv`.
- Project/status/validity/chunk filters áp dụng trước candidate.
- Params cố định: vector, tags, query, limit, project, allProjects, candidateK.

### 4.2. Đo được

| Kịch bản | p50 | p95 |
| :--- | ---: | ---: |
| Global-only (45 row) | 5,53 ms | 12,84 ms |
| ERP project (3.152 row) | 48,22 ms | 63,29 ms |
| Trước ANN (global baseline Phase 0) | 339,99 ms | 377,20 ms |

- Global baseline trước đây query toàn bộ bảng (vì không lọc project); con số không hoàn toàn cùng scope, nhưng cho thấy mức cải thiện.
- Ở 3.410 row, planner chọn project index + sort cho nhánh ANN (rẻ hơn HNSW); HNSW vẫn sẵn sàng cho dữ liệu lớn.
- Cần benchmark 50k synthetic trước khi khẳng định scale; đây là việc tiếp theo.

---

## 5. Kiểm chứng

| Kiểm tra | Kết quả |
| :--- | :--- |
| `npm test` | **24/24 pass** |
| `npm run verify:phase0` | **31/31 pass** |
| `npm run verify:phase1` | **27/27 pass** |
| `npm run verify:phase2` | **28/28 pass** |
| project_id null | 0 |
| unique index | tồn tại |
| trust values | hợp lệ |
| retrieval status/validity filter | có |
| ANN/FTS CTE | có |
| tsv GIN index | có |

---

## 6. Thay đổi hành vi

1. Retrieval dùng `project_id`, không dùng tag `project:*`.
2. Query chỉ trả bản ghi `status='active'` và chưa hết `valid_to`.
3. Kết quả trả thêm `project_id`, `trust_level`, `parent_id`.
4. `save-qa`, `/save-qa`, `/ingest`, `ingest-knowledge` nhận `trust`, `verifier`, `evidence`, `valid_from/to`, `status`.
5. `verified_fact` không có evidence/verifier bị hạ về `hypothesis`.
6. Unique câu hỏi theo project; cùng câu hỏi ở global và project là hai bản ghi.

---

## 7. Rủi ro còn lại

| Rủi ro | Mức | Xử lý |
| :--- | :--- | :--- |
| Planner chưa chọn HNSW ở 3.4k | Thấp | Benchmark 50k; có thể tăng candidateK hoặc dùng iterative scan |
| 2.871 observation chưa được kiểm chứng | Trung bình | Review/promotion workflow |
| Chưa có CLI verify/promote trust | Trung bình | Phase 3 knowledge evolution |
| `status` mới chỉ dùng filter; curate chưa set status | Trung bình | Cập nhật curate/qa-health |
| `project_id` backfill dựa trên tag cũ | Thấp | 0 null; 369 assumed-erp đã có nhãn review |
| Parent document chưa fetch khi query atom | Thấp | Phase 3 parent-child retrieval |

---

## 8. Việc tiếp theo

1. Cập nhật `curate`/`qa-health` set `status` thay vì chỉ tag.
2. CLI `verify`/`promote` trust (observation → verified).
3. Benchmark 50k synthetic; điều chỉnh candidateK/HNSW.
4. Parent-child retrieval.
5. Context budget/citation (Phase 3).

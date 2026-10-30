# Phase 1 — Kết quả triển khai: Scope + Atomic Ingestion

- **Ngày:** 2026-10-30
- **Branch:** `feat/phase0-stabilization`
- **Migration:** `006_scope_and_atoms.sql`, `007_scope_trigger.sql`
- **Phạm vi:** phân loại global/project, atomic normalizer, ingest pipeline, review queue, retrieval chỉ trên atom.

---

## 1. Tóm tắt

| Năng lực | Trạng thái |
| :--- | :--- |
| Cột `scope` / `scope_origin` / `scope_reason` | ✅ |
| Global candidate + review queue | ✅ |
| Deterministic ScopeResolver | ✅ |
| LLM normalizer tách atom | ✅ |
| Parent document + atom (`parent_id`, `atom_index`) | ✅ |
| Retrieval chỉ trả atom, bỏ document | ✅ |
| `save-qa` chặn answer > 2000 ký tự | ✅ |
| `post-task --direct` bắt buộc format 2–3 phần | ✅ |
| `review-scope` approve/reject | ✅ |
| Trigger suy scope cho direct insert | ✅ |
| Tests + verify Phase 1 | ✅ (19 test, 24 check) |
| `project_id` cột thật | ⏳ Phase 2 |
| Trust/provenance đầy đủ | ⏳ Phase 2 |
| Parent-child retrieval (fetch parent từ atom) | ⏳ Phase 2 |

---

## 2. Phân loại scope

### 2.1. Thứ tự quyết định

1. `--scope=global|project` explicit.
2. Tag `project:global` explicit (khi không có project context).
3. `scope_hint` từ normalizer (LLM đề xuất, không tự publish global).
4. Deterministic content signals:
   - project markers: `MDS`, `MOP`, `MLG2`, `RAF`, `ERP`, `ZeroAgent`, `tbSYS_`, `I*Service`, `Features/`, đường dẫn ổ đĩa, `.cs/.sql`.
   - generic markers: ngôn ngữ/framework/pattern (JavaScript, async, DTO, SQL, WinForms...).
5. Project context default.

### 2.2. Quy tắc

| Tình huống | Kết quả |
| :--- | :--- |
| `--scope=global` | Global, origin `explicit` |
| `--scope=project` có project | Project |
| `--scope=project` không có project | Global (không thể gắn project) |
| Có project + nội dung generic | Project + `scope_candidate=global`, `review_status=pending` |
| Có project + marker dự án | Project, không candidate |
| Không project | Global |
| Normalizer hint global + có project | Project + candidate global + pending |
| Normalizer hint global + không project | Global |

**Không auto-publish global.** Một bài học generic trong project vẫn chỉ dùng được trong project cho đến khi reviewer approve.

### 2.3. Cột mới

```sql
scope              TEXT NOT NULL DEFAULT 'project'
scope_origin       TEXT          -- explicit|tag|normalizer|heuristic|context|default|review|migration
scope_reason       TEXT
scope_confidence   REAL
scope_candidate    TEXT          -- 'global' khi chờ review
review_status      TEXT          -- none|pending|approved|rejected
parent_id          BIGINT        -- document cha
atom_index         INT
chunk_type         TEXT          -- atom|document
source_ref         TEXT          -- file/session/proxy ref
```

Backfill: 45 bản ghi `seed` → global; 3.364 bản ghi còn lại → project. Không có bản ghi `scope IS NULL`.

---

## 3. Atomic ingestion

### 3.1. Luồng

```
raw text
  → normalizeKnowledge()
      structured "problem | cause | fix"  → 1 atom
      long text → LLM extractor → JSON atoms
      validate: question 10..300, answer 20..1500, max 8, dedup
      long text + 0 atoms → E_ATOMIC_REQUIRED (không lưu cụm dài)
      short text + extractor offline → 1 atom fallback
  → ingestText()
      atoms > 1 → parent document row
      mỗi atom → captureKnowledge() với embedding riêng
```

### 3.2. Parent document

- `chunk_type='document'`, `embedding=NULL`, `parent_id=NULL`.
- `question = [DOCUMENT] <source_ref>`, `answer = full text`.
- Atoms: `chunk_type='atom'`, `parent_id=<document id>`, `atom_index=0..n`.
- Retrieval query có `COALESCE(chunk_type,'atom')='atom'`, nên document không xuất hiện trong top-k.
- `source_ref` giữ nguồn (file, session, proxy, CLI).

### 3.3. Tích hợp

| Đường ghi | Hành vi mới |
| :--- | :--- |
| `auto-harvest` | Normalizer + ingest; parent document nếu nhiều atom |
| `post-task --direct` | Bắt buộc `problem | cause | fix`; nếu không reject |
| `save-qa` | Q/A đơn; chặn answer > 2000 trừ `--allow-long` |
| `server /save-qa` | Như `save-qa`; nhận `scope` |
| `server` SMART auto-save | Mặc định tắt (`SMART_AUTO_SAVE=false`); nếu bật → ingest atom |
| `openai-proxy` auto-harvest | Mặc định tắt; nếu bật → ingest atom |
| `auto-qa` | Q/A đơn, confidence 0.5, `unverified` |

### 3.4. LLM ở đâu?

- **Scope:** deterministic; LLM chỉ góp `scope_hint` trong normalizer, không tự publish global.
- **Atomic:** LLM đề xuất atom; validator deterministic quyết định lưu/từ chối.
- Nếu LLM không khả dụng:
  - text ngắn (≤600 ký tự) → fallback 1 atom;
  - text dài → reject `E_ATOMIC_REQUIRED` / `E_EXTRACTOR_FAILED`.

---

## 4. Review queue

```bash
node tools/review-scope.js                 # danh sách pending
node tools/review-scope.js --approve=123   # promote global
node tools/review-scope.js --reject=124    # giữ project
```

- Approve: `scope='global'`, `review_status='approved'`, tags chuyển về `project:global`.
- Reject: `scope='project'`, `review_status='rejected'`, giữ tag project.
- Không xóa dữ liệu.

---

## 5. Kiểm chứng

| Kiểm tra | Kết quả |
| :--- | :--- |
| `npm test` | **19/19 pass** |
| `npm run verify:phase0` | **31/31 pass** |
| `npm run verify:phase1` | **24/24 pass** |
| Migration 006 | applied |
| Migration 007 (scope trigger) | applied |
| Trigger direct insert | global/project suy đúng từ tag |
| `scope IS NULL` | 0 |
| Scope distribution | global 45 / project 3.364 |
| Atom/document | 3.409 atom / 0 document (trước ingest test) |
| Generic lesson trong project | project + candidate global + pending |
| Project-specific lesson | project, không candidate |
| Explicit global | global |
| Parent document | tạo đúng, atoms có `parent_id`/`atom_index` |
| Review approve/reject | đúng, tags chuyển `project:global` / giữ project |
| `post-task --direct` không có `|` | exit 1 |
| `save-qa` answer 2.100 ký tự | exit 1 |

Các test ingest/review được chạy trong transaction hoặc xóa sạch sau test; không còn row test.

---

## 6. Thay đổi hành vi

1. `auto-harvest` lưu theo atom, không lưu cả summary thành 1 Q/A.
2. `post-task --direct` không còn nhận text tự do; phải có `|`.
3. `save-qa` / `/save-qa` chặn answer > 2000 ký tự trừ khi explicit `--allow-long` / `allow_long=true`.
4. `server` SMART auto-save mặc định tắt; nếu bật, chạy normalizer (tốn thêm LLM).
5. Proxy auto-harvest mặc định tắt; nếu bật, chạy normalizer.
6. Global candidate không tự publish; cần `review-scope`.
7. Retrieval bỏ qua document; chỉ trả atom.

---

## 7. Rủi ro còn lại

| Rủi ro | Mức | Xử lý |
| :--- | :--- | :--- |
| Chất lượng atom phụ thuộc LLM local (qwen 1.5B) | Trung bình | Dùng cloud cho extraction nếu cần; validator chặn atom quá dài |
| Normalizer có thể tách quá nhiều/ít atom | Trung bình | Max 8, dedup, review; Phase 2 thêm eval |
| `project_id` vẫn là tag, chưa phải cột | Trung bình | Phase 2 thêm `project_id` + unique |
| Chưa fetch parent document từ atom | Thấp | Phase 2 parent-child retrieval |
| Global candidate review thủ công | Thấp | Có thể thêm batch review/CLI filter |
| Trust/provenance chưa đầy đủ | Cao | Phase 2 |

---

## 8. Việc tiếp theo

1. `project_id` cột thật + `UNIQUE(project_id, question_hash)`.
2. Trust levels + verification evidence.
3. Parent-child retrieval: atom → fetch document summary khi cần.
4. Evaluation atom-level: precision@k, atom hit rate, context token reduction.
5. ANN-first retrieval (Phase 2) để giảm p50 ~340 ms.

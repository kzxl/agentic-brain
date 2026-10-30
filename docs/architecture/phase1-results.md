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
| LLM normalizer tách atom | ❌ đã bỏ |
| Agent-provided atoms + validator | ✅ |
| Parent document + atom (`parent_id`, `atom_index`) | ✅ |
| Retrieval chỉ trả atom, bỏ document | ✅ |
| `save-qa` chặn answer > 2000 ký tự | ✅ |
| `post-task --direct` bắt buộc format 2–3 phần | ✅ |
| `review-scope` approve/reject | ✅ |
| Trigger suy scope cho direct insert | ✅ |
| Tests + verify Phase 1 | ✅ (19 test, 26 check) |
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
agent (đã có task context)
  → JSON atoms
      hoặc text structured "problem | cause | fix"
  → parseIngestPayload / validateAtoms
      question 10..300, answer 20..1500, max 8, dedup
  → ingestText()
      atoms > 1 → parent document row
      mỗi atom → captureKnowledge() với embedding riêng

Raw walkthrough text → E_ATOMS_REQUIRED.
Không còn local LLM đọc lại summary.
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
| `tools/ingest-knowledge.js` | Canonical: đọc JSON atoms từ file/stdin/`--json`, validate, ingest |
| `post-task --file=atoms.json` / `--json=` | Forward sang `ingest-knowledge` |
| `post-task --direct` | Một atom `problem | cause | fix`; không LLM |
| `save-qa` | Q/A đơn; chặn answer > 2000 trừ `--allow-long` |
| `server /ingest` | POST JSON atoms; không LLM |
| `server /save-qa` | Q/A đơn; nhận `scope` |
| `server` SMART auto-save | **Đã bỏ** — server không tự lưu câu trả lời |
| `openai-proxy` | **Không tự học** — chỉ inject RAG và forward |
| `auto-harvest` | Shim deprecated: chỉ forward JSON sang `ingest-knowledge` |
| `auto-qa` | Q/A đơn khi MISS, confidence 0.5, mặc định tắt |

### 3.4. LLM ở đâu?

- **Harvest:** không dùng LLM. Agent tự tạo atom; validator deterministic quyết định lưu/từ chối.
- **Scope:** deterministic; agent có thể gửi `scope_hint` trong atom, không tự publish global.
- **LLM còn lại:** chỉ dùng cho trả lời/synthesis và `auto-qa` (mặc định tắt), không dùng để phân tích lại summary.

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
| `npm run verify:phase1` | **26/26 pass** |
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
| Raw walkthrough text | reject `E_ATOMS_REQUIRED` |

Các test ingest/review được chạy trong transaction hoặc xóa sạch sau test; không còn row test.

---

## 6. Thay đổi hành vi

1. `auto-harvest` bị deprecate; agent cung cấp JSON atoms qua `ingest-knowledge`.
2. `post-task --direct` không còn nhận text tự do; phải có `|`.
3. `save-qa` / `/save-qa` chặn answer > 2000 ký tự trừ khi explicit `--allow-long` / `allow_long=true`.
4. `server` không tự lưu câu trả lời SMART; agent gọi `/ingest`.
5. Proxy không tự học; chỉ inject RAG và forward completion.
6. Global candidate không tự publish; cần `review-scope`.
7. Retrieval bỏ qua document; chỉ trả atom.

---

## 7. Rủi ro còn lại

| Rủi ro | Mức | Xử lý |
| :--- | :--- | :--- |
| Chất lượng atom phụ thuộc agent | Trung bình | Schema + validator + review; agent có context tốt hơn local LLM |
| Agent gửi atom quá dài/không đúng schema | Trung bình | `validateAtoms` reject; max 8 atom, answer ≤1500 |
| `project_id` vẫn là tag, chưa phải cột | Trung bình | Phase 2 thêm `project_id` + unique |
| Chưa fetch parent document từ atom | Thấp | Phase 2 parent-child retrieval |
| Global candidate review thủ công | Thấp | Có thể thêm batch review/CLI filter |
| Trust/provenance chưa đầy đủ | Cao | Phase 2 |

---

## 8. Việc tiếp theo

1. `project_id` cột thật + `UNIQUE(project_id, question_hash)`.
2. Trust levels + verification evidence.
3. Agent workflow: `post-task --file=atoms.json` / `POST /ingest`.
4. Parent-child retrieval: atom → fetch document summary khi cần.
5. Evaluation atom-level: precision@k, atom hit rate, context token reduction.
6. ANN-first retrieval (Phase 2) để giảm p50 ~340 ms.

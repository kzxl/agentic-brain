# Semantic Brain — Architecture Documentation

Bộ tài liệu kiểm toán và thiết kế đích, lập ngày 2026-10-30 trên commit `77927b4`.

| Tài liệu | Nội dung | Đọc khi |
| :--- | :--- | :--- |
| [current-state-audit.md](current-state-audit.md) | Kiểm toán 14 thành phần, sơ đồ hiện trạng, số liệu đo được, technical debt, 10 vấn đề và 10 cải tiến | Cần biết "hiện tại đang ở đâu" |
| [memory-system.md](memory-system.md) | Thiết kế 5 loại memory, trust/provenance, lifecycle, schema, consolidation, migration | Cần biết "bộ nhớ sẽ tổ chức thế nào" |
| [hybrid-reasoning.md](hybrid-reasoning.md) | Workflow suy luận, adaptive model routing, gateway, sufficiency, conflict, harvest gate | Cần biết "LLM và tri thức phối hợp ra sao" |
| [target-architecture.md](target-architecture.md) | Kiến trúc đích, module boundary, API, storage, migration tăng dần, so sánh phương án | Cần biết "hệ thống sẽ trông thế nào" |
| [remediation-plan.md](remediation-plan.md) | Cách xử lý từng sự cố: patch đề xuất, DDL, quick wins 3 ngày, nghiệm thu | Cần biết "sửa cái gì, sửa thế nào" |
| [phase0-results.md](phase0-results.md) | Kết quả triển khai Phase 0, migration, kiểm chứng, baseline, rủi ro còn lại | Cần biết "đã làm gì và hiện trạng mới" |
| [phase1-results.md](phase1-results.md) | Kết quả Phase 1: scope resolver, atomic ingestion, review queue | Cần biết "tri thức được phân loại và tách atom thế nào" |
| [phase2-results.md](phase2-results.md) | Kết quả Phase 2: project_id, trust/provenance, ANN-first | Cần biết "đã scale và kiểm chứng tri thức thế nào" |
| [phase3-results.md](phase3-results.md) | Kết quả Phase 3: status lifecycle, trust promotion, parent context, ANN 50k | Cần biết "vận hành và scale hiện tại" |
| [baseline.json](baseline.json) | Baseline 20 query: latency, top hits | So sánh sau Phase 2 |
| [implementation-roadmap.md](implementation-roadmap.md) | 8 phase, backlog, test, risk, 4 tuần đầu | Cần biết "làm gì trước, tốn bao nhiêu" |

## Phase 1 (đã triển khai)

- `scope` / `scope_origin` / `scope_candidate` / `review_status` là cột thật.
- Trigger DB suy scope cho các direct insert (seed/import/replay).
- Scope deterministic; generic lesson trong project thành global candidate, cần review.
- Agent cung cấp atomic JSON; `ingest-knowledge` validate + lưu document cha + atom con.
- Không còn local LLM đọc lại summary trong harvest.
- Retrieval chỉ trả atom; document không lọt top-k.
- `post-task --direct` bắt buộc format; `save-qa` chặn answer quá dài.
- Chi tiết: [phase1-results.md](phase1-results.md).

## Phase 3 (đã triển khai)

- `curate`/`qa-health` dùng `status` + `retrieval_count`/`use_count`; views đã đổi nguồn.
- `trust:promote` nâng observation → verified_fact với evidence/verifier.
- `--with-parent` / `include_parent` fetch parent document; `view-qa` hiển thị parent/children.
- 50k benchmark: planner 522 ms vs forced HNSW 57 ms; production bật `RETRIEVAL_FORCE_INDEX=true`.
- Chi tiết: [phase3-results.md](phase3-results.md), [baseline-ann-50000.json](baseline-ann-50000.json).

## Phase 2 (đã triển khai)

- `project_id` là cột thật; unique `(project_id, question_hash)` cho atom.
- Trust 5 mức + `source_type`, `evidence`, `verifier`, `valid_from/to`, `status`.
- Retrieval chỉ trả `status='active'`, chưa hết hạn; trả kèm trust/project.
- ANN-first candidate + FTS candidate trên `tsv` GIN index.
- Baseline Phase 2 (planner): global p50 **5,53 ms**, ERP p50 **48,22 ms**.
- Phase 3 production force-index: global **8,04 ms**, ERP **49,15 ms**, 50k forced HNSW **56,77 ms**.
- Chi tiết: [phase2-results.md](phase2-results.md), [baseline-erp.json](baseline-erp.json).

## Baseline tóm tắt (snapshot trước Phase 0)

- 3.407 QA, 69 MB PostgreSQL; AME 3.871 bản ghi, lệch 464.
- Embedding: BGE-M3 1024 (PostgreSQL) vs MiniLM 384 (AME).
- Query lõi: Seq Scan 3.407 dòng, ~290 ms; HNSW không được dùng.
- 72% bản ghi cũ hơn 60 ngày; 797 chưa từng dùng; 0 pinned; 0 stale.
- `useful_count` tổng = 1; recipe 8 bản ghi, 0 success.
- Không có test/CI/auth.

## Phase 0 (đã triển khai)

- PostgreSQL là canonical; AME không ghi mặc định.
- Schema được quản lý bằng migration (`001`–`005`), không còn drift.
- Project scope được enforce; 369 legacy record được gán `project:erp` + nhãn review.
- Query không có project chỉ trả global; `--all-projects` là opt-in.
- Auth Bearer, bind localhost, body limit 1 MB.
- `retrieval_count` / `use_count` tách khỏi `hit_count`.
- Baseline mới: p50 **340 ms**, p95 **377 ms** trên 3.408 bản ghi; ANN-first là Phase 2.
- Chi tiết: [phase0-results.md](phase0-results.md).

## Nguyên tắc đọc

- Số liệu trong tài liệu là **đo trên máy và DB thật ngày 2026-10-30**, không phải ước lượng, trừ khi ghi rõ "ước tính".
- Phân loại tính năng: **đã triển khai** / **một phần** / **chưa có**. Không đánh giá hoàn thiện dựa trên class/interface.
- Các đề xuất ưu tiên tương thích ngược và triển khai tăng dần; không yêu cầu viết lại toàn bộ.

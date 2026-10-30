# Phase 3 — Kết quả triển khai: Lifecycle, Trust Promotion, Parent Context, ANN 50k

- **Ngày:** 2026-10-30
- **Branch:** `feat/phase0-stabilization`
- **Migration:** `011_lifecycle_views.sql`
- **Phạm vi:** status column, trust promotion, parent-child retrieval, 50k ANN benchmark.

---

## 1. Tóm tắt

| Năng lực | Trạng thái |
| :--- | :--- |
| `curate` dùng `status` thay tag `status:stale` | ✅ |
| `curate` dùng `retrieval_count`/`use_count`, không `hit_count` | ✅ |
| `qa-health` dùng counters + `status` | ✅ |
| Views `v_qa_dashboard` / `v_qa_quality` dùng counters mới | ✅ |
| CLI `trust:promote` (observation → verified_fact) | ✅ |
| Parent document fetch (`--with-parent`, `include_parent`) | ✅ |
| `view-qa` hiển thị parent/children/trust/status | ✅ |
| 50k ANN benchmark + force-index retrieval | ✅ |

---

## 2. Lifecycle dùng cột `status`

### 2.1. `curate.js`

- Stale = `status='active'`, `retrieval_count=0`, `use_count=0`, idle > threshold.
- Apply: `UPDATE ... SET status='stale'`, **không** ghi tag `status:stale`.
- Output: total / pinned / active / stale / archived.
- Overlap audit chỉ xét `status='active'` và atom.

### 2.2. `qa-health.js`

- Cold entries: 0 retrievals, 0 uses, idle > threshold, `status='active'`.
- `--fix` decay confidence và set `status='stale'`.
- Low-confidence and source-quality reports dùng counters mới.
- Usefulness: `use_count` thay `useful_count`; `retrieval_count` thay `hit_count`.

### 2.3. Views

`011_lifecycle_views.sql` thay hai view:
- `v_qa_dashboard`: `used`/`total_hits` từ `retrieval_count`; `proven_useful` từ `use_count`.
- `v_qa_quality`: giữ tên cột tương thích nhưng nguồn là counters mới.

`stats.js` cũng chuyển sang counters; key JSON giữ nguyên để `post-task` không gãy.

---

## 3. Trust promotion CLI

```bash
node tools/promote-trust.js --list
node tools/promote-trust.js --id=42 --to=verified_fact --verifier=build --evidence=build:ok
node tools/promote-trust.js --id=42 --to=user_decision --user
```

- Chỉ cho phép upgrade (`trustRank` tăng).
- `verified_fact` bắt buộc `--evidence` hoặc `--verifier`.
- `user_decision` bắt buộc `--user`.
- Cập nhật `trust_level`, `source_type`, `verifier`, `verified_at`, `evidence`.
- Đã test: `observation → verified_fact` với evidence `build:ok,test:unit`.

---

## 4. Parent-child retrieval

- `core/parents.js` `attachParents(rows, db, {maxChars=2000})`:
  - gom `parent_id`, query một lần, gắn `parent` vào từng atom.
  - xử lý `parent_id` kiểu BIGINT trả về dạng string.
- `find-qa-context --with-parent` (hoặc `--full`) in parent question + body.
- `find-qa --with-parent` và `/find-qa?include_parent=true` trả `parent`.
- `view-qa` hiển thị parent document và child atoms.
- Document không được retrieve trực tiếp; chỉ fetch khi có flag.

### Kiểm chứng

- Ingest 2 atom trong transaction → parent document tạo đúng.
- `attachParents` trả parent body; `parent_id` string được normalize.
- Unit test stub + BigInt string case.

---

## 5. ANN 50k benchmark

Script: `tools/benchmark-ann-50k.js` (tạo bảng tạm 50k vector 1024d, HNSW + GIN, đo, drop).

| Kịch bản | p50 | p95 |
| :--- | ---: | ---: |
| 50k, planner mặc định (Seq Scan) | **521,94 ms** | 558,31 ms |
| 50k, force index (HNSW) | **56,77 ms** | 63,69 ms |
| 3.4k global, production force-index | **8,04 ms** | 19,52 ms |
| 3.4k ERP, production force-index | **49,15 ms** | 86,35 ms |

- pgvector cost model chọn Seq Scan ở 50k dù HNSW thực tế ~2 ms cho ANN.
- Đã thêm `core/retrieval-db.js`:
  - `SET LOCAL enable_seqscan=off` trong transaction retrieval.
  - bật mặc định qua `RETRIEVAL_FORCE_INDEX=true`.
- Mọi caller retrieval dùng `queryRetrieval`: `find-qa-context`, `find-qa`, `find-qa-deep`, server, baseline.
- 50k synthetic dùng vector random; FTS query cố tình không match để đo ANN riêng.

---

## 6. Kiểm chứng

| Gate | Kết quả |
| :--- | :--- |
| `npm test` | **27/27 pass** |
| `npm run verify:phase0` | 31/31 pass |
| `npm run verify:phase1` | 27/27 pass |
| `npm run verify:phase2` | 28/28 pass |
| `npm run verify:phase3` | 15/15 pass |
| `curate --mark-stale` trên row test | `status='stale'` đúng |
| `promote-trust` | observation → verified_fact đúng |
| Parent document | fetch đúng trong transaction |
| 50k benchmark | forced HNSW p50 56,77 ms |

---

## 7. Rủi ro còn lại

| Rủi ro | Mức | Xử lý |
| :--- | :--- | :--- |
| Force `enable_seqscan=off` có thể chậm với bảng nhỏ/filter rộng | Trung bình | Có flag `RETRIEVAL_FORCE_INDEX=false`; đo lại theo dữ liệu thật |
| 50k synthetic random không đại diện dữ liệu thật | Trung bình | Benchmark trên snapshot thật khi có 50k |
| 2.871 observation chưa promote | Trung bình | Dùng `trust:promote` theo review |
| Curate chưa chạy theo lịch | Trung bình | Cron/Task Scheduler |
| Parent fetch giới hạn 2000 ký tự | Thấp | `maxChars` configurable trong helper |
| Status `stale` chưa có job archive | Thấp | Phase 4 retention |

---

## 8. Việc tiếp theo

1. Chạy curate/qa-health theo lịch; set `status='archived'` cho stale >180d.
2. Review/promote trust theo batch.
3. Context budget + citation (Phase 4).
4. Benchmark trên snapshot thật; quyết định force-index mặc định.

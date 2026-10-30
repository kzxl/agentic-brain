# Semantic Brain — Documentation

Bộ tài liệu được gom theo mục đích. Bắt đầu từ đây.

## Đọc gì trước

| Nếu bạn cần | Đọc |
| :--- | :--- |
| Biết việc gì còn phải làm | [next-steps.md](next-steps.md) |
| Hiểu hiện trạng và số liệu đo | [architecture/audit/current-state-audit.md](architecture/audit/current-state-audit.md) |
| Hiểu thiết kế memory | [architecture/design/memory-system.md](architecture/design/memory-system.md) |
| Hiểu hybrid reasoning | [architecture/design/hybrid-reasoning.md](architecture/design/hybrid-reasoning.md) |
| Xem kiến trúc đích | [architecture/design/target-architecture.md](architecture/design/target-architecture.md) |
| Xem lộ trình và cách sửa | [architecture/roadmap/implementation-roadmap.md](architecture/roadmap/implementation-roadmap.md), [architecture/roadmap/remediation-plan.md](architecture/roadmap/remediation-plan.md) |
| Xem đã triển khai gì | [architecture/results/](architecture/results/) |
| So sánh latency | [architecture/baselines/](architecture/baselines/) |

## Cấu trúc

```
docs/
  README.md
  next-steps.md
  architecture/
    README.md
    audit/current-state-audit.md
    design/{memory-system,hybrid-reasoning,target-architecture}.md
    roadmap/{implementation-roadmap,remediation-plan}.md
    results/phase0-results.md .. phase3-results.md
    baselines/{baseline,baseline-erp,baseline-ann-50000}.json
```

## Trạng thái hiện tại

- Phase 0–3 đã triển khai.
- `npm test`: 27/27.
- Verify Phase 0/1/2/3: 31/27/28/15.
- Fresh install: 11 migration pass.
- 3.411 bản ghi; 18 project; `status` hiện toàn `active`.
- Retrieval: global ~8 ms, ERP ~49 ms; 50k forced HNSW ~57 ms.

Các việc còn lại, thứ tự ưu tiên và tiêu chí nghiệm thu nằm trong [next-steps.md](next-steps.md).

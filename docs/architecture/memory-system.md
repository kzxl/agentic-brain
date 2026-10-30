# Semantic Brain — Thiết kế hệ thống Memory đa tầng

Tài liệu này đánh giá 5 loại memory theo yêu cầu, ánh xạ chúng vào hiện trạng, rồi đề xuất thiết kế đích. Nguyên tắc xuyên suốt: **không tạo module riêng cho từng loại memory nếu chúng chia sẻ cùng vòng đời retrieval/provenance**. Chỉ Working Memory và Procedural Memory có lý do tách; Project Memory là **scope**, không phải store.

---

## 1. Kết luận thiết kế trong một trang

| Loại memory | Hiện trạng | Quyết định kiến trúc | Lý do |
| :--- | :--- | :--- | :--- |
| Working Memory | **Không có** | **Module riêng**, bảng `memory_session` + checkpoint, TTL 24–72h | Dữ liệu tạm, không cần embedding, vòng đời ngắn, truy cập theo task |
| Episodic Memory | Có, nhưng là Q/A phẳng | **Logical layer** trên `memory_item` (`memory_type='episodic'`) | Cùng retrieval, cùng provenance, cùng lifecycle với semantic |
| Semantic Memory | Gần như không có (tag `pinned`, 0 dòng) | **Logical layer** trên `memory_item` (`memory_type='semantic'`) | Cần cùng index/edge/lifecycle; khác biệt nằm ở trust và validation |
| Procedural Memory | `agent_recipes` (8 dòng, 0 success) | **Bảng riêng**, chuẩn hóa provenance/project/version | Query theo intent + success rate; payload là các bước có precondition/postcondition |
| Project Memory | Tag `project:*`, OR filter | **Cột `project_id` + `scope`**, không phải store | Là partition bảo mật, phải enforce ở repository layer |

**Một câu:** dùng **một bảng `memory_item` cho episodic + semantic**, **một bảng `memory_session` cho working**, **một bảng `agent_recipes` nâng cấp cho procedural**, và **một cột `project_id` xuyên suốt** — không tạo 5 store riêng.

---

## 2. Đánh giá từng loại memory

### 2.1. Working Memory

**Hiện trạng:** không tồn tại. Không có session, task, hypothesis, checkpoint, hay trạng thái thực hiện. Agent phải giữ tất cả trong context window; khi context bị cắt, mất trạng thái. `storage-ame.js` có tier `Episodic` mặc định nhưng không có Working Frame; AME docs mô tả WorkingFrame nhưng Semantic Brain không gọi.

**Vấn đề cần giải quyết:**
- Task hiện tại, mục tiêu, sub-goal.
- Giả thuyết đang kiểm tra và bằng chứng đã thu thập.
- Thông tin đã truy xuất (ID) và thông tin còn thiếu.
- Quyết định tạm thời, file đã chạm, diff chưa commit.
- Kết quả tạm thời / lỗi đã gặp.

**Thiết kế:**

```sql
CREATE TABLE memory_session (
  id              UUID PRIMARY KEY,
  project_id      TEXT NOT NULL,
  task_goal       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',  -- active|blocked|done|abandoned
  state           JSONB NOT NULL DEFAULT '{}',      -- hypotheses, open_questions, decisions
  retrieved_ids   BIGINT[] DEFAULT '{}',
  touched_files   TEXT[] DEFAULT '{}',
  evidence        JSONB DEFAULT '[]',              -- command output, errors, links
  parent_id       UUID REFERENCES memory_session(id),
  checkpoint_of   UUID REFERENCES memory_session(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_session_project ON memory_session(project_id, status, expires_at);
```

**Quy tắc:**
- Không embedding, không đưa vào retrieval ngữ nghĩa.
- TTL mặc định 48h; checkpoint khi agent chuyển nhánh giả thuyết; rollback = trỏ về checkpoint.
- Khi session `done`, chạy **promotion**: tạo một `memory_item` episodic với outcome, root cause, fix, evidence; đóng session.
- Khi `abandoned`, chỉ giữ summary ngắn (tránh rác).
- API: `POST /session`, `PATCH /session/:id`, `POST /session/:id/checkpoint`, `POST /session/:id/promote`.

**Không nên:** lưu Working Memory vào vector DB; biến nó thành kho vĩnh viễn.

### 2.2. Episodic Memory

**Hiện trạng:** `agent_qa_cache` lưu cặp Q/A + source + confidence + hit_count + tags. Đây là **episodic phẳng**: có sự kiện nhưng thiếu task, outcome, thời gian hiệu lực, evidence, và quan hệ nhân quả. 83,9% đến từ `agent-direct`, tức agent tự viết kết luận, không có cấu trúc episode.

**Vấn đề cần giải quyết:**
- Agent đã làm gì, gặp lỗi gì, thử gì, thành/bại, vì sao.
- Truy xuất theo thời gian, project, task, subject, outcome.
- Phân biệt "đã xảy ra" với "đúng".

**Thiết kế:** dùng `memory_item` với `memory_type='episodic'`; các trường đặc thù nằm trong `payload`:

```json
{
  "task_id": "uuid",
  "symptom": "...",
  "root_cause": "...",
  "fix": "...",
  "outcome": "success|failure|partial",
  "error_signature": "CS1503|deadlock|...",
  "steps": [{"action": "...", "result": "..."}],
  "evidence": [{"type": "test|build|log|commit", "ref": "..."}],
  "files": ["..."],
  "invariants": ["..."]
}
```

**Truy xuất:** mặc định theo `project_id`, `status='active'`, `memory_type='episodic'`; có thể filter `outcome`, `error_signature`, `created_at`. Episode thất bại vẫn giữ (giá trị âm), nhưng rank thấp hơn và gắn nhãn `outcome=failure`.

### 2.3. Semantic Memory

**Hiện trạng:** gần như không có. `pinned` là tag duy nhất đại diện cho "invariant", nhưng **0 bản ghi**. `source='seed'`/`'teach'` (93 bản ghi) là gần nhất với semantic, nhưng không có trường `verified`, `valid_from`, `scope`. Không có khái niệm "tri thức nền" vs "tri thức dự án".

**Vấn đề cần giải quyết:**
- Tri thức đã tổng hợp, đã kiểm chứng, có phạm vi.
- Phân biệt nền tảng (global) và đặc thù dự án (project).
- Không bị ghi đè bởi suy luận model.

**Thiết kế:** `memory_item` với `memory_type='semantic'`:

```json
{
  "statement": "Service layer sở hữu business rule; View không chứa SQL.",
  "conditions": ["UA v4.0", "WinForms"],
  "scope": "project|global",
  "counterexamples": ["..."],
  "derived_from": ["episodic_id", "..."],
  "verified_by": "user|test|compile|schema",
  "valid_from": "2026-10-30",
  "valid_to": null
}
```

**Quy tắc promotion:**
- Chỉ promote từ episodic khi: (a) lặp lại ≥2 lần với outcome success, hoặc (b) có test/compile evidence, hoặc (c) user xác nhận.
- Semantic toàn cục (`scope='global'`) chỉ được tạo bởi user decision hoặc review có chủ đích; agent không tự promote cross-project.
- Semantic có `valid_to` khi bị thay thế; không xóa.

### 2.4. Procedural Memory

**Hiện trạng:** `agent_recipes` có schema tốt (intent, steps JSONB, skills_used, tools_used, hit/success). Nhưng chỉ 8 bản ghi, 34 hit, **0 success**; `find-recipe` chỉ được `claude-integration.js` gọi, không nằm trong `context-fetch`. `mark-recipe` không được gọi trong thực tế.

**Vấn đề cần giải quyết:**
- Quy trình đã chứng minh hiệu quả, có precondition/postcondition.
- Đo success rate thật, không chỉ hit.
- Versioning khi quy trình đổi.

**Thiết kế:** giữ bảng riêng, bổ sung:

```sql
ALTER TABLE agent_recipes
  ADD COLUMN project_id TEXT,
  ADD COLUMN scope TEXT DEFAULT 'project',
  ADD COLUMN preconditions JSONB DEFAULT '[]',
  ADD COLUMN postconditions JSONB DEFAULT '[]',
  ADD COLUMN version INT DEFAULT 1,
  ADD COLUMN status TEXT DEFAULT 'active',        -- draft|active|stale|retired
  ADD COLUMN trust_level TEXT DEFAULT 'verified_fact',
  ADD COLUMN embedding_model TEXT,
  ADD COLUMN failure_count INT DEFAULT 0,
  ADD COLUMN last_success_at TIMESTAMPTZ;
```

(`success_count` đã tồn tại; không thêm lại.)

**Quy tắc:**
- Recipe chỉ `active` khi có ≥2 success và 0 failure nghiêm trọng; nếu failure_rate > 0.5 sau ≥2 lần → `stale`.
- `find-recipe` phải được gọi trong `context-fetch` **trước** QA retrieval (recipe rẻ hơn và cụ thể hơn).
- Mỗi recipe phải có `project_id`; global recipe chỉ khi user promote.
- Bắt buộc `mark-recipe(success|failure)` ở cuối workflow; nếu không, success rate vô nghĩa.

### 2.5. Project Memory

**Hiện trạng:** chỉ là tag `project:*`; 81,6% là `project:erp`. Query dùng `tags && $2` (OR), nên một task thuộc project A vẫn nhận bản ghi project B nếu chia sẻ tag công nghệ. Không có `project_id` cột, không có foreign key, không có kiểm soát scope.

**Thiết kế:** Project Memory là **partition logic**:
- `memory_item.project_id TEXT NOT NULL`, `scope TEXT CHECK (scope IN ('project','global'))`.
- `project` table: `id`, `name`, `root_path`, `created_at`, `archived_at`.
- Mọi query bắt buộc: `(project_id = $current OR scope = 'global')`.
- Cross-project chỉ qua API có tham số `cross_project=true` + quyền; mặc định từ chối.
- Global chỉ chứa tri thức nền đã verify; không chứa episode của một dự án.
- AME: nếu vẫn dùng, phải tách file `.ame` theo project hoặc thêm filter server-side; post-filter hiện tại không đủ vì topK có thể bị lấp đầy bởi project khác.

**Ví dụ lỗi hiện tại:** task "Architecture audit Semantic Brain" (project `semanticbrain`) trả về bản ghi `project:erp` vì filter OR khớp `pattern:architecture`. Đây là vi phạm project isolation, không phải "gợi ý tham khảo".

---

## 3. Mô hình dữ liệu đích

### 3.1. `memory_item` (episodic + semantic)

```sql
CREATE TABLE memory_item (
  id                BIGSERIAL PRIMARY KEY,
  project_id        TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'project'
                    CHECK (scope IN ('project','global')),
  memory_type       TEXT NOT NULL
                    CHECK (memory_type IN ('episodic','semantic')),
  title             TEXT NOT NULL,
  content           TEXT NOT NULL,
  payload           JSONB NOT NULL DEFAULT '{}',

  -- Retrieval
  search_text       TEXT NOT NULL DEFAULT '',
  embedding         VECTOR(1024),
  embedding_model   TEXT NOT NULL,          -- 'bge-m3'
  embedding_dims    INT NOT NULL DEFAULT 1024,
  keywords          TEXT[] DEFAULT '{}',
  tags              TEXT[] DEFAULT '{}',

  -- Trust & provenance
  trust_level       TEXT NOT NULL DEFAULT 'observation'
                    CHECK (trust_level IN
                      ('observation','hypothesis','inference','verified_fact','user_decision')),
  confidence        REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  source_type       TEXT NOT NULL,          -- agent|proxy|import|seed|user|test|compile
  source_ref        TEXT,                   -- session id, commit, file, URL
  created_by        TEXT,                   -- agent id / user id
  verifier          TEXT,
  verified_at       TIMESTAMPTZ,

  -- Lifecycle
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('captured','active','stale','archived','superseded')),
  content_hash      TEXT NOT NULL,
  supersedes_id     BIGINT REFERENCES memory_item(id),
  valid_from        TIMESTAMPTZ DEFAULT NOW(),
  valid_to          TIMESTAMPTZ,

  -- Signals (updated on use, not on retrieval)
  use_count         INT NOT NULL DEFAULT 0,
  retrieval_count   INT NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMPTZ,
  importance        SMALLINT NOT NULL DEFAULT 50,   -- 1..100
  decay_rate        SMALLINT NOT NULL DEFAULT 128,  -- 0 = never decay
  schema_version    INT NOT NULL DEFAULT 1,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_item_scope_hash
  ON memory_item(project_id, memory_type, content_hash);
CREATE INDEX ix_item_project_status
  ON memory_item(project_id, status, memory_type);
CREATE INDEX ix_item_tags ON memory_item USING GIN(tags);
CREATE INDEX ix_item_keywords ON memory_item USING GIN(keywords);
CREATE INDEX ix_item_embedding ON memory_item
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX ix_item_fts ON memory_item
  USING GIN (to_tsvector('simple', search_text));
```

**Vì sao một bảng:** episodic và semantic dùng chung retrieval, provenance, lifecycle, edge, project isolation. Tách bảng sẽ nhân đôi index, query union, và tạo hai nguồn lệch. Khác biệt chỉ là **validation rule** và **payload schema**, xử lý ở tầng domain.

### 3.2. `memory_edge`

```sql
CREATE TABLE memory_edge (
  id          BIGSERIAL PRIMARY KEY,
  from_id     BIGINT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
  to_id       BIGINT NOT NULL REFERENCES memory_item(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL CHECK (relation IN
              ('references','supersedes','contradicts','derived_from','applies_to','same_task')),
  weight      REAL NOT NULL DEFAULT 1.0,
  confidence  REAL NOT NULL DEFAULT 1.0,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(from_id, to_id, relation)
);
CREATE INDEX ix_edge_from ON memory_edge(from_id, relation);
CREATE INDEX ix_edge_to ON memory_edge(to_id, relation);
```

### 3.3. `memory_event` (append-only audit)

```sql
CREATE TABLE memory_event (
  id          BIGSERIAL PRIMARY KEY,
  item_id     BIGINT REFERENCES memory_item(id) ON DELETE SET NULL,
  event_type  TEXT NOT NULL,   -- created|updated|verified|merged|conflict|archived|promoted
  actor       TEXT NOT NULL,
  reason      TEXT,
  before_hash TEXT,
  after_hash  TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.4. `memory_conflict`

```sql
CREATE TABLE memory_conflict (
  id           BIGSERIAL PRIMARY KEY,
  item_a       BIGINT NOT NULL REFERENCES memory_item(id),
  item_b       BIGINT NOT NULL REFERENCES memory_item(id),
  conflict_type TEXT NOT NULL,   -- factual|temporal|scope|version
  severity     TEXT NOT NULL DEFAULT 'medium',
  status       TEXT NOT NULL DEFAULT 'open',  -- open|resolved|dismissed
  resolution   TEXT,
  resolved_by  TEXT,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.5. Quan hệ với bảng hiện tại

- Giai đoạn 1: giữ tên `agent_qa_cache`, thêm cột và backfill; tạo **view** `memory_item` để code mới đọc.
- Giai đoạn 2: chuyển ghi sang `memory_item`; `agent_qa_cache` thành view tương thích cho CLI cũ.
- Không drop bảng cũ cho đến khi tất cả tool đã chuyển và có backup.

---

## 4. Vòng đời tri thức

```
Capture → Normalize → Classify → Validate → Store → Retrieve → Reevaluate → Consolidate
```

| Bước | Đầu vào | Xử lý | Đầu ra | Ai được ghi |
| :--- | :--- | :--- | :--- | :--- |
| Capture | session, post-task, proxy, import | tạo bản ghi thô trust thấp | `status='captured'` | mọi producer |
| Normalize | text | trim, chuẩn hóa thuật ngữ, tách symptom/cause/fix | `search_text`, `content_hash` | hệ thống |
| Classify | nội dung | `memory_type`, tags, domain, project | metadata | rule + local model |
| Validate | item | regex quality guard + evidence + conflict check | `trust_level`, `status` | validator |
| Store | item | dedup/merge nếu trùng | `active` hoặc `superseded` | KnowledgeWriter |
| Retrieve | query | ANN + filter + rank + rerank | context | read-only |
| Reevaluate | usage/feedback | tăng `use_count`, decay, review | status/confidence | job + user |
| Consolidate | cluster | merge, tạo edge, archive | canonical item | job + review |

### 4.1. State machine

```
captured ──validate_ok──> active ──unused_60d──> stale ──unused_180d──> archived
    │                       │  ^                    │
    │                       │  └──used──────────────┘
    │                       ├──tạo memory_conflict (open)
    │                       └──replaced──────> superseded
    └──validate_fail──> không lưu (hoặc archived nếu cần audit)
```

- `stale` không bị xóa; chỉ giảm rank và gắn nhãn.
- `archived` vẫn truy xuất được nếu explicit `include_archived=true` (cho audit).
- `superseded` giữ `supersedes_id` và edge để tra cứu lịch sử.

### 4.2. Provenance bắt buộc

Mỗi item quan trọng phải có:

| Trường | Ví dụ | Bắt buộc |
| :--- | :--- | :--- |
| `source_type` | `agent`, `proxy`, `test`, `compile`, `user`, `import` | Có |
| `source_ref` | session UUID, commit hash, file:line, URL | Có nếu có |
| `created_by` | agent id / user id | Có |
| `verifier` | `dotnet build`, `pytest`, `user:phong` | Có nếu `verified_fact` |
| `verified_at` | timestamp | Có nếu `verified_fact` |
| `valid_from/to` | timestamp | Semantic bắt buộc `valid_from` |
| `confidence` | 0..1 | Có |
| `trust_level` | 5 mức | Có |
| `schema_version` | 1 | Có |
| `embedding_model` | `bge-m3` | Có |

### 4.3. Trust levels và quyền ghi

| Trust level | Được tạo bởi | Được retrieve mặc định | Được ghi đè bởi model | Ghi chú |
| :--- | :--- | :--- | :--- | :--- |
| `observation` | agent, proxy, import | Có, rank thấp | Không | "Đã thấy X" |
| `hypothesis` | agent | Có, gắn nhãn | Không | "Có thể do Y" |
| `inference` | LLM | Có, gắn nhãn | Không | "Suy ra Z" |
| `verified_fact` | test/compile/schema/user | Có, rank cao | Không | Có evidence |
| `user_decision` | user | Có, rank cao nhất | **Tuyệt đối không** | Quyết định con người |

**Quy tắc cứng:**
- Proxy/LLM output chỉ được `observation` hoặc `inference`.
- `auto-qa` (sinh câu trả lời khi MISS) chỉ được `inference`, confidence ≤0.5; hiện tại nó lưu 1.0 qua `save-qa` mặc định (`tools/auto-qa.js:25`).
- `server /save-qa` hiện set confidence 1.0 khi update — phải bỏ; chỉ user hoặc verifier mới được nâng.
- `user_decision` không bao giờ bị update bởi agent; nếu mâu thuẫn, tạo conflict và yêu cầu user.
- `verified_fact` phải có `verifier` + `evidence`; nếu thiếu, hạ về `inference`.

### 4.4. Dedup và consolidation

**Khi ghi:**
1. Exact hash (`content_hash`) trong cùng `project_id` + `memory_type`.
2. Near-duplicate: cosine ≥0.92 trong cùng project/type, cùng `statement` hoặc cùng symptom.
3. Nếu trùng:
   - Nếu item mới có trust cao hơn: tạo version mới, `supersedes_id`, archive item cũ, giữ history.
   - Nếu trust thấp hơn: chỉ tăng `use_count`/merge tags, không ghi đè nội dung.
   - Nếu mâu thuẫn: tạo `memory_conflict`, không tự chọn.
4. Không merge cross-project; không merge `user_decision`; không merge khi `valid_to` khác nhau.

**Định kỳ (nightly/offline):**
- Cluster theo project/type + cosine ≥0.92.
- Sinh đề xuất merge (canonical = trust cao nhất, verified mới nhất, use_count cao nhất).
- LLM chỉ **đề xuất**; rule engine quyết định; item không chắc chắn → review queue.
- Ghi `memory_event` cho mọi merge.

### 4.5. Conflict detection

- Ứng viên: cùng project + cùng type + cosine ≥0.85.
- Phân loại:
  - **factual:** hai statement phủ định nhau (LLM classifier + evidence).
  - **temporal:** cùng chủ đề, `valid_from` khác, nội dung thay đổi.
  - **scope:** một global, một project; project thắng trong project.
  - **version:** cùng quy trình nhưng steps khác.
- Hành động: tạo `memory_conflict`, gắn edge `contradicts`, chặn auto-merge, trả cảnh báo trong context.
- Không tự động xóa bên thua.

### 4.6. Quên và lưu trữ

- Không xóa cứng dữ liệu đã verify; chỉ `archived`.
- Episodic không dùng 180 ngày → `archived`; vẫn restore được.
- `agent_qa_history`/`memory_event` giữ vĩnh viễn (nhỏ).
- Export định kỳ (JSONL + SQL dump) và kiểm tra restore.

---

## 5. Retrieval theo loại memory

| Loại | Query đặc thù | Signal |
| :--- | :--- | :--- |
| Working | `session_id` | Không vector; đọc state/checkpoint |
| Episodic | task/symptom/error/outcome/time | vector + FTS + project + recency + outcome |
| Semantic | statement/condition/scope | vector + trust + validity + project/global |
| Procedural | intent + preconditions | vector + keyword + success_rate + project |
| Project | mọi query | predicate bắt buộc `project_id`/`scope` |

**Công thức ranking đề xuất (thay RRF hiện tại):**

```
score = 0.45 * vector_sim
      + 0.20 * bm25_or_fts_norm
      + 0.10 * trust_weight
      + 0.10 * recency_decay
      + 0.08 * use_signal
      + 0.07 * project_affinity
```

- `trust_weight`: user_decision 1.0, verified_fact 0.9, inference 0.5, hypothesis 0.4, observation 0.3.
- `recency_decay`: episodic mạnh, semantic gần như không, procedural theo `last_success_at`.
- `use_signal`: `log1p(use_count)`; **không** dùng `retrieval_count` để tránh self-reinforcement.
- `project_affinity`: 1.0 nếu cùng project, 0.6 nếu global, 0 nếu khác project (bị loại trước đó).
- RRF vẫn có thể dùng để fusion vector/FTS, nhưng phải **ANN-first**.

---

## 6. Migration từ hiện trạng

### 6.1. Backfill

```sql
-- 1. Thêm cột nullable
ALTER TABLE agent_qa_cache ADD COLUMN project_id TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN scope TEXT DEFAULT 'project';
ALTER TABLE agent_qa_cache ADD COLUMN memory_type TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN trust_level TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN source_type TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN source_ref TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN content_hash TEXT;
ALTER TABLE agent_qa_cache ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE agent_qa_cache ADD COLUMN use_count INT DEFAULT 0;
ALTER TABLE agent_qa_cache ADD COLUMN retrieval_count INT DEFAULT 0;
ALTER TABLE agent_qa_cache ADD COLUMN last_used_at TIMESTAMPTZ;
ALTER TABLE agent_qa_cache ADD COLUMN embedding_model TEXT DEFAULT 'bge-m3';
```

- `project_id`: lấy tag `project:*`; nếu không có → `global` (đánh dấu review).
- `memory_type`: `seed`/`teach`/`reviewed-*` → `semantic`; còn lại → `episodic`.
- `trust_level`: `seed`/`teach`/`manual`/`reviewed-*` → `verified_fact` (cần review lại); `agent-direct` → `observation`; `auto-harvest`/proxy → `inference`.
- `content_hash`: `md5(lower(normalize(question || answer)))`.
- `use_count`: giữ `hit_count` cũ nhưng đổi ngữ nghĩa; `retrieval_count` = `hit_count` hiện tại; reset `use_count=0` và chỉ tăng khi có feedback.

### 6.2. Cutover

1. Tạo bảng/view mới, backfill, kiểm tra đếm.
2. Chuyển đọc sang repository mới; so sánh kết quả với query cũ trên 100 query mẫu.
3. Chuyển ghi sang `KnowledgeWriter` duy nhất; tắt ghi AME (feature flag `AME_WRITE=false`).
4. Giữ `agent_qa_cache` làm view tương thích; sau 1 chu kỳ mới rename.
5. Rollback: giữ snapshot trước migration; migration idempotent.

### 6.3. AME

- **Không** tiếp tục dual-write.
- Xuất AME một lần sang `data/ame_export.jsonl` để đối soát.
- Nếu muốn giữ AME như backend thử nghiệm: tách file theo project, dùng cùng embedder BGE-M3 (hoặc chấp nhận read-only với nhãn "experimental"), và không trả kết quả lẫn với PG.
- AME hiện tại (MiniLM 384) không đủ chất lượng cho kho tiếng Việt; không nên là backend mặc định.

---

## 7. Test cases bắt buộc

| ID | Kịch bản | Kỳ vọng |
| :--- | :--- | :--- |
| MS-01 | Tạo session, thêm hypothesis, checkpoint, rollback | State khôi phục đúng; không ảnh hưởng memory dài hạn |
| MS-02 | Session done → promote | Tạo đúng 1 episodic item, có evidence/outcome |
| MS-03 | Ghi proxy output | Chỉ `observation`, confidence ≤0.6, không vào default semantic |
| MS-04 | Ghi user decision | `user_decision`, không thể update bởi agent |
| MS-05 | Ghi trùng exact hash | Không tạo bản ghi mới; tăng use_count đúng |
| MS-06 | Ghi gần trùng ≥0.92 | Merge/version đúng; history đủ |
| MS-07 | Ghi mâu thuẫn với verified_fact | Tạo conflict; không overwrite |
| MS-08 | Query project A | Không trả item project B (trừ global) |
| MS-09 | Query global | Chỉ trả `scope='global'` đã verify |
| MS-10 | Promote episodic → semantic | Chỉ khi đủ điều kiện; có `verified_by` |
| MS-11 | Item stale 60 ngày | Bị giảm rank/gắn stale, không bị xóa |
| MS-12 | Item archived | Không xuất hiện mặc định; explicit thì có |
| MS-13 | Recipe fail 2 lần | Chuyển `stale`, không được recommend |
| MS-14 | Consolidation job | Không merge cross-project; event đầy đủ |
| MS-15 | Restore từ export | Số bản ghi và embedding khớp |

---

## 8. Những gì không làm

- Không tạo 5 microservice/bảng riêng cho 5 loại memory.
- Không đưa Working Memory vào vector index.
- Không tự động biến output LLM thành `verified_fact`.
- Không merge tri thức khác project.
- Không thêm graph database bên ngoài khi `memory_edge` trong PostgreSQL đủ cho nhu cầu hiện tại (16 node, 0 edge là bằng chứng nhu cầu graph thật chưa tồn tại).
- Không thay PostgreSQL bằng AME khi AME chưa có cùng embedder/provenance/project isolation.

# Boxwire diagram format, v1

Boxwire (https://gitreset.dev/products/boxwire) is a browser whiteboard for system design, UML and ER diagrams. This guide is for LLMs and agents: it describes a small JSON format you can write directly, without driving the browser. The user opens or pastes your file and gets exactly the diagram you described.

- JSON Schema: https://gitreset.dev/products/boxwire/schema.json. It's the strict check for a single file: it rejects unknown fields (which Boxwire itself only warns about and ignores) and everything that's wrong within one object. Boxwire additionally checks what a schema can't: that references point at real ids, ids are unique, content fits after sizing, and the element total stays within limits.
- Examples: https://gitreset.dev/products/boxwire/examples/system-architecture.boxwire-diagram.json, `uml-class-diagram`, `er-schema` and `annotated-manual` (same folder, same suffix).
- Twelve interview reference designs, each with capacity declarations and presentation frames, in the same folder: `url-shortener`, `news-feed`, `chat`, `rate-limiter`, `notifications`, `web-crawler`, `typeahead`, `ride-hailing`, `video-streaming`, `payments`, `ticket-booking`, `file-sync`.
- Boxwire reviews what a diagram declares: architecture lint, capacity propagation and a practice rubric (see [Review](#review)). To critique a user's board, ask them for its critique bundle and answer with a [patch](#agent-patches).

## How the user brings it in

1. Save your output as a file ending in `.boxwire-diagram.json` (any `.json` works).
2. In Boxwire, open the Boards menu (the chevron beside the board name) and choose **Open file (board or AI diagram)…**. The diagram opens as a new board, so nothing the user already has is replaced.
3. Alternatively, the user can copy your JSON and paste it onto an open board with ⌘V / Ctrl+V. It's placed beside whatever is already on the board, as one undoable step.

If anything is wrong, Boxwire shows a list of problems with JSON paths (for example `nodes[3].kind: unknown kind "servce". Did you mean "service"?`) and a **Copy problems** button. When the user pastes that list back to you, fix exactly those paths. A file with any error imports nothing; warnings mean the named fields were ignored.

## Rules that matter most

- Output a single JSON object. Boxwire also reads `//` and `/* */` comments and trailing commas (the source files reviewed in [Change review](#change-review) keep them), but plain JSON is the safest answer.
- `"format": "boxwire-diagram"` and `"version": 1` are required.
- Every node needs a unique `id` and a `kind` from the tables below. The kind decides the shape, icon, colour and default label. Label text never changes meaning: a box labelled "Kafka" is still a box, so use `"kind": "event-stream"` for Kafka.
- Ids start with a letter and may contain letters, digits, `_` and `-` (at most 48 characters). They're shared by nodes, zones, edges and strokes. Reserved JavaScript names like `constructor` or `__proto__` are rejected.
- Prefer `"layout": "auto"` (the default) and **don't** give coordinates; Boxwire lays the diagram out. Use `"layout": "manual"` only when exact placement matters, and then every node needs `x` and `y`.
- Edges reference node (or zone) ids. Self-loops aren't supported.
- Unknown fields are ignored with a warning (the schema rejects them); unknown values are errors.

## Minimal example

```json
{
  "format": "boxwire-diagram",
  "version": 1,
  "name": "Checkout",
  "nodes": [
    { "id": "web", "kind": "web-client", "label": "Storefront" },
    { "id": "api", "kind": "service", "label": "Checkout API" },
    { "id": "db", "kind": "sql-database", "label": "Orders DB" },
    { "id": "events", "kind": "event-stream", "label": "order.placed" }
  ],
  "edges": [
    { "from": "web", "to": "api", "label": "POST /checkout" },
    { "from": "api", "to": "db" },
    { "from": "api", "to": "events", "kind": "async" }
  ]
}
```

## Top level

| Field | Type | Notes |
| --- | --- | --- |
| `format` | `"boxwire-diagram"` | Required. |
| `version` | `1` | Required. |
| `name` | string | Board name, at most 120 characters. Default "Untitled diagram". |
| `layout` | `"auto"` \| `"manual"` | Default `"auto"`. |
| `direction` | `"LR"` \| `"TB"` | Auto layout only: left-to-right (default) or top-to-bottom. Use `"TB"` for class hierarchies. |
| `nodes` | array | Required: at least one node, at most 1500. |
| `zones` | array | Labelled boundaries drawn around nodes (regions, VPCs, packages). At most 200. |
| `edges` | array | Connectors, at most 3000. |
| `strokes` | array | Freehand marks; manual layout only. At most 500. |
| `frames` | array | Presentation slides, in order; see [Frames](#frames). At most 100. |
| `positions` | object | Layout kept apart from the model: `{ "<nodeId>": { "x", "y", "w"?, "h"? } }`. In auto layout these nodes are pinned and the rest are laid out; in manual layout an entry replaces the node's own x/y. Canvas drags write here, so a move never touches the node's definition. |

The whole diagram may contain at most 5000 elements, and the file may be at most 5 MB.

## Nodes

| Field | Applies to | Notes |
| --- | --- | --- |
| `id` | all | Required. |
| `kind` | all | Required; see the tables below. |
| `label` | all except UML and `table` | Text on the node, at most 2000 characters. If omitted, the kind's default label is used. Required for `text`. Use `\n` for line breaks. |
| `x`, `y` | all, manual layout only | Top-left corner in pixels; x grows right, y grows down. |
| `w`, `h` | all | Optional size, 16–4000. Height grows to fit the label; UML and tables size to their content. |
| `rank` | all, auto layout only | Layout hint: the earliest column (`LR`) or row (`TB`) the node may take, a whole number from 0 (the first). Use it for a node nothing points at, such as a batch job or a scheduler, which would otherwise sit in the first column beside the clients. Nodes after it still follow the edges; empty columns close up. A hinted node with no edges joins the flow. Ignored, with a warning, in manual layout. |
| `color` | all | `ink`, `slate`, `red`, `orange`, `amber`, `green`, `teal`, `blue`, `violet`, `pink`. |
| `fill` | all | `paper` (opaque background), `tint`, `solid`, `none`. Each kind has its own default (most use `paper`; `note` uses `tint`; `user` and `text` use `none`). |
| `dash` | all | Outline: `solid`, `dashed`, `dotted`. |
| `crossed` | all | `true` draws a red cross: an option that was considered and rejected. |
| `textSize` | all | `s`, `m` (default), `l`, `xl`. |
| `font` | all | `sans` or `mono`. |
| `align` | all | `left`, `center`, `right`. |
| `icon` | component kinds | Replaces the kind's icon; see the icon list. |
| `capacity` | architecture kinds | Declared load, ratings and topology, read by the review; see [Capacity](#capacity). |
| `meta` | all | Declared metadata for rules: `{ "owner": "payments-team", "data": "pii" }`. At most 16 keys matching `^[a-z][a-zA-Z0-9_-]{0,31}$`; values are strings of at most 120 characters. |

Colours are tokens, not hex values. They follow each viewer's light or dark theme, so a diagram can't choose a theme (a top-level `theme` field is ignored with a warning).

### Architecture kinds

Defaults are what you get without overriding `label` or `color`.

| Kind | Shape | Default label | Colour |
| --- | --- | --- | --- |
| `web-client` | card with monitor icon | Web client | ink |
| `mobile-app` | card with phone icon | Mobile app | ink |
| `user` | stick figure (label underneath) | User | ink |
| `dns` | card with globe icon | DNS | teal |
| `cdn` | card with earth icon | CDN | teal |
| `load-balancer` | card with split icon | Load balancer | violet |
| `api-gateway` | card with door icon | API gateway | violet |
| `rate-limiter` | card with gauge icon | Rate limiter | orange |
| `auth-service` | card with key icon | Auth service | amber |
| `service` | card with server icon | Service | blue |
| `worker` | card with cpu icon | Worker | blue |
| `serverless-function` | card with zap icon | Serverless fn | orange |
| `scheduler` | card with clock icon | Scheduler | slate |
| `llm-inference` | card with sparkles icon | LLM inference | violet |
| `agent` | card with bot icon | Agent | violet |
| `container` | card with container icon | Container | blue |
| `sql-database` | cylinder | PostgreSQL | blue |
| `nosql-store` | cylinder | NoSQL | green |
| `cache` | card with zap icon | Redis cache | red |
| `object-storage` | card with archive icon | Object storage | amber |
| `search-index` | card with search icon | Search index | teal |
| `vector-db` | cylinder | Vector DB | violet |
| `data-warehouse` | cylinder | Warehouse | slate |
| `message-queue` | horizontal cylinder | Queue | orange |
| `event-stream` | horizontal cylinder | Kafka topic | ink |
| `pub-sub` | card with radio icon | Pub/Sub | orange |
| `notifications` | card with bell icon | Notifications | pink |
| `email-sms` | card with mail icon | Email / SMS | pink |
| `webhook` | card with webhook icon | Webhook | slate |
| `monitoring` | card with activity icon | Monitoring | green |
| `logs` | card with file icon | Logs | slate |
| `analytics` | card with chart icon | Analytics | green |
| `external-api` | cloud | 3rd-party API | slate |
| `payments` | card with card icon | Payments | green |
| `config` | card with cog icon | Config | slate |

Icons for `icon`: `activity`, `archive`, `bell`, `bot`, `box`, `brain`, `card`, `chart`, `clock`, `cloud`, `cog`, `container`, `cpu`, `database`, `databaseZap`, `door`, `drive`, `earth`, `file`, `gauge`, `globe`, `image`, `key`, `layers`, `lock`, `mail`, `message`, `monitor`, `network`, `phone`, `radio`, `router`, `search`, `server`, `shield`, `sparkles`, `split`, `timer`, `user`, `users`, `webhook`, `workflow`, `zap`.

### Basic shapes and annotations

| Kind | Shape |
| --- | --- |
| `box` | rounded rectangle |
| `ellipse` | ellipse |
| `decision` | diamond |
| `hexagon` | hexagon |
| `cylinder` | plain cylinder |
| `queue-shape` | plain horizontal cylinder |
| `cloud` | plain cloud |
| `note` | amber sticky note; text is left-aligned from the top |
| `text` | a label with no border; `label` is required |

### UML: `class`, `interface`, `abstract-class`, `enum`

These don't take `label`. Write the parts instead:

| Field | Notes |
| --- | --- |
| `name` | Required, one non-empty line. |
| `stereotype` | One line, shown as «stereotype» above the name. Defaults to `interface` for `interface` and `enum` for `enum`. |
| `abstract` | `true` sets the name in italics. An `abstract-class` is always abstract (`"abstract": false` is an error; use `class`). |
| `attributes` | Array of one-line strings, such as `"- id: String"`. Not for `enum`. |
| `methods` | Array of one-line strings, such as `"+ park(v: Vehicle): Ticket"`. End one with ` {abstract}` to italicise it. Not for `enum`. |
| `values` | `enum` only: the constants. |

Classes always show three compartments (name, attributes, methods), even when one is empty. A line can't be a bare `---`.

### ER tables: `table`

| Field | Notes |
| --- | --- |
| `name` | Required, one word (for example `order_items`). |
| `columns` | Required. Each column is `{ "name": "id", "type": "uuid", "key": "PK" }` or the string `"id uuid PK"`. Names and types are single words. `key` is `PK`, `FK`, `UQ` or `PK FK`. |

## Zones

A zone is a labelled, dashed boundary drawn behind a group of nodes, such as a region, VPC, trust boundary or package.

```json
{ "id": "vpc", "label": "us-east-1", "contains": ["api", "db"], "color": "slate", "padding": 32 }
```

Add `"trust": "public" | "internal" | "restricted" | "sensitive"` to declare a trust boundary for [rules](#change-review). Boxwire sizes the zone to wrap its members and never moves them. Zones contain nodes, not other zones. Auto layout doesn't keep a zone's members together, so if a non-member ends up inside the boundary you get a warning; when grouping must be exact, use manual layout. Edges may start or end at a zone id.

## Edges

| Field | Notes |
| --- | --- |
| `from`, `to` | Required. A node or zone id, or (manual layout only) a free point `{ "x": 0, "y": 0 }`, for example an annotation arrow pointing at a node. |
| `kind` | The relationship; default `flow`. See below. |
| `label` | Text on the connector. Short connectors carry their label beside the line. |
| `fromSide`, `toSide` | Pin the end to a face of the node: `n`, `e`, `s`, `w`. Leave unset to let Boxwire choose (recommended). |
| `route` | `ortho` (right angles that route around boxes; default), `curve`, `straight`. |
| `head`, `tail` | Override the arrowheads: `none`, `arrow`, `open`, `triangle`, `diamond`, `diamondFilled`, `circle`, `one`, `many`, `oneMany`, `zeroMany`. |
| `dash` | `solid`, `dashed`, `dotted`. |
| `color` | A colour token. |
| `width` | Line width, 0.5–8 (default 2). |
| `carries` | For capacity: `reads`, `writes`, `lookups` (one read per request the source handles, before fan-out, e.g. a fan-out worker loading a post's followers once per post), or `misses` (cache-aside: the reads that miss every cache the source reads, plus its writes; put it on the edge to the store those caches front). A `reads` or `lookups` edge is never a write path for the review rules. Omit to carry everything the source sends on. |
| `share` | For capacity: the fraction (0–1) of the source's output this edge carries. Default 1. |

`id` is optional. Without one, Boxwire assigns `e1`, `e2`, … in order, skipping ids you already used.

### Relationship kinds

| Kind | Looks like | Use for |
| --- | --- | --- |
| `flow` | solid line, filled arrow | requests, calls, data flow (default) |
| `async` | dashed line, filled arrow | events, queues, fire-and-forget |
| `two-way` | arrows at both ends | sync in both directions |
| `dependency` | dashed line, open arrow | UML dependency ("uses") |
| `association` | solid line, open arrow | UML association |
| `inheritance` | solid line, hollow triangle at `to` | UML generalisation: `from` child, `to` parent |
| `realization` | dashed line, hollow triangle at `to` | class implements interface: `from` class, `to` interface |
| `aggregation` | hollow diamond at `from` | `from` is the whole, `to` the part |
| `composition` | filled diamond at `from` | `from` owns `to` |
| `one-to-one` | ER bars at both ends | ER 1:1 |
| `one-to-many` | ER bar at `from`, crow's foot at `to` | ER 1:N |
| `zero-or-many` | ER bar at `from`, circle + crow's foot at `to` | ER 1:0..N |
| `many-to-many` | crow's feet at both ends | ER N:M |
| `line` | plain line | association without direction |

Explicit `head`, `tail` and `dash` override the kind's defaults.

## Frames

```json
{ "id": "f-read", "label": "2 · Redirect (hot read path)", "contains": ["api", "cache", "db"], "padding": 40 }
```

A frame is a named slide drawn around its members (node or zone ids), in array order. **Present** flies between frames with the arrow keys, and **Export → PDF** makes one vector page per frame. Frames are outlined in the editor but not painted into images, videos or the review. A frame whose members include another frame's members is drawn around it with a 40 px margin, so a progressive walkthrough nests cleanly: "1 · write path" → "2 · + read path" → "3 · whole design". Otherwise keep frames apart; overlapping frames that don't nest look broken. Use two to four frames.

## Strokes (manual layout only)

```json
{ "points": [[600, 228], [800, 228], [812, 300], [600, 312], [600, 228]], "color": "green", "width": 3, "highlighter": false }
```

Freehand marks for circling or underlining. Points are absolute `[x, y]` pairs, 2 to 5000 of them, spanning at most 100000 px in each direction.

## Layout

- **Auto** (default): nodes are ranked along `direction` by following the edges (a node's `rank` sets the earliest rank it may take), ordered to reduce crossings, and spaced so they never overlap. Parents in `inheritance`/`realization` go before their children, so with `"direction": "TB"` base classes sit on top. List nodes in the order you want them read; ties keep that order. Don't give `x`/`y`, free points or strokes in auto layout; they're errors.
- **Manual**: every node needs `x`, `y` (top-left). Typical sizes: cards are 180×64, databases 130×100, classes 220 wide and as tall as their content. Leave about 80 px between boxes so connectors have room to route.

## What the import produces

- Your ids are kept as the element ids, so importing the same file twice gives the same board. Edges and strokes without an id get `e1`, `e2`, … and `s1`, `s2`, … in the order they appear in their arrays.
- The board's history builds the diagram one element per step, in your order: zones, then each node, then each edge as soon as both its ends exist, then strokes. Boxwire's **Timelapse** replays exactly this, so ordering nodes the way you'd explain the system makes a better replay.
- A pasted diagram is a single undo step and gets fresh ids, so it can't collide with anything already on the board.
- Saved Boxwire board files (`"format": "boxwire"`, from Export → Board file) are a different, lower-level format. They open through the same menu and keep their own history. Don't hand-write them; write this format instead.

## Capacity

Put back-of-envelope numbers on the nodes themselves and Boxwire derives the load on every node and edge, with units and the formula for each number. Every field is optional. An undeclared fact is **unknown**: Boxwire never fills in a default for it.

```json
{ "id": "client", "kind": "web-client", "capacity": { "writesPerMonth": 100000000, "readWrite": 100, "peak": 2, "writeKB": 0.5, "readKB": 0.5 } },
{ "id": "db", "kind": "nosql-store", "capacity": { "replicas": 3, "shards": 4, "qpsPerNode": 5000, "retentionYears": 5, "replicationFactor": 3, "storageTB": 20 } }
```

| Field | Type | Unit / range | Meaning |
| --- | --- | --- | --- |
| `dau` | number | users; 0–100000000000 | Daily active users |
| `writesPerUser` | number | writes/user/day; 0–1000000 | Writes per user per day |
| `readsPerUser` | number | reads/user/day; 0–10000000 | Reads per user per day |
| `writesPerDay` | number | writes/day; 0–100000000000000 | Writes per day |
| `writesPerMonth` | number | writes/30 days; 0–1000000000000000 | Writes per month (30 days) |
| `readWrite` | number | reads per write; 0–1000000 | Read:write ratio |
| `writeQps` | number | writes/s; 0–10000000000 | Write rate |
| `readQps` | number | reads/s; 0–10000000000 | Read rate |
| `peak` | number | × average; 1–100 | Peak multiplier |
| `writeKB` | number | KB/write; 0–10000000 | Write payload |
| `readKB` | number | KB/read; 0–10000000 | Read response |
| `qpsPerNode` | number | req/s per instance; 0–1000000000 | Rated throughput |
| `replicas` | integer | instances; 1–100000 | Replicas |
| `shards` | integer | partitions; 1–100000 | Shards |
| `hitRatio` | number | 0–1; 0–1 | Cache hit ratio |
| `ttlSec` | number | s (0 = never expires); 0–1000000000 | Cache TTL |
| `fanout` | number | × per input; 0–10000000 | Fan-out |
| `retentionYears` | number | years; 0–1000 | Retention |
| `replicationFactor` | integer | copies; 1–100 | Replication factor |
| `storageTB` | number | TB; 0–1000000000 | Storage capacity |
| `managed` | boolean | `true` / `false` | Managed, highly available service |
| `auth` | boolean | `true` / `false` | Authenticates callers |
| `public` | boolean | `true` / `false` | Deliberately public (anonymous) |

**Semantics.**

1. **Sources.** Load starts at clients (`web-client`, `mobile-app`, `user`). Writes/s = `writeQps`, else writes per day (`writesPerDay`, `writesPerMonth` ÷ 30, or `dau × writesPerUser`) ÷ 86,400 × `peak`. Reads/s = `readQps`, else `dau × readsPerUser` ÷ 86,400 × `peak`, else writes/s × `readWrite`. `writeQps` and `readQps` are taken as peak rates. Payload rates are rates × `writeKB` / `readKB`.
2. **Flow.** Load moves along edges in the request direction (the arrowhead), in topological order. A node receives the sum of its incoming edges. By default each outgoing edge carries everything the node sends on; `carries` and `share` narrow that.
3. **Transforms.** A cache or CDN passes on only misses: reads × (1 − `hitRatio`), plus every write. A queue turns everything it receives into messages (writes) for its consumers. `fanout` multiplies what a node sends on (fan-out on write); `carries: "lookups"` is one read per request the node handles, before fan-out.
   - **Cache-aside is declared:** when a node reads a cache and, on a miss, a store, put `"carries": "misses"` on its edge to the store. That store then sees exactly the reads the cache didn't serve (plus the node's writes).
   - **Coverage:** a cache serves only the reads that reach it. With a `share` s on the edge to a cache with hit ratio h, the store behind it gets reads × (1 − s × h): share 0 serves nothing (every read reaches the store), share 0.5 at 90% leaves 55%. Demand is conserved: what the caches serve plus what reaches the store is every read.
   - **Not declared:** any other read edge from a node that reads caches, to a store, may or may not be behind them, even when it is the only store: nothing says which store a cache fronts (a session cache doesn't front a members table). That store gets the range [misses, all reads], so it passes only if it can take every read.
   - **Serial caches:** a `misses` edge to a second cache is a second level behind the first, not a cache read in parallel.
   - **Several parallel caches:** declared hit ratios are marginal, so the requests that miss them all lie between max(0, 1 − Σ hits) and the smallest miss. Two 90% caches give 0–10% of reads, not 1%. To model a serial lookup, draw it serially (cache → cache → store), or mark the second cache's edge `misses`. A `misses` edge counts the misses of every cache its source reads; if one node reads caches that front different stores, the joint-miss range applies to each.
4. **Ratings.** Per-instance load is checked against `qpsPerNode` at peak. Services: (reads + writes) ÷ `replicas`. Stores and caches: reads ÷ (`replicas` × `shards`) + writes ÷ `shards` (reads spread over every replica, writes go to one leader per shard). Queues: messages ÷ `shards` (partitions). Clients, managed and external services are not rated unless they declare `qpsPerNode`.
5. **Storage.** A store accumulates its *average* incoming write KB/s × 86,400 × 365 × `retentionYears` × `replicationFactor`, compared with `storageTB` (1 TB = 10⁹ KB). `writeKB` on a store or service re-declares the record size from that node on, for example a metadata store beside blob storage.
6. **Unknowns are ranges.** Every number is an interval. An undeclared hit ratio is [0, 1], and undeclared replicas, shards and replication factor are [1, ∞). A contradiction is reported only when it holds for every possible value of what is undeclared; a pass only when it holds for all of them. Anything in between is unknown and says what to declare.
7. **Feedback loops.** Every transform above is linear with non-negative coefficients, so the load a loop feeds back is the least fixed point of f = f0 + G·f.
   - **Lower bound:** Boxwire cuts the edges that close each cycle and feeds back the previous pass's load. Each pass is a lower bound.
   - **Upper bound:** it is claimed only when certified. Boxwire measures the gain matrix G exactly by feeding a unit load into each cut edge and load key with no sources, at worst-case coefficients. Some power must have ‖Gᵐ‖∞ = q below 1 − 10⁻⁶. The remaining tail is then at most M·‖f0‖·m·q^⌊n/m⌋ / (1 − q), and the step shows m, q and the tail.
     - A lookup that never comes back as a write is nilpotent: q = 0, so it has no tail.
     - 10/s with a 0.9 share fed back is certified at 100/s.
   - **Not certified:** with a gain of 1, or a near-unit gain that can't be certified, the loop keeps only its lower bound, and nothing in or after it can pass a rating. Two floating-point passes that come out equal are not taken as proof.
   - **Robustness:** the result doesn't depend on which edge the search cut, or on nodes that carry no load.
   - **What to declare:** a `share` on feedback edges (retry rate, fraction of discovered links admitted).
8. **Numbers.** Rates and sizes are compared with a relative tolerance of 10⁻⁹, for binary floating-point representation only: 1000 × (1 − 0.7) is exactly 300/s against a 300/s rating. An exact zero stays zero even when the matching payload size is undeclared.

## Review

Boxwire reviews the typed graph: nodes by `kind`, edges by direction and mode (solid = synchronous request, dashed = asynchronous message). Crossed-out nodes, notes, zones, frames and plain shapes are not part of it. **Rules check the declared model, not the deployed system.** Every rule returns one of three results:

- **violation**: the diagram demonstrates the problem. The result carries a *witness*, the path or edge that shows it (alternating node and edge ids).
- **unknown**: the answer depends on something the diagram doesn't declare. The result says what to declare. A missing annotation is never a violation.
- **pass**: the diagram demonstrates the property.

Result ids are stable (`rule:elementId+elementId`), so a critique can cite them. That the twelve reference designs produce no violations and no unknowns is a regression gate for these rules, not a claim that they find every flaw. Rules v1:

<!-- generated from review/lint.js -->

### `single-point-of-failure` (warning)

**Single point of failure.** A node that every path from some client to some durable store goes through (or that durable store itself), excluding managed kinds (dns, cdn, object-storage, external-api, payments, notifications, email-sms, webhook) and nodes declared managed.

- **Violation:** It declares replicas: 1.
- **Unknown:** It declares neither replicas nor managed.
- **Pass:** It declares replicas ≥ 2 or managed: true.
- **Fix:** Run at least two replicas (behind a load balancer for services, leader + followers for stores), or declare a managed, multi-AZ service.

### `cache-without-invalidation` (warning)

**Cache without an invalidation path.** Each cache: does it expire entries, or does a write path reach it? A writer is a node with a write-carrying edge to a durable store; it invalidates the cache when it also has a write-carrying edge to the cache. A consumer of a queue or stream that writes to the cache also counts.

- **Violation:** It declares ttlSec: 0 (never expires) and some writer updates the store behind it without touching the cache.
- **Unknown:** No TTL is declared and no invalidation edge is drawn.
- **Pass:** It declares ttlSec > 0, or an invalidation edge is drawn.
- **Fix:** Give entries a TTL, or draw the invalidation: the writer deletes or updates the key (write-through), or an event consumer does.

### `write-without-durable-store` (error)

**Writes never reach a durable store.** From each client with outgoing edges, follow every edge that carries writes (carries is not "reads"), through any node, and look for a durable store (sql-database, nosql-store, object-storage, search-index, vector-db, data-warehouse). A cache is not durable.

- **Violation:** The client declares writes (a write rate above 0 or an edge with carries: "writes") and no durable store is reachable.
- **Unknown:** No durable store is reachable but the client doesn't declare whether it writes.
- **Pass:** A durable store is reachable on a write path, or the client declares zero writes.
- **Fix:** Persist writes in a durable store (directly, or through a queue and a consumer). A cache alone loses data on restart or eviction.

### `capacity-contradiction` (error)

**Capacity contradiction.** Load declared at clients, propagated along edges (see "Capacity"), against each node's declared rating per instance (qpsPerNode) and each store's declared storageTB.

- **Violation:** The load per instance exceeds the rating, or the data retained exceeds the storage, for every value of what is undeclared.
- **Unknown:** The node carries load but declares no rating, or the outcome depends on undeclared replicas, shards, hit ratios or payload sizes.
- **Pass:** The rating covers the load (and storage covers the data) for every value of what is undeclared.
- **Fix:** Add replicas or shards, put a cache in front, or raise the rating; for storage, add shards, shorten retention or tier cold data to object storage.

### `unauthenticated-public-entry` (warning)

**Unauthenticated public entry.** Each entry node (the first node past the edge tier: dns, cdn, load-balancer, rate-limiter, api-gateway) and every synchronous path to it from every client through the edge tier. Auth services, stores, caches and queues are skipped (client-to-datastore covers data reached directly).

- **Violation:** Some entry path has a node that declares auth: false and nothing on that path authenticates or declares public: true.
- **Unknown:** Some entry path has nothing that declares auth, connects to an auth-service, or declares public (or there are too many paths to check).
- **Pass:** Every entry path has a node that declares auth: true or has an edge to an auth-service, or declares public: true. One authenticated route never hides another.
- **Fix:** Authenticate at the gateway or entry service (draw its edge to the auth service, or declare auth: true), or declare the entry public if anonymous access is intended.

### `client-to-datastore` (error)

**Client talks to a datastore directly.** Edges from a client straight to a store, cache or queue. Object storage is exempt (pre-signed URLs are the standard pattern).

- **Violation:** Such an edge is drawn.
- **Unknown:** Never: this rule reads only what is drawn.
- **Pass:** The client has edges and none of them goes to a datastore.
- **Fix:** Put a service (or API gateway) between the client and the data, so access control, validation and schema changes live server-side. For uploads, use pre-signed object-storage URLs.

### `orphan-component` (info)

**Unconnected component.** Architecture nodes with no edge to another architecture node. Ops kinds (monitoring, logs, analytics, config) are exempt: they observe everything implicitly.

- **Violation:** The node has no edges.
- **Unknown:** Never.
- **Pass:** Not listed per node.
- **Fix:** Connect it to what calls it or what it calls, or cross it out (X) if it is a rejected option.

### `queue-without-consumer` (error)

**Queue without a consumer.** Every message-queue, event-stream and pub-sub node needs an outgoing edge to whatever consumes it.

- **Violation:** The queue has no outgoing edge.
- **Unknown:** Never.
- **Pass:** At least one consumer is drawn.
- **Fix:** Draw the consumer (a worker or service) reading from the queue, or remove the queue.

### `deep-sync-chain` (warning)

**Deep synchronous call chain.** The longest path of solid (synchronous) edges through compute and auth nodes. More than 4 services in a row multiplies latency and failure probability.

- **Violation:** A synchronous chain of 5 or more services is drawn.
- **Unknown:** Never.
- **Pass:** No synchronous service chain is longer than 4.
- **Fix:** Make the tail of the chain asynchronous (a queue), collapse services, or call independent services in parallel from one place.

### `sync-cycle` (warning)

**Synchronous call cycle.** Strongly connected components of solid (synchronous) edges among non-client nodes.

- **Violation:** Services call each other in a cycle: a slow member can deadlock or amplify load around it.
- **Unknown:** Never.
- **Pass:** No synchronous cycle.
- **Fix:** Break the cycle: make one direction asynchronous (an event), or move the shared logic into one service.

<!-- /generated -->

## Practice rubric

Practice mode runs a 40-minute session in five timed phases on a blank board, then scores it against this published rubric (v1). Scoring is local and deterministic, and the same board always gets the same score. Every item links to the elements behind it and the moment they appear in the timelapse. Items that need a timeline (phase timing, what was written when) score only in practice mode; outside it they are marked "not scored" and the total is out of the remaining points.

<!-- generated from review/rubric.js -->

| Phase | Minutes | Goal |
| --- | --- | --- |
| Requirements (`requirements`) | 5 | Pin down functional and non-functional requirements in a note. |
| Estimates (`estimates`) | 5 | Declare load on the client (users, rates, payload) and see QPS, storage and bandwidth derive. |
| High-level design (`hld`) | 15 | Draw the request path end to end: clients, edge, services, data. |
| Deep dive (`deep-dive`) | 10 | Declare replicas, ratings and caches; resolve review findings on the critical path. |
| Trade-offs (`trade-offs`) | 5 | Cross out rejected options (X) and note why. |

| Item | Phase | Points | How it is scored |
| --- | --- | --- | --- |
| `requirements-note`: Requirements written down | requirements | 8 | A note with at least 3 lines exists. In practice mode it must be created during the Requirements phase for full marks (half if later). |
| `load-declared`: Load estimated before the design | estimates | 8 | A client declares load (users and per-user rates, writes per day/month with a read:write ratio, or rates). In practice mode it must be declared before the High-level design phase ends (half if later). |
| `storage-derived`: Storage estimated | estimates | 4 | Some durable store derives a storage figure (a client declares writeKB and the store declares retentionYears). |
| `entry-path`: Clients enter through an edge tier | hld | 8 | Some client reaches a compute node through a load balancer or API gateway. Not scored for problems with no public request path (an internal batch system such as a crawler). |
| `durable-writes`: Writes reach durable storage | hld | 8 | The write-without-durable-store lint rule passes for at least one client and has no violations. |
| `read-path-cache`: The hot read path is cached | hld | 8 | When the problem is read-heavy (or declared reads are ≥ 10× writes), a cache or CDN is reachable from a client. |
| `must-have-components`: The problem's must-have components | hld | 12 | For each component the problem lists, at least one node of an accepted kind exists (not crossed out). Points split evenly. |
| `async-offload`: Slow work runs asynchronously | hld | 4 | At least one queue or stream has a consumer (the queue-without-consumer rule passes) and none is left unconsumed. Not scored when the problem lists no asynchronous component and the board has no queue. |
| `redundancy`: No single points of failure | deep-dive | 8 | Every node the single-point-of-failure rule examines passes. Partial credit is the fraction that pass; undeclared redundancy earns nothing for that node. |
| `capacity-consistent`: Capacity is declared and consistent | deep-dive | 8 | The capacity-contradiction rule has at least one pass and no violations. Partial credit is the fraction of checked nodes that pass. |
| `no-lint-errors`: No error-level lint violations | deep-dive | 6 | A client is drawn and connected, and no violation comes from an error-severity rule (write-without-durable-store, capacity-contradiction, client-to-datastore, queue-without-consumer). |
| `rejected-alternative`: A rejected alternative is shown | trade-offs | 6 | At least one node is crossed out (X): an option considered and rejected, kept visible. |
| `trade-off-notes`: Trade-offs written down | trade-offs | 4 | In practice mode, a note is created or edited during the Trade-offs phase. Outside practice, at least two notes exist. |
| `phase-timing`: Phases kept to time | process | 8 | Practice mode only: each finished phase took at most 1.2× its budget and has at least one committed step in it. A phase with no work in it is skipped, not on time. Partial credit is the fraction on time. |

**Assumptions**

- The score reads the declared model: node kinds, edges, capacity declarations, crossed-out nodes, notes and the build history's timestamps. Rules check the declared model, not a deployed system.
- Solid arrows are synchronous requests and dashed arrows asynchronous messages; the arrowhead gives the direction.
- Anything undeclared (replicas, auth, TTLs, ratings, load) is unknown. Items that depend on it score nothing and say what to declare; they are not marked wrong.
- Notes count by kind and timing, not by what they say: the rubric never reads your words.
- Phase timing comes from your own phase changes; a step belongs to the phase that was running when you committed it.

**What a diagram can't show** (never scored)

- Whether the requirements you wrote are the right ones, or complete.
- API design, data model and schema quality.
- Consistency, isolation and ordering guarantees, unless drawn as components.
- Whether your numbers are realistic: only that they are internally consistent.
- Security beyond declared authentication on entry paths.
- The quality of your trade-off reasoning, and everything you said out loud.

<!-- /generated -->

## Agent patches

To critique a user's design, ask for its **critique bundle** (Review → Critique bundle, or Export → Critique bundle). It's one JSON file with `"format": "boxwire-critique"` containing:

- `baseline`: the board's SHA-256;
- `graph`: nodes with kind, role, label and declared capacity, plus edges with mode, `carries` and `share`;
- `review.rules` and `review.results`, including witnesses;
- `capacity`: the derived formulas;
- `rubric` and `score`.

Cite result ids in your critique. To propose changes, answer with a patch:

```json
{
  "format": "boxwire-patch",
  "version": 1,
  "baseline": "<baseline from the bundle>",
  "ops": [
    { "op": "add-node", "id": "db2", "kind": "sql-database", "label": "Read replica", "capacity": { "replicas": 2 }, "near": "db" },
    { "op": "connect", "from": "api", "to": "db2", "kind": "flow", "carries": "reads" },
    { "op": "set-capacity", "id": "api", "capacity": { "replicas": 3, "qpsPerNode": null } },
    { "op": "set-label", "id": "cache", "label": "Redis (hot links)" },
    { "op": "set-kind", "id": "box1", "kind": "worker" },
    { "op": "cross-out", "id": "sqlCounter", "crossed": true },
    { "op": "remove", "id": "oldQueue" }
  ]
}
```

- **Applying:** the user pastes the patch onto the board or opens it as a file. Boxwire checks every operation first (ids, kinds, capacity fields and ranges) and shows each one in words, plus which review results it resolves and which it introduces. Applying is one undoable step.
- **Refusals:** a patch whose `baseline` doesn't match the current board is refused, because the board changed since the bundle was made. So is a patch with any invalid operation; nothing in it is applied.
- **Operation rules:** `null` in `set-capacity` clears that field. `remove` also removes the node's connectors. New ids follow the id rules above.

## Change review

Boxwire can review an architecture change made to a source file. The usual case is one an agent proposed against a commented `.boxwire.jsonc` baseline.

1. **Inputs.** The source keeps its comments and formatting. Identity (`id`), display (`label`) and layout (`positions`) are separate. Canvas edits on a board opened from a source file become the smallest edits to that text, by stable id: a property, an inserted or removed item, or a position. The file is never regenerated.
2. **The diff.** It is computed by stable id and split into **semantic** (kinds, labels, capacity, meta, edges and their endpoints, membership, trust), **layout** (positions, sides, routes), **presentation** (colours, fonts, frames) and **identity** changes. A renamed label is one change, not a delete plus an add.
   - **Identity:** an edge without an `id` is known by the id the compiler generates for it (`e1`, `e2` … in array order). When an insertion or removal would shift a surviving edge's generated id, the edit writes that id down explicitly (`"id": "e3"`) so the edge keeps its identity. Writing an id down, or naming an edge, is an identity change: it is listed apart and never counted as a layout or model change.
3. **Rules.** Rules come from a `boxwire-rules` document (below) and run on both sides. Each violation carries a witness path and source line:col ranges.
   - **Introduced and resolved:** a violation is reported as introduced or resolved only when both evaluations are complete.
   - **Aborted evaluations:** if one stops at its work budget, the comparison is reported as **not evaluated**; it is never taken as evidence that something was fixed.
4. **Acceptance and merging.**
   - **Partial acceptance:** you can accept some changes and not others, and references are preserved. Accepting an edge pulls in its new endpoints; rejecting a node drops its edges. Rules that held on both sides but fail on the partial result are listed.
   - **Three-way merge:** when you have edited the same baseline, your edits are merged with the proposal field by field. Overlapping edits are shown as conflicts for you to resolve.
5. **Export.** The result is a minimal source patch (a unified diff) and an offline **review bundle**. The bundle is a `.zip` holding the sources, the patch, the rules, the results with witnesses, the views and a self-contained `review.html`. Opening a bundle checks every file's SHA-256 and re-runs the checks; a stale baseline, an unsupported version or a damaged archive is refused. The reviewer's selection travels in `accepted.patch.json`, and reopening the bundle restores those checkboxes. The hashes prove integrity and which files were compared. They don't identify a reviewer and are not an approval.

```json
{ "format": "boxwire-rules", "version": 1, "rules": [
  { "id": "no-sync-cycles", "kind": "no-cycle", "edges": "sync" },
  { "id": "public-to-pii-mediated", "kind": "no-path", "from": { "trust": ["public"] }, "to": { "meta": { "data": "pii" } }, "unless": { "through": { "kind": ["api-gateway", "auth-service"] } } },
  { "id": "data-does-not-call-services", "kind": "forbid-edge", "from": { "role": ["store", "cache"] }, "to": { "role": ["compute"] } },
  { "id": "layer-order", "kind": "layers", "order": [{ "role": ["client"] }, { "role": ["edge"] }, { "role": ["compute"] }, { "role": ["store"] }] },
  { "id": "owned", "kind": "require", "of": { "role": ["compute", "store"] }, "fields": ["meta.owner"], "severity": "warning" }
] }
```

**Rule kinds:**

| Kind | What it checks |
| --- | --- |
| `no-cycle` | Strongly connected components |
| `forbid-edge` | Forbidden dependency directions |
| `layers` | Nothing points from a later layer back to an earlier one |
| `no-path` | Reachability across declared trust boundaries; `unless.through` names the nodes that mediate |
| `require` | Required metadata |

**Selectors:** `kind`, `role`, `zone`, `trust`, `meta` and `id`. Keys combine with AND; values inside a list combine with OR.

**Always on:** dangling references and duplicate ids.

**Limits:** evaluation is capped at 2000 nodes and 250,000 edge examinations. Past either cap, nothing partial is reported. Rules check the declared model, not the deployed system.

## Importing Mermaid and Structurizr

Boxwire imports a **subset** of two text formats with its own parsers. An import is never applied to a board directly: it becomes a proposal in the change review, against an empty baseline (everything is an addition) or, when re-importing an updated file, against the board's source, so only what changed shows.

- **Mermaid flowcharts** (`flowchart` / `graph`): directions; the classic node shapes (box, rounded, stadium, subroutine, cylinder, circle, flag, rhombus, hexagon, parallelogram, trapezoid); quoted, HTML-break and `#code;` labels; solid, dotted (`-.->`, drawn as async) and thick links with arrow, open, circle and two-way heads; `|text|` and `-- text -->` labels; chains and `&`; `subgraph … end` as zones; `%%` comments; a frontmatter `title`. Nodes become plain shapes with no architecture kind.
- **Structurizr DSL** workspaces: `person` (kind `user`), `softwareSystem`, `container` and `component`; flat or hierarchical identifiers; relationships, including `->` inside an element; description and tags in `meta`, technology on the label; tags `Database`, `Queue`, `Topic`, `Cache`, `Web Browser`, `Mobile App`, `File System` name a kind; a system or container with children becomes a zone around them (zones don't nest, so a container with components gets its own zone beside its system's); `systemLandscape`, `systemContext`, `container` and `component` views with `include *` or ids and `autoLayout`, as frames.
- **Loss report:** everything else (styles, classes, click handlers, v11 shapes, edge ids, deployment, dynamic and filtered views, themes, `!include`, scripts …) is listed with its line as *unsupported*, and anything drawn differently as *approximated*; an id changed to fit the id rules is *renamed*. A statement the parser doesn't understand is listed, never dropped. The report and the original comments head the generated source. A numeric character reference that isn't a character (above U+10FFFF, a surrogate, NUL) becomes U+FFFD and is reported.

## Limits

| What | Limit |
| --- | --- |
| File size | 5 MB |
| Elements (nodes + zones + edges + strokes) | 5000 |
| Nodes / zones / edges / strokes | 1500 / 200 / 3000 / 500 |
| Label length | 2000 characters (UML/ER lines: 200; all of one node's text: 20000) |
| Coordinates | ±100000 |
| Node size | 16–4000 |

## Checklist before you answer

1. `format` and `version` set; one JSON object, nothing else.
2. Every `kind` comes from the tables above, with no invented kinds.
3. Ids are unique and every edge's `from`/`to` matches an id.
4. Auto layout with no coordinates, unless the user needs exact placement.
5. UML and tables use `name`/`attributes`/`methods`/`columns`, not `label`.
6. Rejected options use `"crossed": true` rather than being deleted, if the user wants the reasoning visible.
7. For system designs, declare load on the clients and ratings on what serves it (`capacity`), and `carries` where reads and writes split; leave unknown facts undeclared rather than guessing.

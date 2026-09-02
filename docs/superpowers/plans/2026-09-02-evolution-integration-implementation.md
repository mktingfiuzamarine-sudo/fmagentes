# Evolution API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Fundação webhook/queue seams real — authenticate, parse, persist, and enqueue inbound WhatsApp messages; manage Evolution instances through the API; send outbound text messages — with no AI or agent logic.

**Architecture:** A new `packages/messaging` holds the domain operations (`ingestInboundMessage`, `sendMessage`, the `inbound-messages` queue) shared by `apps/api` now and `apps/worker` in sub-project 3. `apps/api` gains real instance/conversation routes and a real webhook handler; `apps/worker` runs a stub processor. The `test-queue` scaffolding is deleted.

**Tech Stack:** Node.js ≥ 22, TypeScript, pnpm workspaces + Turborepo, Fastify, BullMQ + ioredis, `@supabase/supabase-js`, zod, Vitest, tsx.

**Spec:** `docs/superpowers/specs/2026-09-01-evolution-integration-design.md` (read it alongside this plan).

## Global Constraints

- Runtime: Node.js **>= 22**, TypeScript everywhere.
- Monorepo: pnpm workspaces + Turborepo. New packages under `packages/*` are picked up automatically; run `pnpm install` after adding one.
- API framework: Fastify. Queue: BullMQ; the worker is a separate process.
- `packages/messaging` reads **no environment variables** — all dependencies (Supabase client, Evolution client) are injected as a `deps` argument.
- Env validation: zod, fail-fast (`process.exit(1)` with a clear message) — via `createEnvLoader` from `@fmagentes/config`.
- Tests: Vitest in every app/package. **No live Evolution API or live Supabase in the test suite** — mock both. Redis-backed tests may use the local Docker Redis.
- Webhook auth: a single shared secret in `WEBHOOK_SECRET`, checked against the `apikey` header on every inbound request.
- RLS stays as Fundação left it (`using (true)`); the service-key Supabase client bypasses it. Not in scope to change.
- Out of scope: AI/agent logic, agent endpoints (new conversations get `agent_id = null`), delivery receipts / `messages.status`, dashboard UI, multi-tenancy, production deploy.

---

### Task 1: Migration `0003_messaging.sql` — uniqueness constraints

**Files:**
- Create: `supabase/migrations/0003_messaging.sql`

**Interfaces:**
- Produces: a `unique` constraint on `messages.evolution_message_id` and a `unique (instance_id, contact_phone)` on `conversations`, which Task 5's idempotent inserts rely on.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0003_messaging.sql`:

```sql
-- Sub-project 2: messaging. Enables idempotent webhook ingest and race-free
-- find-or-create of conversations.

alter table messages
  add constraint messages_evolution_message_id_key unique (evolution_message_id);

alter table conversations
  add constraint conversations_instance_contact_key unique (instance_id, contact_phone);

comment on column instances.status is
  'lifecycle: created | connecting | connected | disconnected';
```

- [ ] **Step 2: Apply the migration**

Use `mcp__plugin_supabase_supabase__apply_migration` with `{ project_id: "odqqiteoskmfpwrlqyrb", name: "messaging", query: "<file contents>" }`.
If that tool is unavailable, ask the user to paste the file into the Supabase dashboard → SQL Editor and run it.

- [ ] **Step 3: Verify the constraints exist**

Use `mcp__plugin_supabase_supabase__execute_sql` with:
```sql
select conname from pg_constraint
where conname in ('messages_evolution_message_id_key', 'conversations_instance_contact_key');
```
Expected: both rows returned.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0003_messaging.sql
git commit -m "feat: add messaging uniqueness constraints migration"
```

---

### Task 2: `packages/shared` — expand `evolutionApiClient`

**Files:**
- Modify: `packages/shared/src/evolutionApiClient.ts`
- Create: `packages/shared/src/instanceStatus.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/tests/evolutionApiClient.test.ts`
- Create: `packages/shared/tests/instanceStatus.test.ts`
- Modify: `apps/api/src/index.ts` (rename call site)
- Modify: `apps/api/tests/health.test.ts` (rename in fake deps)

**Interfaces:**
- Produces:
  - `EvolutionApiClient` interface with:
    - `checkConnection(): Promise<boolean>` (unchanged)
    - `sendText(instanceName: string, to: string, text: string): Promise<{ messageId: string | null }>` (renamed from `sendMessage`, now returns the id)
    - `createInstance(name: string, webhook: { url: string; events: string[] }): Promise<void>`
    - `connectInstance(name: string): Promise<{ qrcode: string | null; pairingCode: string | null }>`
    - `deleteInstance(name: string): Promise<void>` (treats HTTP 404 as success)
    - `fetchInstance(name: string): Promise<{ state: string; number: string | null } | null>`
  - `INSTANCE_STATUS` — `{ CREATED: "created", CONNECTING: "connecting", CONNECTED: "connected", DISCONNECTED: "disconnected" }` as const
  - `InstanceStatusValue` — `(typeof INSTANCE_STATUS)[keyof typeof INSTANCE_STATUS]`
  - `mapConnectionState(state: string): InstanceStatusValue` — `"open"` → connected, `"connecting"` → connecting, anything else → disconnected

- [ ] **Step 1: Write failing tests for the new client methods**

Replace `packages/shared/tests/evolutionApiClient.test.ts` with:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionApiClient } from "../src/evolutionApiClient";

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body };
}

const client = () => createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

describe("createEvolutionApiClient", () => {
  afterEach(() => vi.restoreAllMocks());

  it("checkConnection returns true on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([])));
    await expect(client().checkConnection()).resolves.toBe(true);
  });

  it("checkConnection returns false on failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    await expect(client().checkConnection()).resolves.toBe(false);
  });

  it("sendText posts number+text and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({ key: { id: "MSG123" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await client().sendText("inst 1", "5511999999999", "hi");

    expect(result).toEqual({ messageId: "MSG123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://evo.example.com/message/sendText/inst%201",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ number: "5511999999999", text: "hi" }) })
    );
  });

  it("sendText returns null id when the response has none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({})));
    await expect(client().sendText("i", "5", "t")).resolves.toEqual({ messageId: null });
  });

  it("createInstance posts the name, integration and webhook config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson({}));
    vi.stubGlobal("fetch", fetchMock);

    await client().createInstance("acme", { url: "https://cb.example.com/webhooks/evolution", events: ["MESSAGES_UPSERT"] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example.com/instance/create");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.instanceName).toBe("acme");
    expect(body.integration).toBe("WHATSAPP-BAILEYS");
    expect(body.webhook.url).toBe("https://cb.example.com/webhooks/evolution");
    expect(body.webhook.events).toEqual(["MESSAGES_UPSERT"]);
  });

  it("connectInstance returns the qrcode and pairing code", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson({ base64: "data:image/png;base64,AAAA", pairingCode: "ABCD-1234" })));
    await expect(client().connectInstance("acme")).resolves.toEqual({
      qrcode: "data:image/png;base64,AAAA",
      pairingCode: "ABCD-1234",
    });
  });

  it("deleteInstance treats a 404 as success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }));
    await expect(client().deleteInstance("gone")).resolves.toBeUndefined();
  });

  it("deleteInstance throws on other errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    await expect(client().deleteInstance("x")).rejects.toThrow();
  });

  it("fetchInstance returns state and parsed number, or null when absent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([
      { name: "acme", connectionStatus: "open", ownerJid: "5511988887777@s.whatsapp.net" },
    ])));
    await expect(client().fetchInstance("acme")).resolves.toEqual({ state: "open", number: "5511988887777" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okJson([])));
    await expect(client().fetchInstance("acme")).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests — expect failure**

Run: `pnpm --filter @fmagentes/shared exec vitest run tests/evolutionApiClient.test.ts`
Expected: FAIL — `sendText`, `createInstance`, etc. are not defined.

- [ ] **Step 3: Rewrite `evolutionApiClient.ts`**

Replace `packages/shared/src/evolutionApiClient.ts` with:

```ts
export interface EvolutionApiConfig {
  baseUrl: string;
  apiKey: string;
}

export interface EvolutionApiClient {
  checkConnection(): Promise<boolean>;
  sendText(instanceName: string, to: string, text: string): Promise<{ messageId: string | null }>;
  createInstance(name: string, webhook: { url: string; events: string[] }): Promise<void>;
  connectInstance(name: string): Promise<{ qrcode: string | null; pairingCode: string | null }>;
  deleteInstance(name: string): Promise<void>;
  fetchInstance(name: string): Promise<{ state: string; number: string | null } | null>;
}

export function createEvolutionApiClient(config: EvolutionApiConfig): EvolutionApiClient {
  const headers = {
    "Content-Type": "application/json",
    apikey: config.apiKey,
  };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...init?.headers },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new EvolutionApiError(response.status, response.statusText);
    }

    return response;
  }

  const seg = encodeURIComponent;

  return {
    async checkConnection() {
      try {
        await request("/instance/fetchInstances");
        return true;
      } catch {
        return false;
      }
    },

    async sendText(instanceName, to, text) {
      const response = await request(`/message/sendText/${seg(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ number: to, text }),
      });
      const data = (await response.json().catch(() => ({}))) as { key?: { id?: string } };
      return { messageId: data.key?.id ?? null };
    },

    async createInstance(name, webhook) {
      await request("/instance/create", {
        method: "POST",
        body: JSON.stringify({
          instanceName: name,
          integration: "WHATSAPP-BAILEYS",
          qrcode: true,
          webhook: { url: webhook.url, byEvents: true, events: webhook.events },
        }),
      });
    },

    async connectInstance(name) {
      const response = await request(`/instance/connect/${seg(name)}`);
      const data = (await response.json().catch(() => ({}))) as { base64?: string; code?: string; pairingCode?: string };
      return { qrcode: data.base64 ?? null, pairingCode: data.pairingCode ?? data.code ?? null };
    },

    async deleteInstance(name) {
      try {
        await request(`/instance/delete/${seg(name)}`, { method: "DELETE" });
      } catch (error) {
        if (error instanceof EvolutionApiError && error.status === 404) return;
        throw error;
      }
    },

    async fetchInstance(name) {
      const response = await request(`/instance/fetchInstances?instanceName=${seg(name)}`);
      const list = (await response.json().catch(() => [])) as Array<{
        connectionStatus?: string;
        state?: string;
        ownerJid?: string;
      }>;
      const found = list[0];
      if (!found) return null;
      const jid = found.ownerJid ?? null;
      return {
        state: found.connectionStatus ?? found.state ?? "unknown",
        number: jid ? jid.split("@")[0] : null,
      };
    },
  };
}

export class EvolutionApiError extends Error {
  constructor(
    public readonly status: number,
    statusText: string,
  ) {
    super(`Evolution API request failed: ${status} ${statusText}`);
    this.name = "EvolutionApiError";
  }
}
```

- [ ] **Step 4: Create `instanceStatus.ts`**

Create `packages/shared/src/instanceStatus.ts`:

```ts
export const INSTANCE_STATUS = {
  CREATED: "created",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
} as const;

export type InstanceStatusValue = (typeof INSTANCE_STATUS)[keyof typeof INSTANCE_STATUS];

export function mapConnectionState(state: string): InstanceStatusValue {
  if (state === "open") return INSTANCE_STATUS.CONNECTED;
  if (state === "connecting") return INSTANCE_STATUS.CONNECTING;
  return INSTANCE_STATUS.DISCONNECTED;
}
```

Create `packages/shared/tests/instanceStatus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { INSTANCE_STATUS, mapConnectionState } from "../src/instanceStatus";

describe("mapConnectionState", () => {
  it("maps open to connected", () => {
    expect(mapConnectionState("open")).toBe(INSTANCE_STATUS.CONNECTED);
  });
  it("maps connecting to connecting", () => {
    expect(mapConnectionState("connecting")).toBe(INSTANCE_STATUS.CONNECTING);
  });
  it("maps close and anything else to disconnected", () => {
    expect(mapConnectionState("close")).toBe(INSTANCE_STATUS.DISCONNECTED);
    expect(mapConnectionState("weird")).toBe(INSTANCE_STATUS.DISCONNECTED);
  });
});
```

- [ ] **Step 5: Update `packages/shared/src/index.ts`**

Replace the `evolutionApiClient` export line and add the status export. The file becomes:

```ts
export type { Instance, Agent, Conversation, Message } from "./types";
export { createSupabaseClient, type SupabaseConfig } from "./supabaseClient";
export {
  createEvolutionApiClient,
  EvolutionApiError,
  type EvolutionApiConfig,
  type EvolutionApiClient,
} from "./evolutionApiClient";
export { INSTANCE_STATUS, mapConnectionState, type InstanceStatusValue } from "./instanceStatus";
export { getModel, type LlmConfig, type LlmProvider } from "./llm";
export { createTestQueue, TEST_QUEUE_NAME, type TestQueueJobData } from "./testQueue";
```

(The `testQueue` export is removed in Task 8. `InstanceStatus` is gone — nothing imported it outside the deleted test.)

- [ ] **Step 6: Fix the `apps/api` call site and health test**

In `apps/api/src/index.ts` — no change needed yet (it constructs the client but does not call `sendMessage`). Confirm by grep: `grep -rn "\.sendMessage\|getInstanceStatus" apps/` — the only hits are `apps/api/tests/health.test.ts`.

In `apps/api/tests/health.test.ts`, both `evolutionApi` fake objects: replace
```ts
      evolutionApi: {
        checkConnection: async () => true,
        getInstanceStatus: async () => ({ instanceName: "", state: "" }),
        sendMessage: async () => {},
      },
```
with
```ts
      evolutionApi: {
        checkConnection: async () => true,
        sendText: async () => ({ messageId: null }),
        createInstance: async () => {},
        connectInstance: async () => ({ qrcode: null, pairingCode: null }),
        deleteInstance: async () => {},
        fetchInstance: async () => null,
      } as never,
```

- [ ] **Step 7: Run all shared + api tests — expect pass**

Run: `pnpm --filter @fmagentes/shared test && pnpm --filter @fmagentes/api test`
Expected: PASS. Then `pnpm run build` — expect 5/5.

- [ ] **Step 8: Commit**

```bash
git add packages/shared apps/api/tests/health.test.ts
git commit -m "feat: expand evolutionApiClient with instance lifecycle methods"
```

---

### Task 3: `packages/messaging` — scaffold + `inbound-messages` queue

**Files:**
- Create: `packages/messaging/package.json`
- Create: `packages/messaging/tsconfig.json`
- Create: `packages/messaging/vitest.config.ts`
- Create: `packages/messaging/src/index.ts`
- Create: `packages/messaging/src/deps.ts`
- Create: `packages/messaging/src/inboundQueue.ts`
- Create: `packages/messaging/tests/inboundQueue.test.ts`

**Interfaces:**
- Consumes: `@fmagentes/shared` (`EvolutionApiClient`), `@supabase/supabase-js` (`SupabaseClient`), `bullmq` (`Queue`), `ioredis` (`Redis`).
- Produces:
  - `MessagingDeps` — `{ supabase: SupabaseClient; evolutionApi: EvolutionApiClient }`
  - `INBOUND_QUEUE_NAME` — `"inbound-messages"`
  - `InboundJobData` — `{ messageId: string; conversationId: string; instanceId: string }`
  - `createInboundQueue(connection: Redis): Queue<InboundJobData>`

- [ ] **Step 1: Create the package manifest and config**

`packages/messaging/package.json`:
```json
{
  "name": "@fmagentes/messaging",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fmagentes/shared": "workspace:*",
    "@supabase/supabase-js": "^2.45.4",
    "bullmq": "^5.13.2",
    "ioredis": "^5.4.1"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

`packages/messaging/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src", "tests"]
}
```

`packages/messaging/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
});
```

- [ ] **Step 2: Run `pnpm install` to link the workspace**

Run: `pnpm install`
Expected: exits 0; `@fmagentes/messaging` appears in the workspace.

- [ ] **Step 3: Write the failing queue test**

`packages/messaging/tests/inboundQueue.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";

const { QueueMock } = vi.hoisted(() => ({ QueueMock: vi.fn() }));
vi.mock("bullmq", () => ({ Queue: QueueMock }));

import { createInboundQueue, INBOUND_QUEUE_NAME } from "../src/inboundQueue";

describe("createInboundQueue", () => {
  it("creates a BullMQ Queue named inbound-messages with the connection", () => {
    const connection = { host: "localhost", port: 6379 };
    createInboundQueue(connection as never);
    expect(QueueMock).toHaveBeenCalledWith(INBOUND_QUEUE_NAME, { connection });
    expect(INBOUND_QUEUE_NAME).toBe("inbound-messages");
  });
});
```

- [ ] **Step 4: Run it — expect failure**

Run: `pnpm --filter @fmagentes/messaging exec vitest run tests/inboundQueue.test.ts`
Expected: FAIL — module `../src/inboundQueue` not found.

- [ ] **Step 5: Implement the modules**

`packages/messaging/src/deps.ts`:
```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";

export interface MessagingDeps {
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
}
```

`packages/messaging/src/inboundQueue.ts`:
```ts
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const INBOUND_QUEUE_NAME = "inbound-messages";

export interface InboundJobData {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

export function createInboundQueue(connection: Redis): Queue<InboundJobData> {
  return new Queue<InboundJobData>(INBOUND_QUEUE_NAME, { connection });
}
```

`packages/messaging/src/index.ts`:
```ts
export type { MessagingDeps } from "./deps";
export { INBOUND_QUEUE_NAME, createInboundQueue, type InboundJobData } from "./inboundQueue";
```

- [ ] **Step 6: Run it — expect pass**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/messaging pnpm-lock.yaml
git commit -m "feat: scaffold packages/messaging with inbound-messages queue"
```

---

### Task 4: `packages/messaging` — Evolution webhook event parsing

**Files:**
- Create: `packages/messaging/src/events.ts`
- Create: `packages/messaging/tests/events.test.ts`
- Modify: `packages/messaging/src/index.ts`

**Interfaces:**
- Produces:
  - `EvolutionWebhookEvent` — the discriminated union below
  - `parseEvolutionEvent(body: unknown): EvolutionWebhookEvent | null` — returns `null` for anything not recognised
  - Types: `InboundMessageEvent`, `ConnectionUpdateEvent`, `QrCodeUpdatedEvent`

- [ ] **Step 1: Write the failing tests**

`packages/messaging/tests/events.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { parseEvolutionEvent } from "../src/events";

const inbound = {
  event: "messages.upsert",
  instance: "acme",
  data: {
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false, id: "MSG1" },
    pushName: "Alice",
    message: { conversation: "hello" },
    messageTimestamp: 1719000000,
  },
};

describe("parseEvolutionEvent", () => {
  it("parses a text messages.upsert event", () => {
    const parsed = parseEvolutionEvent(inbound);
    expect(parsed).toEqual({
      type: "messages.upsert",
      instanceName: "acme",
      messageId: "MSG1",
      fromMe: false,
      contactPhone: "5511999998888",
      pushName: "Alice",
      text: "hello",
      timestamp: 1719000000,
    });
  });

  it("reads text from extendedTextMessage", () => {
    const evt = { ...inbound, data: { ...inbound.data, message: { extendedTextMessage: { text: "long one" } } } };
    expect(parseEvolutionEvent(evt)?.text).toBe("long one");
  });

  it("returns null text for a non-text message (e.g. image)", () => {
    const evt = { ...inbound, data: { ...inbound.data, message: { imageMessage: {} } } };
    expect(parseEvolutionEvent(evt)?.text).toBeNull();
  });

  it("marks fromMe messages", () => {
    const evt = { ...inbound, data: { ...inbound.data, key: { ...inbound.data.key, fromMe: true } } };
    expect(parseEvolutionEvent(evt)?.fromMe).toBe(true);
  });

  it("parses connection.update", () => {
    expect(parseEvolutionEvent({ event: "connection.update", instance: "acme", data: { state: "open" } })).toEqual({
      type: "connection.update",
      instanceName: "acme",
      state: "open",
    });
  });

  it("parses qrcode.updated", () => {
    expect(parseEvolutionEvent({ event: "qrcode.updated", instance: "acme", data: {} })).toEqual({
      type: "qrcode.updated",
      instanceName: "acme",
    });
  });

  it("returns null for unknown events and junk", () => {
    expect(parseEvolutionEvent({ event: "contacts.update", instance: "x", data: {} })).toBeNull();
    expect(parseEvolutionEvent("not json")).toBeNull();
    expect(parseEvolutionEvent({})).toBeNull();
    expect(parseEvolutionEvent({ event: "messages.upsert", instance: "x" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @fmagentes/messaging exec vitest run tests/events.test.ts`
Expected: FAIL — `../src/events` not found.

- [ ] **Step 3: Implement `events.ts`**

```ts
export interface InboundMessageEvent {
  type: "messages.upsert";
  instanceName: string;
  messageId: string;
  fromMe: boolean;
  contactPhone: string;
  pushName: string | null;
  text: string | null;
  timestamp: number | null;
}

export interface ConnectionUpdateEvent {
  type: "connection.update";
  instanceName: string;
  state: string;
}

export interface QrCodeUpdatedEvent {
  type: "qrcode.updated";
  instanceName: string;
}

export type EvolutionWebhookEvent = InboundMessageEvent | ConnectionUpdateEvent | QrCodeUpdatedEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jidToPhone(jid: unknown): string | null {
  if (typeof jid !== "string" || !jid.includes("@")) return null;
  return jid.split("@")[0];
}

function extractText(message: unknown): string | null {
  if (!isObject(message)) return null;
  if (typeof message.conversation === "string") return message.conversation;
  const ext = message.extendedTextMessage;
  if (isObject(ext) && typeof ext.text === "string") return ext.text;
  return null;
}

export function parseEvolutionEvent(body: unknown): EvolutionWebhookEvent | null {
  if (!isObject(body)) return null;
  const { event, instance, data } = body;
  if (typeof event !== "string" || typeof instance !== "string" || !isObject(data)) return null;

  if (event === "connection.update") {
    const state = isObject(data) && typeof data.state === "string" ? data.state : "unknown";
    return { type: "connection.update", instanceName: instance, state };
  }

  if (event === "qrcode.updated") {
    return { type: "qrcode.updated", instanceName: instance };
  }

  if (event === "messages.upsert") {
    const key = data.key;
    if (!isObject(key) || typeof key.id !== "string") return null;
    const phone = jidToPhone(key.remoteJid);
    if (!phone) return null;
    return {
      type: "messages.upsert",
      instanceName: instance,
      messageId: key.id,
      fromMe: key.fromMe === true,
      contactPhone: phone,
      pushName: typeof data.pushName === "string" ? data.pushName : null,
      text: extractText(data.message),
      timestamp: typeof data.messageTimestamp === "number" ? data.messageTimestamp : null,
    };
  }

  return null;
}
```

- [ ] **Step 4: Add the export**

Append to `packages/messaging/src/index.ts`:
```ts
export {
  parseEvolutionEvent,
  type EvolutionWebhookEvent,
  type InboundMessageEvent,
  type ConnectionUpdateEvent,
  type QrCodeUpdatedEvent,
} from "./events";
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/messaging
git commit -m "feat: parse Evolution webhook events in packages/messaging"
```

---

### Task 5: `packages/messaging` — `ingestInboundMessage`

**Files:**
- Create: `packages/messaging/src/ingestInboundMessage.ts`
- Create: `packages/messaging/tests/ingestInboundMessage.test.ts`
- Create: `packages/messaging/tests/support/supabaseMock.ts`
- Modify: `packages/messaging/src/index.ts`

**Interfaces:**
- Consumes: `MessagingDeps` (Task 3), `InboundMessageEvent` (Task 4).
- Produces:
  - `ingestInboundMessage(deps: MessagingDeps, event: InboundMessageEvent): Promise<IngestResult | null>`
  - `IngestResult` — `{ messageId: string; conversationId: string; instanceId: string }` (the persisted row's ids; shape matches `InboundJobData` so the route can enqueue it directly). Returns `null` if the instance is unknown, the message is a duplicate, or the event has no text.

- [ ] **Step 1: Write the Supabase mock helper**

`packages/messaging/tests/support/supabaseMock.ts`:
```ts
import { vi } from "vitest";

/**
 * Minimal chainable Supabase mock. `handlers` maps a table name to a function
 * that receives the recorded call chain and returns the `{ data, error }` the
 * final awaited call should resolve to.
 */
export type TableCall = { op: string; args: unknown[] }[];

export function createSupabaseMock(handlers: Record<string, (calls: TableCall) => { data: unknown; error: unknown }>) {
  return {
    from(table: string) {
      const calls: TableCall = [];
      const result = () => handlers[table]?.(calls) ?? { data: null, error: null };
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "insert", "upsert", "update", "delete", "eq", "order", "limit"]) {
        chain[op] = vi.fn((...args: unknown[]) => {
          calls.push({ op, args });
          return chain;
        });
      }
      chain.single = vi.fn(async () => result());
      chain.maybeSingle = vi.fn(async () => result());
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result());
      return chain;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`packages/messaging/tests/ingestInboundMessage.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { ingestInboundMessage } from "../src/ingestInboundMessage";
import type { InboundMessageEvent } from "../src/events";
import { createSupabaseMock } from "./support/supabaseMock";

const event: InboundMessageEvent = {
  type: "messages.upsert",
  instanceName: "acme",
  messageId: "MSG1",
  fromMe: false,
  contactPhone: "5511999998888",
  pushName: "Alice",
  text: "hello",
  timestamp: 1719000000,
};

const deps = (supabase: unknown) => ({ supabase, evolutionApi: {} } as never);

describe("ingestInboundMessage", () => {
  it("returns null when the instance is unknown", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: null, error: null }),
    });
    expect(await ingestInboundMessage(deps(supabase), event)).toBeNull();
  });

  it("returns null when the event has no text", async () => {
    const supabase = createSupabaseMock({ instances: () => ({ data: { id: "inst-1" }, error: null }) });
    expect(await ingestInboundMessage(deps(supabase), { ...event, text: null })).toBeNull();
  });

  it("persists a new message and returns its ids", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert")
          ? { data: null, error: null }
          : { data: { id: "conv-1" }, error: null },
      messages: () => ({ data: [{ id: "msg-1" }], error: null }),
    });

    const result = await ingestInboundMessage(deps(supabase), event);

    expect(result).toEqual({ messageId: "msg-1", conversationId: "conv-1", instanceId: "inst-1" });
  });

  it("returns null when the message already exists (idempotent upsert no-op)", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: { id: "inst-1" }, error: null }),
      conversations: (calls) =>
        calls.some((c) => c.op === "upsert") ? { data: null, error: null } : { data: { id: "conv-1" }, error: null },
      messages: () => ({ data: [], error: null }),
    });

    expect(await ingestInboundMessage(deps(supabase), event)).toBeNull();
  });

  it("throws when Supabase returns an error", async () => {
    const supabase = createSupabaseMock({
      instances: () => ({ data: null, error: { message: "db down" } }),
    });
    await expect(ingestInboundMessage(deps(supabase), event)).rejects.toThrow("db down");
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @fmagentes/messaging exec vitest run tests/ingestInboundMessage.test.ts`
Expected: FAIL — `../src/ingestInboundMessage` not found.

- [ ] **Step 4: Implement `ingestInboundMessage.ts`**

```ts
import type { MessagingDeps } from "./deps";
import type { InboundMessageEvent } from "./events";

export interface IngestResult {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

function assertNoError(error: unknown): void {
  if (error) {
    const message = typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "Supabase error";
    throw new Error(message);
  }
}

export async function ingestInboundMessage(
  deps: MessagingDeps,
  event: InboundMessageEvent,
): Promise<IngestResult | null> {
  if (event.text === null) return null;

  const instanceLookup = await deps.supabase
    .from("instances")
    .select("id")
    .eq("evolution_instance_id", event.instanceName)
    .maybeSingle();
  assertNoError(instanceLookup.error);
  const instanceId = (instanceLookup.data as { id: string } | null)?.id;
  if (!instanceId) return null;

  const upsertConv = await deps.supabase
    .from("conversations")
    .upsert(
      { instance_id: instanceId, contact_phone: event.contactPhone },
      { onConflict: "instance_id,contact_phone", ignoreDuplicates: true },
    );
  assertNoError(upsertConv.error);

  const convLookup = await deps.supabase
    .from("conversations")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("contact_phone", event.contactPhone)
    .single();
  assertNoError(convLookup.error);
  const conversationId = (convLookup.data as { id: string }).id;

  const insertMsg = await deps.supabase
    .from("messages")
    .upsert(
      {
        conversation_id: conversationId,
        direction: "in",
        role: "user",
        content: event.text,
        evolution_message_id: event.messageId,
        created_at: event.timestamp ? new Date(event.timestamp * 1000).toISOString() : undefined,
      },
      { onConflict: "evolution_message_id", ignoreDuplicates: true },
    )
    .select("id");
  assertNoError(insertMsg.error);

  const rows = (insertMsg.data as Array<{ id: string }> | null) ?? [];
  if (rows.length === 0) return null;

  await deps.supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { messageId: rows[0].id, conversationId, instanceId };
}
```

Note: the `.upsert(...)` calls that are awaited without `.select()` must still resolve `{ error }`. The mock's `then` handles this; real supabase-js `PostgrestFilterBuilder` is thenable too.

- [ ] **Step 5: Add the export**

Append to `packages/messaging/src/index.ts`:
```ts
export { ingestInboundMessage, type IngestResult } from "./ingestInboundMessage";
```

- [ ] **Step 6: Run — expect pass**

Run: `pnpm --filter @fmagentes/messaging test`
Expected: PASS (all messaging tests).

- [ ] **Step 7: Commit**

```bash
git add packages/messaging
git commit -m "feat: add ingestInboundMessage to packages/messaging"
```

---

### Task 6: `packages/messaging` — `sendMessage` (outbound)

**Files:**
- Create: `packages/messaging/src/sendMessage.ts`
- Create: `packages/messaging/tests/sendMessage.test.ts`
- Modify: `packages/messaging/src/index.ts`

**Interfaces:**
- Consumes: `MessagingDeps` (Task 3).
- Produces:
  - `sendMessage(deps: MessagingDeps, input: { conversationId: string; text: string }): Promise<SentMessage>`
  - `SentMessage` — `{ id: string; conversationId: string; direction: "out"; content: string; createdAt: string }`
  - `ConversationNotFoundError` (has `.conversationId`) — thrown when the conversation does not exist; the route maps it to 404. Evolution failures propagate as-is (route maps to 502).

- [ ] **Step 1: Write the failing tests**

`packages/messaging/tests/sendMessage.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { sendMessage, ConversationNotFoundError } from "../src/sendMessage";
import { createSupabaseMock } from "./support/supabaseMock";

function deps(overrides: { conversation?: unknown; sendText?: unknown; insertedRow?: unknown } = {}) {
  const supabase = createSupabaseMock({
    conversations: (calls) =>
      calls.some((c) => c.op === "update")
        ? { data: null, error: null }
        : { data: overrides.conversation === undefined
            ? { id: "conv-1", contact_phone: "5511999998888", instances: { evolution_instance_id: "acme" } }
            : overrides.conversation,
            error: null },
    messages: () => ({ data: overrides.insertedRow ?? { id: "msg-1", conversation_id: "conv-1", direction: "out", content: "hi", created_at: "2026-09-02T00:00:00Z" }, error: null }),
  });
  const evolutionApi = {
    sendText: overrides.sendText ?? vi.fn().mockResolvedValue({ messageId: "EVO1" }),
  };
  return { supabase, evolutionApi } as never;
}

describe("sendMessage", () => {
  it("sends via Evolution then persists the outbound row and bumps last_message_at", async () => {
    const d = deps();
    const result = await sendMessage(d, { conversationId: "conv-1", text: "hi" });

    expect(result).toEqual({
      id: "msg-1",
      conversationId: "conv-1",
      direction: "out",
      content: "hi",
      createdAt: "2026-09-02T00:00:00Z",
    });
    expect((d as never as { evolutionApi: { sendText: ReturnType<typeof vi.fn> } }).evolutionApi.sendText)
      .toHaveBeenCalledWith("acme", "5511999998888", "hi");
  });

  it("throws ConversationNotFoundError when the conversation is missing", async () => {
    await expect(sendMessage(deps({ conversation: null }), { conversationId: "nope", text: "hi" }))
      .rejects.toBeInstanceOf(ConversationNotFoundError);
  });

  it("propagates an Evolution failure and does not persist", async () => {
    const sendText = vi.fn().mockRejectedValue(new Error("evolution 500"));
    await expect(sendMessage(deps({ sendText }), { conversationId: "conv-1", text: "hi" }))
      .rejects.toThrow("evolution 500");
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @fmagentes/messaging exec vitest run tests/sendMessage.test.ts`
Expected: FAIL — `../src/sendMessage` not found.

- [ ] **Step 3: Implement `sendMessage.ts`**

```ts
import type { MessagingDeps } from "./deps";

export interface SentMessage {
  id: string;
  conversationId: string;
  direction: "out";
  content: string;
  createdAt: string;
}

export class ConversationNotFoundError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}

function assertNoError(error: unknown): void {
  if (error) {
    const message = typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "Supabase error";
    throw new Error(message);
  }
}

export async function sendMessage(
  deps: MessagingDeps,
  input: { conversationId: string; text: string },
): Promise<SentMessage> {
  const lookup = await deps.supabase
    .from("conversations")
    .select("id, contact_phone, instances(evolution_instance_id)")
    .eq("id", input.conversationId)
    .maybeSingle();
  assertNoError(lookup.error);

  const conv = lookup.data as
    | { id: string; contact_phone: string; instances: { evolution_instance_id: string } | null }
    | null;
  if (!conv || !conv.instances) throw new ConversationNotFoundError(input.conversationId);

  const sent = await deps.evolutionApi.sendText(
    conv.instances.evolution_instance_id,
    conv.contact_phone,
    input.text,
  );

  const insert = await deps.supabase
    .from("messages")
    .insert({
      conversation_id: conv.id,
      direction: "out",
      role: "assistant",
      content: input.text,
      evolution_message_id: sent.messageId,
    })
    .select("id, conversation_id, direction, content, created_at")
    .single();
  assertNoError(insert.error);

  const row = insert.data as { id: string; conversation_id: string; direction: "out"; content: string; created_at: string };

  await deps.supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conv.id);

  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: "out",
    content: row.content,
    createdAt: row.created_at,
  };
}
```

- [ ] **Step 4: Add the export**

Append to `packages/messaging/src/index.ts`:
```ts
export { sendMessage, ConversationNotFoundError, type SentMessage } from "./sendMessage";
```

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @fmagentes/messaging test && pnpm run build`
Expected: PASS; build 6/6 (messaging now builds too).

- [ ] **Step 6: Commit**

```bash
git add packages/messaging
git commit -m "feat: add outbound sendMessage to packages/messaging"
```

---

### Task 7: `apps/api` — webhook secret + config plumbing

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/.env.example`
- Modify: `apps/api/src/app.ts` (add `config` to `AppDependencies`)
- Modify: `apps/api/src/index.ts` (pass `config`)
- Modify: `apps/api/tests/health.test.ts`, `apps/api/tests/webhooks.test.ts`, `apps/api/tests/testQueue.test.ts` (add `config` to fake deps)

**Interfaces:**
- Produces: `AppDependencies.config` — `{ webhookSecret: string; publicWebhookUrl: string }`. Every route registered in `buildApp` can read `deps.config`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/tests/webhooks.test.ts` a new case (keep the existing `fakeDeps` but extend it — see Step 3):
```ts
it("rejects a request whose apikey header does not match the webhook secret", async () => {
  const app = buildApp(fakeDeps());
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/evolution",
    headers: { apikey: "wrong" },
    payload: { event: "messages.upsert", instance: "x", data: {} },
  });
  expect(response.statusCode).toBe(401);
  await app.close();
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @fmagentes/api exec vitest run tests/webhooks.test.ts`
Expected: FAIL — the current handler returns 200, and `fakeDeps` has no `config`.

- [ ] **Step 3: Add the env vars**

`apps/api/src/env.ts` — add to the schema:
```ts
  WEBHOOK_SECRET: z.string().min(1),
  PUBLIC_WEBHOOK_URL: z.string().url(),
```

`apps/api/.env.example` — append:
```
WEBHOOK_SECRET=
PUBLIC_WEBHOOK_URL=
```

- [ ] **Step 4: Thread `config` through `AppDependencies`**

`apps/api/src/app.ts` — extend the interface:
```ts
export interface AppConfig {
  webhookSecret: string;
  publicWebhookUrl: string;
}

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  testQueue: Queue;
  config: AppConfig;
}
```

`apps/api/src/index.ts` — pass it when calling `buildApp`:
```ts
const app = buildApp({
  redis,
  supabase,
  evolutionApi,
  testQueue,
  config: { webhookSecret: env.WEBHOOK_SECRET, publicWebhookUrl: env.PUBLIC_WEBHOOK_URL },
});
```

- [ ] **Step 5: Update the webhook route to check the secret**

`apps/api/src/routes/webhooks.ts` — change the signature to receive deps and check the header:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerWebhookRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    if (request.headers.apikey !== deps.config.webhookSecret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    app.log.info({ body: request.body }, "Received Evolution API webhook");
    return reply.code(200).send({ received: true });
  });
}
```

`apps/api/src/app.ts` — update the call: `registerWebhookRoute(app, deps);`

- [ ] **Step 6: Fix every fake-deps object in the api tests**

In `apps/api/tests/health.test.ts`, `apps/api/tests/webhooks.test.ts`, `apps/api/tests/testQueue.test.ts`: add to each `AppDependencies` / `fakeDeps` object:
```ts
  config: { webhookSecret: "test-secret", publicWebhookUrl: "https://cb.example.com" },
```
In `apps/api/tests/webhooks.test.ts` the existing "well-formed payload" and "malformed JSON" tests must now send `headers: { apikey: "test-secret" }`.

- [ ] **Step 7: Run — expect pass**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api
git commit -m "feat: add webhook secret verification and config plumbing to api"
```

---

### Task 8: Replace `test-queue` with `inbound-messages`

**Files:**
- Delete: `packages/shared/src/testQueue.ts`, `packages/shared/tests/testQueue.test.ts`
- Delete: `apps/api/src/routes/testQueue.ts`, `apps/api/tests/testQueue.test.ts`
- Delete: `apps/worker/src/testQueueProcessor.ts`, `apps/worker/tests/testQueueProcessor.test.ts`
- Modify: `packages/shared/src/index.ts` (drop testQueue export)
- Create: `apps/worker/src/inboundProcessor.ts`, `apps/worker/tests/inboundProcessor.test.ts`
- Modify: `apps/worker/src/index.ts`, `apps/worker/package.json`
- Modify: `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/package.json`
- Modify: `apps/api/tests/health.test.ts`, `apps/api/tests/webhooks.test.ts`

**Interfaces:**
- Consumes: `INBOUND_QUEUE_NAME`, `InboundJobData`, `createInboundQueue` from `@fmagentes/messaging` (Task 3).
- Produces:
  - `AppDependencies.inboundQueue: Queue<InboundJobData>` (replaces `testQueue`)
  - `processInboundJob(job: Job<InboundJobData>): Promise<{ ok: true }>` — stub that logs and returns.

- [ ] **Step 1: Add `@fmagentes/messaging` as a dependency**

`apps/api/package.json` and `apps/worker/package.json` — add to `dependencies`:
```json
    "@fmagentes/messaging": "workspace:*",
```
Run: `pnpm install`

- [ ] **Step 2: Write the failing worker test**

`apps/worker/tests/inboundProcessor.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";
import { processInboundJob } from "../src/inboundProcessor";

describe("processInboundJob", () => {
  it("logs the message id and returns ok", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = { id: "j1", data: { messageId: "m1", conversationId: "c1", instanceId: "i1" } } as Job<InboundJobData>;

    const result = await processInboundJob(job);

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("m1"));
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @fmagentes/worker exec vitest run tests/inboundProcessor.test.ts`
Expected: FAIL — `../src/inboundProcessor` not found.

- [ ] **Step 4: Implement the worker side**

Create `apps/worker/src/inboundProcessor.ts`:
```ts
import type { Job } from "bullmq";
import type { InboundJobData } from "@fmagentes/messaging";

export async function processInboundJob(job: Job<InboundJobData>): Promise<{ ok: true }> {
  console.log(`[worker] inbound job ${job.id} for message ${job.data.messageId} (conversation ${job.data.conversationId})`);
  return { ok: true };
}
```

Replace `apps/worker/src/index.ts`:
```ts
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { INBOUND_QUEUE_NAME } from "@fmagentes/messaging";
import { loadEnv } from "./env";
import { processInboundJob } from "./inboundProcessor";

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(INBOUND_QUEUE_NAME, processInboundJob, { connection });

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

console.log("[worker] listening for jobs on", INBOUND_QUEUE_NAME);
```

Delete `apps/worker/src/testQueueProcessor.ts` and `apps/worker/tests/testQueueProcessor.test.ts`.

- [ ] **Step 5: Implement the api side**

Delete `apps/api/src/routes/testQueue.ts` and `apps/api/tests/testQueue.test.ts`.

`apps/api/src/app.ts`:
- imports: drop `registerTestQueueRoute`, drop `import type { Queue } from "bullmq"`, add `import type { Queue } from "bullmq"` is still needed — keep it, change the field.
- `AppDependencies`: replace `testQueue: Queue;` with `inboundQueue: Queue<InboundJobData>;` and add `import type { InboundJobData } from "@fmagentes/messaging";`
- remove the `if (request.routeOptions.url === "/webhooks/evolution")` branch from `setErrorHandler` entirely — the handler becomes:
```ts
  app.setErrorHandler((error, _request, reply) => {
    reply.send(error);
  });
```
- remove the `registerTestQueueRoute(app, deps);` line.

`apps/api/src/index.ts`:
```ts
import { Redis } from "ioredis";
import { createSupabaseClient, createEvolutionApiClient } from "@fmagentes/shared";
import { createInboundQueue } from "@fmagentes/messaging";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const supabase = createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
const evolutionApi = createEvolutionApiClient({ baseUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY });
const inboundQueue = createInboundQueue(redis);

const app = buildApp({
  redis,
  supabase,
  evolutionApi,
  inboundQueue,
  config: { webhookSecret: env.WEBHOOK_SECRET, publicWebhookUrl: env.PUBLIC_WEBHOOK_URL },
});

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
```

- [ ] **Step 6: Drop the `testQueue` export from shared**

`packages/shared/src/index.ts` — remove the line:
```ts
export { createTestQueue, TEST_QUEUE_NAME, type TestQueueJobData } from "./testQueue";
```
Delete `packages/shared/src/testQueue.ts` and `packages/shared/tests/testQueue.test.ts`.

- [ ] **Step 7: Fix the remaining api test fakes**

In `apps/api/tests/health.test.ts` and `apps/api/tests/webhooks.test.ts`: replace `testQueue: { add: async () => ({ id: "1" }) } as never,` with `inboundQueue: { add: async () => ({ id: "1" }) } as never,`.

Also in `apps/api/tests/webhooks.test.ts`, **delete** the `"returns 200 even for a malformed JSON payload, to avoid webhook retries"` test case — it depended on the error-handler special-case just removed, and Task 9 re-adds a proper version. After this deletion `webhooks.test.ts` has only the well-formed-payload test (with `apikey` header) and the 401 test from Task 7.

- [ ] **Step 8: Run the whole suite + build**

Run: `pnpm run build && pnpm run test`
Expected: build 6/6; every package's tests PASS. Grep to confirm no stragglers: `grep -rn "testQueue\|TestQueue\|test-queue\|test/enqueue" apps packages --include=*.ts` → no matches.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: replace test-queue scaffolding with inbound-messages queue"
```

---

### Task 9: `apps/api` — real webhook route

**Files:**
- Modify: `apps/api/src/routes/webhooks.ts`
- Rewrite: `apps/api/tests/webhooks.test.ts`
- Create: `apps/api/tests/fixtures/messages-upsert.json`, `apps/api/tests/fixtures/connection-update.json`, `apps/api/tests/fixtures/qrcode-updated.json`

**Interfaces:**
- Consumes: `parseEvolutionEvent`, `ingestInboundMessage` from `@fmagentes/messaging`; `mapConnectionState`, `INSTANCE_STATUS` from `@fmagentes/shared`; `deps.inboundQueue`, `deps.supabase`, `deps.evolutionApi`, `deps.config`.
- Produces: the finished `POST /webhooks/evolution` behaviour (spec §"Inbound message"). No new exports.

- [ ] **Step 1: Create the fixtures**

`apps/api/tests/fixtures/messages-upsert.json`:
```json
{
  "event": "messages.upsert",
  "instance": "acme",
  "data": {
    "key": { "remoteJid": "5511999998888@s.whatsapp.net", "fromMe": false, "id": "3EB0C767D26A1D853909" },
    "pushName": "Alice",
    "message": { "conversation": "Olá, tudo bem?" },
    "messageType": "conversation",
    "messageTimestamp": 1725240000
  }
}
```

`apps/api/tests/fixtures/connection-update.json`:
```json
{ "event": "connection.update", "instance": "acme", "data": { "instance": "acme", "state": "open", "statusReason": 200 } }
```

`apps/api/tests/fixtures/qrcode-updated.json`:
```json
{ "event": "qrcode.updated", "instance": "acme", "data": { "qrcode": { "code": "2@abc", "base64": "data:image/png;base64,AAAA" } } }
```

- [ ] **Step 2: Rewrite `apps/api/tests/webhooks.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { ingestMock } = vi.hoisted(() => ({ ingestMock: vi.fn() }));

vi.mock("@fmagentes/messaging", async (importActual) => ({
  ...(await importActual<typeof import("@fmagentes/messaging")>()),
  ingestInboundMessage: ingestMock,
}));

import { buildApp, type AppDependencies } from "../src/app";

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", `${name}.json`), "utf8"));

function deps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    redis: {} as never,
    supabase: { from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }) } as never,
    evolutionApi: { fetchInstance: async () => ({ state: "open", number: "5511988887777" }) } as never,
    inboundQueue: { add: vi.fn().mockResolvedValue({ id: "job-1" }) } as never,
    config: { webhookSecret: "s3cr3t", publicWebhookUrl: "https://cb.example.com" },
    ...overrides,
  };
}

const post = (app: ReturnType<typeof buildApp>, payload: unknown, apikey = "s3cr3t") =>
  app.inject({ method: "POST", url: "/webhooks/evolution", headers: { apikey }, payload });

beforeEach(() => ingestMock.mockReset());

describe("POST /webhooks/evolution", () => {
  it("401 when the apikey header is missing or wrong", async () => {
    const app = buildApp(deps());
    expect((await post(app, {}, "nope")).statusCode).toBe(401);
    await app.close();
  });

  it("200 and enqueues a job for a new inbound text message", async () => {
    ingestMock.mockResolvedValue({ messageId: "m1", conversationId: "c1", instanceId: "i1" });
    const d = deps();
    const app = buildApp(d);

    const response = await post(app, fixture("messages-upsert"));

    expect(response.statusCode).toBe(200);
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).toHaveBeenCalledWith(
      "inbound-messages",
      { messageId: "m1", conversationId: "c1", instanceId: "i1" },
    );
    await app.close();
  });

  it("200 and does NOT enqueue when ingest returns null (duplicate / unknown instance)", async () => {
    ingestMock.mockResolvedValue(null);
    const d = deps();
    const app = buildApp(d);

    const response = await post(app, fixture("messages-upsert"));

    expect(response.statusCode).toBe(200);
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 and ignores a fromMe message without calling ingest or the queue", async () => {
    const d = deps();
    const app = buildApp(d);
    const payload = fixture("messages-upsert");
    payload.data.key.fromMe = true;

    expect((await post(app, payload)).statusCode).toBe(200);
    expect(ingestMock).not.toHaveBeenCalled();
    expect((d.inboundQueue as never as { add: ReturnType<typeof vi.fn> }).add).not.toHaveBeenCalled();
    await app.close();
  });

  it("200 for an unknown event type", async () => {
    const app = buildApp(deps());
    expect((await post(app, { event: "contacts.update", instance: "acme", data: {} })).statusCode).toBe(200);
    await app.close();
  });

  it("200 for an unparseable payload", async () => {
    const app = buildApp(deps());
    expect((await post(app, "{not json", "s3cr3t")).statusCode).toBe(200);
    await app.close();
  });

  it("updates instance status on connection.update", async () => {
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) });
    const d = deps({ supabase: { from: () => ({ update }) } as never });
    const app = buildApp(d);

    const response = await post(app, fixture("connection-update"));

    expect(response.statusCode).toBe(200);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ status: "connected", phone_number: "5511988887777" }));
    await app.close();
  });

  it("500 when ingest throws (transient failure → Evolution retries)", async () => {
    ingestMock.mockRejectedValue(new Error("db down"));
    const app = buildApp(deps());

    expect((await post(app, fixture("messages-upsert"))).statusCode).toBe(500);
    await app.close();
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @fmagentes/api exec vitest run tests/webhooks.test.ts`
Expected: FAIL — current handler only checks the secret and logs.

- [ ] **Step 4: Make JSON body-parse failures non-fatal**

So a malformed webhook payload reaches the handler (which returns 200) instead of
tripping Fastify's default 400. In `apps/api/src/app.ts`, right after
`const app = Fastify({ logger: true });`, add:

```ts
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : undefined);
    } catch {
      done(null, undefined);
    }
  });
```

This is global; other routes that expect a JSON body simply see `undefined` and
fall through to their own validation (e.g. `POST /instances` → 400 "name is
required"), which is the desired behaviour.

- [ ] **Step 5: Implement the route**

Replace `apps/api/src/routes/webhooks.ts`:
```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";
import { parseEvolutionEvent, ingestInboundMessage } from "@fmagentes/messaging";
import { mapConnectionState, INSTANCE_STATUS } from "@fmagentes/shared";

export function registerWebhookRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    if (request.headers.apikey !== deps.config.webhookSecret) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const event = parseEvolutionEvent(request.body);
    if (!event) {
      app.log.info("Ignoring unrecognised Evolution webhook event");
      return reply.code(200).send({ received: false });
    }

    try {
      if (event.type === "messages.upsert") {
        if (event.fromMe) return reply.code(200).send({ received: true });

        const ingested = await ingestInboundMessage(deps, event);
        if (ingested) {
          await deps.inboundQueue.add("inbound-messages", ingested);
        }
        return reply.code(200).send({ received: true });
      }

      if (event.type === "connection.update") {
        const status = mapConnectionState(event.state);
        const patch: Record<string, unknown> = { status };
        if (status === INSTANCE_STATUS.CONNECTED) {
          const info = await deps.evolutionApi.fetchInstance(event.instanceName);
          if (info?.number) patch.phone_number = info.number;
        }
        await deps.supabase.from("instances").update(patch).eq("evolution_instance_id", event.instanceName);
        return reply.code(200).send({ received: true });
      }

      // qrcode.updated — acknowledged; GET /instances/:id/qr fetches fresh QR on demand.
      app.log.info({ instance: event.instanceName }, "qrcode.updated");
      return reply.code(200).send({ received: true });
    } catch (error) {
      app.log.error({ err: error }, "Webhook processing failed");
      return reply.code(500).send({ received: false });
    }
  });
}
```

- [ ] **Step 6: Run — expect pass**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat: real Evolution webhook processing (parse, persist, enqueue, status sync)"
```

---

### Task 10: `apps/api` — instance lifecycle routes

**Files:**
- Create: `apps/api/src/routes/instances.ts`
- Create: `apps/api/tests/instances.test.ts`
- Modify: `apps/api/src/app.ts` (register the routes)

**Interfaces:**
- Consumes: `deps.supabase`, `deps.evolutionApi`, `deps.config.publicWebhookUrl`; `INSTANCE_STATUS` and `EvolutionApiError` from `@fmagentes/shared`.
- Produces: `registerInstanceRoutes(app: FastifyInstance, deps: AppDependencies): void`, wired in `buildApp`.

- [ ] **Step 1: Write the failing tests**

`apps/api/tests/instances.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

function deps(over: {
  createInstance?: unknown; deleteInstance?: unknown; connectInstance?: unknown;
  rows?: Record<string, unknown>;
} = {}): AppDependencies {
  const rows = over.rows ?? {};
  return {
    redis: {} as never,
    supabase: {
      from: (table: string) => ({
        insert: (payload: Record<string, unknown>) => ({
          select: () => ({ single: async () => ({ data: { id: "inst-1", ...payload }, error: null }) }),
        }),
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null, error: null }) }),
          order: () => ({ then: (r: (v: unknown) => unknown) => r({ data: [rows[table] ?? {}], error: null }) }),
        }),
        update: () => ({ eq: async () => ({ error: null }) }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
    } as never,
    evolutionApi: {
      createInstance: over.createInstance ?? vi.fn().mockResolvedValue(undefined),
      connectInstance: over.connectInstance ?? vi.fn().mockResolvedValue({ qrcode: "data:img", pairingCode: "AB-12" }),
      deleteInstance: over.deleteInstance ?? vi.fn().mockResolvedValue(undefined),
      fetchInstance: vi.fn(),
      sendText: vi.fn(),
      checkConnection: vi.fn(),
    } as never,
    inboundQueue: { add: vi.fn() } as never,
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com" },
  };
}

describe("instance routes", () => {
  it("POST /instances creates in Evolution with the webhook config, then persists the row", async () => {
    const createInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ createInstance });
    const app = buildApp(d);

    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" } });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "inst-1", name: "acme", evolution_instance_id: "acme", status: "created" });
    expect(createInstance).toHaveBeenCalledWith("acme", {
      url: "https://cb.example.com/webhooks/evolution",
      events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    });
    await app.close();
  });

  it("POST /instances returns 502 and writes no row when Evolution fails", async () => {
    const app = buildApp(deps({ createInstance: vi.fn().mockRejectedValue(new Error("evo down")) }));
    const response = await app.inject({ method: "POST", url: "/instances", payload: { name: "acme" } });
    expect(response.statusCode).toBe(502);
    await app.close();
  });

  it("POST /instances returns 400 when name is missing", async () => {
    const app = buildApp(deps());
    expect((await app.inject({ method: "POST", url: "/instances", payload: {} })).statusCode).toBe(400);
    await app.close();
  });

  it("GET /instances/:id returns 404 when absent", async () => {
    const app = buildApp(deps({ rows: {} }));
    expect((await app.inject({ method: "GET", url: "/instances/inst-x" })).statusCode).toBe(404);
    await app.close();
  });

  it("GET /instances/:id/qr connects and returns the qr payload, setting status=connecting", async () => {
    const connectInstance = vi.fn().mockResolvedValue({ qrcode: "data:img", pairingCode: "AB-12" });
    const d = deps({ connectInstance, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "GET", url: "/instances/inst-1/qr" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ qrcode: "data:img", pairingCode: "AB-12" });
    expect(connectInstance).toHaveBeenCalledWith("acme");
    await app.close();
  });

  it("DELETE /instances/:id deletes in Evolution then removes the row", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const d = deps({ deleteInstance, rows: { instances: { id: "inst-1", evolution_instance_id: "acme" } } });
    const app = buildApp(d);

    const response = await app.inject({ method: "DELETE", url: "/instances/inst-1" });

    expect(response.statusCode).toBe(204);
    expect(deleteInstance).toHaveBeenCalledWith("acme");
    await app.close();
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @fmagentes/api exec vitest run tests/instances.test.ts`
Expected: FAIL — routes not registered (404s everywhere).

- [ ] **Step 3: Implement `apps/api/src/routes/instances.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";
import { INSTANCE_STATUS } from "@fmagentes/shared";

const WEBHOOK_EVENTS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"];

export function registerInstanceRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/instances", async (request, reply) => {
    const body = request.body as { name?: unknown } | null;
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return reply.code(400).send({ error: "name is required" });

    try {
      await deps.evolutionApi.createInstance(name, {
        url: `${deps.config.publicWebhookUrl}/webhooks/evolution`,
        events: WEBHOOK_EVENTS,
      });
    } catch (error) {
      app.log.error({ err: error }, "Evolution createInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }

    const { data, error } = await deps.supabase
      .from("instances")
      .insert({ name, evolution_instance_id: name, status: INSTANCE_STATUS.CREATED })
      .select("*")
      .single();
    if (error) return reply.code(500).send({ error: "persist failed" });
    return reply.code(201).send(data);
  });

  app.get("/instances", async () => {
    const { data } = await deps.supabase.from("instances").select("*").order("created_at", { ascending: false });
    return data ?? [];
  });

  app.get("/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data } = await deps.supabase.from("instances").select("*").eq("id", id).maybeSingle();
    if (!data) return reply.code(404).send({ error: "not found" });
    return data;
  });

  app.get("/instances/:id/qr", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data } = await deps.supabase.from("instances").select("id, evolution_instance_id").eq("id", id).maybeSingle();
    if (!data) return reply.code(404).send({ error: "not found" });
    const row = data as { evolution_instance_id: string };

    try {
      const qr = await deps.evolutionApi.connectInstance(row.evolution_instance_id);
      await deps.supabase.from("instances").update({ status: INSTANCE_STATUS.CONNECTING }).eq("id", id);
      return reply.code(200).send(qr);
    } catch (error) {
      app.log.error({ err: error }, "Evolution connectInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }
  });

  app.delete("/instances/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { data } = await deps.supabase.from("instances").select("id, evolution_instance_id").eq("id", id).maybeSingle();
    if (!data) return reply.code(404).send({ error: "not found" });
    const row = data as { evolution_instance_id: string };

    try {
      await deps.evolutionApi.deleteInstance(row.evolution_instance_id);
    } catch (error) {
      app.log.error({ err: error }, "Evolution deleteInstance failed");
      return reply.code(502).send({ error: "evolution unavailable" });
    }

    await deps.supabase.from("instances").delete().eq("id", id);
    return reply.code(204).send();
  });
}
```

- [ ] **Step 4: Register in `apps/api/src/app.ts`**

Add `import { registerInstanceRoutes } from "./routes/instances";` and, after `registerWebhookRoute(app, deps);`, add `registerInstanceRoutes(app, deps);`.

- [ ] **Step 5: Run — expect pass**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat: instance lifecycle routes (create, list, get, qr, delete)"
```

---

### Task 11: `apps/api` — outbound message route

**Files:**
- Create: `apps/api/src/routes/conversations.ts`
- Create: `apps/api/tests/conversations.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: `sendMessage`, `ConversationNotFoundError` from `@fmagentes/messaging`; `deps`.
- Produces: `registerConversationRoutes(app: FastifyInstance, deps: AppDependencies): void`.

- [ ] **Step 1: Write the failing tests**

`apps/api/tests/conversations.test.ts`:
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, ConversationNotFoundError } = vi.hoisted(() => {
  class ConversationNotFoundError extends Error {
    constructor(public readonly conversationId: string) {
      super("not found");
      this.name = "ConversationNotFoundError";
    }
  }
  return { sendMock: vi.fn(), ConversationNotFoundError };
});

vi.mock("@fmagentes/messaging", async (importActual) => ({
  ...(await importActual<typeof import("@fmagentes/messaging")>()),
  sendMessage: sendMock,
  ConversationNotFoundError,
}));

import { buildApp, type AppDependencies } from "../src/app";

function baseDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    inboundQueue: { add: vi.fn() } as never,
    config: { webhookSecret: "s", publicWebhookUrl: "https://cb.example.com" },
  };
}

const send = (app: ReturnType<typeof buildApp>, payload: unknown, id = "c1") =>
  app.inject({ method: "POST", url: `/conversations/${id}/messages`, payload });

beforeEach(() => sendMock.mockReset());

describe("POST /conversations/:id/messages", () => {
  it("201 with the sent row on success", async () => {
    sendMock.mockResolvedValue({ id: "m1", conversationId: "c1", direction: "out", content: "hi", createdAt: "2026-09-02T00:00:00Z" });
    const app = buildApp(baseDeps());

    const response = await send(app, { text: "hi" });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: "m1", direction: "out", content: "hi" });
    await app.close();
  });

  it("400 when text is missing or empty", async () => {
    const app = buildApp(baseDeps());
    expect((await send(app, {})).statusCode).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 when the conversation does not exist", async () => {
    sendMock.mockRejectedValue(new ConversationNotFoundError("c1"));
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "hi" })).statusCode).toBe(404);
    await app.close();
  });

  it("502 when Evolution send fails", async () => {
    sendMock.mockRejectedValue(new Error("evolution 500"));
    const app = buildApp(baseDeps());
    expect((await send(app, { text: "hi" })).statusCode).toBe(502);
    await app.close();
  });
});
```

Note: `ConversationNotFoundError` is redefined inside `vi.hoisted` (the mock replaces the module's copy too, so `instanceof` in the route matches this class). The route imports the name from `@fmagentes/messaging`, which the mock overrides with this same class — they are identical references.

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @fmagentes/api exec vitest run tests/conversations.test.ts`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement `apps/api/src/routes/conversations.ts`**

```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";
import { sendMessage, ConversationNotFoundError } from "@fmagentes/messaging";

export function registerConversationRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { text?: unknown } | null;
    const text = body && typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return reply.code(400).send({ error: "text is required" });

    try {
      const sent = await sendMessage(deps, { conversationId: id, text });
      return reply.code(201).send(sent);
    } catch (error) {
      if (error instanceof ConversationNotFoundError) {
        return reply.code(404).send({ error: "conversation not found" });
      }
      app.log.error({ err: error }, "Outbound send failed");
      return reply.code(502).send({ error: "send failed" });
    }
  });
}
```

- [ ] **Step 4: Register in `apps/api/src/app.ts`**

Add `import { registerConversationRoutes } from "./routes/conversations";` and `registerConversationRoutes(app, deps);` after the instance routes.

- [ ] **Step 5: Run the whole suite + build**

Run: `pnpm run build && pnpm run test`
Expected: build 6/6; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "feat: outbound message route POST /conversations/:id/messages"
```

---

### Task 12: Integration verification + docs

**Files:**
- Modify: `docs/ROADMAP.md`
- Modify: `apps/api/.env` (local only — not committed)

**Interfaces:** none — verification only.

- [ ] **Step 1: Full build + test**

Run: `pnpm install && pnpm run build && pnpm run test`
Expected: build 6/6; every package green. Record the test count.

- [ ] **Step 2: Boot the stack**

Run: `docker compose up -d` then `pnpm run dev`.
Set `WEBHOOK_SECRET` and `PUBLIC_WEBHOOK_URL` in `apps/api/.env` first (any values for local boot).
Expected: api, worker, dashboard start clean; `curl localhost:3001/health` → all three `connected`.

- [ ] **Step 3: Local webhook smoke test with a fixture**

Run:
```bash
curl -s -X POST http://localhost:3001/webhooks/evolution \
  -H "apikey: $WEBHOOK_SECRET" -H "content-type: application/json" \
  --data @apps/api/tests/fixtures/messages-upsert.json
```
Expected: `{"received":true}`; the worker logs `[worker] inbound job <id> for message <id>`; a row appears in `messages` (check via `mcp__plugin_supabase_supabase__execute_sql` — `select * from messages order by created_at desc limit 1`). Requires an `instances` row with `evolution_instance_id = 'acme'` — insert one first via `POST /instances` (needs a reachable tunnel) or directly:
```sql
insert into instances (name, evolution_instance_id, status) values ('acme', 'acme', 'created');
```

- [ ] **Step 4: Manual tunnel smoke test (one-time, recorded not automated)**

Start a tunnel (`cloudflared tunnel --url http://localhost:3001` or `ngrok http 3001`), set `PUBLIC_WEBHOOK_URL` to the tunnel URL, restart the api, `POST /instances { "name": "<real>" }`, scan the QR from `GET /instances/:id/qr`, send a WhatsApp message to that number, and confirm: a `messages` row (`direction='in'`), an `inbound-messages` job in the worker log, and `GET /instances/:id` showing `status='connected'` with `phone_number` populated. Record the outcome (pass/fail + notes) in the commit message for Step 6.

- [ ] **Step 5: Tear down**

Run: stop `pnpm run dev`, `docker compose down`, stop the tunnel, `DELETE /instances/:id` for the test instance (or `delete from instances where evolution_instance_id = 'acme'`).

- [ ] **Step 6: Update the roadmap and commit**

In `docs/ROADMAP.md`, change the sub-project 2 status cell to `✅ Complete (merged <hash>, <date>)` and move its "carry-over" / "seams" prose into a short "delivered" note. Then:
```bash
git add docs/ROADMAP.md
git commit -m "docs: mark sub-project 2 (Evolution API integration) complete"
```

---

## Self-Review

**Spec coverage:**
- Shared-secret webhook auth → Task 7 (plumbing) + Task 9 (enforced in the real handler). ✅
- `messages.upsert` → persist + enqueue → Tasks 5, 9. ✅
- `connection.update` → status + phone sync → Task 9 (uses `mapConnectionState` + `fetchInstance` from Task 2). ✅
- `qrcode.updated` → acknowledged → Task 9. ✅
- Idempotency on `evolution_message_id` → Task 1 (constraint) + Task 5 (`ignoreDuplicates` upsert). ✅
- Find-or-create conversation, race-free → Task 1 (constraint) + Task 5. ✅
- Instance lifecycle API (create/list/get/qr/delete) → Task 10. ✅
- `POST /instances` registers webhook URL + 3 events → Task 10 (`WEBHOOK_EVENTS`, `publicWebhookUrl`). ✅
- Outbound `POST /conversations/:id/messages` → Task 11 + Task 6 (`sendMessage`). ✅
- `packages/messaging` with injected deps → Tasks 3–6. ✅
- `inbound-messages` queue + stub worker → Tasks 3, 8. ✅
- Delete all `test-queue` code → Task 8. ✅
- Debt fix: error handler no longer force-200s webhook → Task 8. ✅
- Debt fix: `encodeURIComponent` path params → Task 2. ✅
- Env: `WEBHOOK_SECRET`, `PUBLIC_WEBHOOK_URL`, zod, `.env.example` → Task 7. ✅
- Fixture-driven webhook tests, no live Evolution → Task 9. ✅
- `messages` conventions (`in`/`user`, `out`/`assistant`) → Tasks 5, 6. ✅
- `instances.status` vocabulary constant → Task 2. ✅
- Migration `0003_messaging.sql` → Task 1. ✅
- Manual tunnel smoke test recorded → Task 12. ✅

**Placeholder scan:** No "TBD"/"handle appropriately"/"similar to". Every code step has real code. Fixtures are spelled out.

**Type consistency:**
- `sendText` returns `{ messageId: string | null }` — defined Task 2, consumed Task 6. ✅
- `ingestInboundMessage` returns `IngestResult | null` where `IngestResult = { messageId, conversationId, instanceId }` — Task 5 — matches `InboundJobData` (Task 3) so Task 9 enqueues it directly. ✅
- `MessagingDeps` = `{ supabase, evolutionApi }` — Task 3 — used unchanged in Tasks 5, 6, 9, 11. Note: Task 9/11 pass the api's full `AppDependencies` where `sendMessage`/`ingestInboundMessage` expect `MessagingDeps`; `AppDependencies` is a structural superset (`supabase` + `evolutionApi` present), so this type-checks. ✅
- `AppDependencies`: `testQueue` (Fundação) → `config` added Task 7 → `testQueue` replaced by `inboundQueue: Queue<InboundJobData>` Task 8. Every test fake updated in the same tasks. ✅
- `mapConnectionState` / `INSTANCE_STATUS` — Task 2 — consumed Tasks 9, 10. ✅
- `ConversationNotFoundError` — Task 6 — consumed Task 11. ✅
- `parseEvolutionEvent` returns `EvolutionWebhookEvent | null` with discriminant `type` — Task 4 — consumed Task 9. ✅

**Scope check:** One coherent subsystem (Evolution ingress/egress). Twelve tasks, each independently testable. No decomposition needed.

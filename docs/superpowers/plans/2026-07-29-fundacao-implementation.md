# Fundação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the foundational monorepo (API, worker, dashboard), Supabase project/schema, and Redis/BullMQ wiring for the WhatsApp AI agent platform, proven end-to-end with a smoke test — no business logic yet.

**Architecture:** pnpm + Turborepo monorepo with three independent apps (`api` on Fastify, `worker` on BullMQ, `dashboard` on Next.js) and two shared packages (`config` for env validation, `shared` for clients/types). Redis runs locally via Docker; Supabase is a real dedicated cloud project (dev tier).

**Tech Stack:** Node.js + TypeScript, pnpm workspaces, Turborepo, Fastify, BullMQ, ioredis, Next.js (App Router), Supabase (`@supabase/supabase-js`, `@supabase/ssr`), Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`), zod, Vitest, tsx.

## Global Constraints

- Runtime: Node.js >= 22, TypeScript across the whole backend. (Raised from >=20 during Task 4: the resolved `@supabase/supabase-js@2.111.0` and its sub-deps declare `engines: {node: ">=22.0.0"}`; user chose to raise the floor rather than pin an older client.)
- Monorepo: pnpm workspaces + Turborepo.
- API HTTP framework: Fastify.
- Dashboard: Next.js (App Router) with Supabase Auth (email/password).
- Queue: BullMQ; the worker runs as a process separate from the API.
- Redis: local Docker in dev (`docker-compose.yml`); URL is env-configurable so it can be swapped for a managed service in production without code changes.
- Database: a new, dedicated Supabase project (do not reuse existing projects on the account).
- Evolution API: an instance is already running externally; this plan only validates connectivity, it does not process real webhooks.
- LLM: multiple providers (Anthropic, OpenAI) behind a single `getModel()` abstraction via the Vercel AI SDK.
- Env validation: zod, fail-fast (`process.exit(1)` with a clear message when a required variable is missing).
- Tests: Vitest in every app/package.
- RLS enabled on every table; initial policy grants full access to any authenticated user (fine-grained permissions are future scope).
- Out of scope for this plan: real webhook processing, AI response generation, functional inbox/agent/instance management UI, multi-tenancy, production deployment.

---

### Task 1: Monorepo scaffolding + local Redis

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `turbo.json`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `docker-compose.yml`

**Interfaces:**
- Produces: workspace root that `pnpm` recognizes; `docker-compose.yml` service named `redis` on port `6379`, used by every later task's `REDIS_URL=redis://localhost:6379`.

- [ ] **Step 1: Create the root `package.json`**

```json
{
  "name": "fmagentes",
  "private": true,
  "packageManager": "pnpm@9.12.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "turbo run dev",
    "build": "turbo run build",
    "test": "turbo run test"
  },
  "devDependencies": {
    "turbo": "^2.1.3",
    "typescript": "^5.6.3"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 3: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**"]
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 4: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 5: Create `.gitignore`**

```
node_modules
dist
.next
.turbo
.env
.env.local
*.log
.DS_Store
```

- [ ] **Step 6: Create `docker-compose.yml`**

```yaml
services:
  redis:
    image: redis:7-alpine
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - redis-data:/data

volumes:
  redis-data:
```

Binding to `127.0.0.1` (not `0.0.0.0`) keeps the unauthenticated dev Redis reachable only from this machine, not from the rest of the network.

- [ ] **Step 7: Verify Redis starts and responds**

Run:
```bash
docker compose up -d
docker compose exec redis redis-cli ping
```
Expected: `PONG`

Then:
```bash
docker compose down
```

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-workspace.yaml turbo.json tsconfig.base.json .gitignore docker-compose.yml
git commit -m "chore: scaffold monorepo root and local Redis"
```

---

### Task 2: `packages/config` — env loader

**Files:**
- Create: `packages/config/package.json`
- Create: `packages/config/tsconfig.json`
- Create: `packages/config/vitest.config.ts`
- Create: `packages/config/src/createEnvLoader.ts`
- Create: `packages/config/src/index.ts`
- Test: `packages/config/tests/createEnvLoader.test.ts`

**Interfaces:**
- Produces: `createEnvLoader<T extends ZodTypeAny>(schema: T): () => z.infer<T>` — every app's `env.ts` (Tasks 8, 11, and optionally 13) imports this from `@fmagentes/config`.

- [ ] **Step 1: Create `packages/config/package.json`**

```json
{
  "name": "@fmagentes/config",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `packages/config/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `packages/config/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: lockfile created/updated, no errors.

- [ ] **Step 5: Write the failing test**

Create `packages/config/tests/createEnvLoader.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEnvLoader } from "../src/createEnvLoader";

describe("createEnvLoader", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns parsed env when valid", () => {
    process.env.FOO = "bar";
    const schema = z.object({ FOO: z.string() });
    const loadEnv = createEnvLoader(schema);

    expect(loadEnv()).toEqual({ FOO: "bar" });
  });

  it("exits the process with a clear message when required vars are missing", () => {
    delete process.env.FOO;
    const schema = z.object({ FOO: z.string() });
    const loadEnv = createEnvLoader(schema);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FOO"));
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/config test`
Expected: FAIL — `Cannot find module '../src/createEnvLoader'`

- [ ] **Step 7: Write the implementation**

Create `packages/config/src/createEnvLoader.ts`:

```ts
import { config as loadDotenv } from "dotenv";
import type { ZodTypeAny, z } from "zod";

loadDotenv();

export function createEnvLoader<T extends ZodTypeAny>(schema: T): () => z.infer<T> {
  let cached: z.infer<T> | undefined;

  return function loadEnv(): z.infer<T> {
    if (cached) return cached;

    const result = schema.safeParse(process.env);

    if (!result.success) {
      const formatted = result.error.issues
        .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
        .join("\n");

      console.error(`Invalid environment variables:\n${formatted}`);
      process.exit(1);
    }

    cached = result.data;
    return cached;
  };
}
```

Create `packages/config/src/index.ts`:

```ts
export * from "./createEnvLoader";
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/config test`
Expected: PASS (2 tests)

- [ ] **Step 9: Commit**

```bash
git add packages/config pnpm-lock.yaml
git commit -m "feat: add env loader package with fail-fast validation"
```

---

### Task 3: Supabase project + base schema

**Files:**
- Create: `supabase/migrations/0001_init.sql`

**Interfaces:**
- Produces: a live Supabase project (URL, anon key, service role key) and four tables (`instances`, `agents`, `conversations`, `messages`) that Task 4's `supabaseClient.ts` and Task 8's `/health` route depend on.

> This task uses the Supabase MCP tools available in this environment (`mcp__plugin_supabase_supabase__*`). It creates billed cloud infrastructure — confirm cost with the user before creating the project.

- [ ] **Step 1: Check the cost and get user confirmation**

Call `mcp__plugin_supabase_supabase__get_cost` with `{ type: "project", organization_id: "sszfvzgbenrewjocchuv" }`, show the result to the user, then call `mcp__plugin_supabase_supabase__confirm_cost` with the returned `type`/`recurrence`/`amount` to obtain a `confirm_cost_id`.

- [ ] **Step 2: Create the project**

Call `mcp__plugin_supabase_supabase__create_project` with:
```json
{
  "name": "fmagentes",
  "region": "sa-east-1",
  "organization_id": "sszfvzgbenrewjocchuv",
  "confirm_cost_id": "<id from Step 1>"
}
```
Save the returned project id — referenced below as `<project_id>`.

- [ ] **Step 3: Wait for the project to become active**

Poll `mcp__plugin_supabase_supabase__get_project` with `{ "id": "<project_id>" }` until `status` is `ACTIVE_HEALTHY` (usually 1-2 minutes).

- [ ] **Step 4: Write the migration file**

Create `supabase/migrations/0001_init.sql`:

```sql
create table if not exists instances (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  evolution_instance_id text not null unique,
  status text not null default 'disconnected',
  phone_number text,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null,
  model text not null,
  system_prompt text not null default '',
  instance_id uuid not null references instances(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references instances(id) on delete cascade,
  contact_phone text not null,
  agent_id uuid references agents(id) on delete set null,
  status text not null default 'open',
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  content text not null,
  role text not null,
  evolution_message_id text,
  created_at timestamptz not null default now()
);

alter table instances enable row level security;
alter table agents enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;

create policy "authenticated_full_access" on instances for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on agents for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on conversations for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on messages for all to authenticated using (true) with check (true);
```

- [ ] **Step 5: Apply the migration**

Call `mcp__plugin_supabase_supabase__apply_migration` with:
```json
{
  "project_id": "<project_id>",
  "name": "init",
  "query": "<contents of supabase/migrations/0001_init.sql>"
}
```

- [ ] **Step 6: Verify the tables exist**

Call `mcp__plugin_supabase_supabase__list_tables` with `{ "project_id": "<project_id>", "schemas": ["public"], "verbose": false }`.
Expected: `instances`, `agents`, `conversations`, `messages` all listed.

- [ ] **Step 7: Collect connection details**

Call `mcp__plugin_supabase_supabase__get_project_url` with `{ "project_id": "<project_id>" }` — this is `SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_URL`.
Call `mcp__plugin_supabase_supabase__get_publishable_keys` with `{ "project_id": "<project_id>" }` — the legacy anon key is `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
The `service_role` secret key is **not** exposed via MCP tools; open the Supabase dashboard for this project → Project Settings → API → copy the `service_role` key. This is `SUPABASE_SERVICE_KEY` and must never be used client-side.

- [ ] **Step 8: Create a test login user**

In the Supabase dashboard → Authentication → Users → Add User, create one user with email/password and mark it as confirmed (no invite email flow needed for local dev). This user logs into the dashboard in Task 13.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0001_init.sql
git commit -m "feat: add base Supabase schema (instances, agents, conversations, messages)"
```

---

### Task 4: `packages/shared` — domain types + Supabase client

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/supabaseClient.ts`
- Test: `packages/shared/tests/supabaseClient.test.ts`

**Interfaces:**
- Produces: `createSupabaseClient(config: SupabaseConfig): SupabaseClient` where `SupabaseConfig = { url: string; serviceKey: string }`. Used by Task 8's `apps/api/src/index.ts`.
- Produces: `Instance`, `Agent`, `Conversation`, `Message` types (informational, mirror the Task 3 schema; no consumer yet in this plan).

- [ ] **Step 1: Create `packages/shared/package.json`**

```json
{
  "name": "@fmagentes/shared",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.4",
    "ai": "^3.4.0",
    "@ai-sdk/anthropic": "^0.0.50",
    "@ai-sdk/openai": "^0.0.66",
    "bullmq": "^5.13.2",
    "ioredis": "^5.4.1"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `packages/shared/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `pnpm install`
Expected: no errors.

- [ ] **Step 5: Create the domain types**

Create `packages/shared/src/types.ts`:

```ts
export interface Instance {
  id: string;
  name: string;
  evolutionInstanceId: string;
  status: string;
  phoneNumber: string | null;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  provider: string;
  model: string;
  systemPrompt: string;
  instanceId: string;
  isActive: boolean;
}

export interface Conversation {
  id: string;
  instanceId: string;
  contactPhone: string;
  agentId: string | null;
  status: string;
  lastMessageAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  content: string;
  role: string;
  evolutionMessageId: string | null;
  createdAt: string;
}
```

- [ ] **Step 6: Write the failing test**

Create `packages/shared/tests/supabaseClient.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const createClientMock = vi.fn(() => ({ mocked: true }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
}));

import { createSupabaseClient } from "../src/supabaseClient";

describe("createSupabaseClient", () => {
  it("creates a client with the given url and service key, without session persistence", () => {
    const client = createSupabaseClient({ url: "https://example.supabase.co", serviceKey: "secret" });

    expect(createClientMock).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "secret",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    expect(client).toEqual({ mocked: true });
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/shared test`
Expected: FAIL — `Cannot find module '../src/supabaseClient'`

- [ ] **Step 8: Write the implementation**

Create `packages/shared/src/supabaseClient.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseConfig {
  url: string;
  serviceKey: string;
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
```

- [ ] **Step 9: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/shared test`
Expected: PASS (1 test)

- [ ] **Step 10: Commit**

```bash
git add packages/shared pnpm-lock.yaml
git commit -m "feat: add shared domain types and Supabase client factory"
```

---

### Task 5: `packages/shared` — Evolution API client

**Files:**
- Create: `packages/shared/src/evolutionApiClient.ts`
- Test: `packages/shared/tests/evolutionApiClient.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `createEvolutionApiClient(config: EvolutionApiConfig): EvolutionApiClient` where `EvolutionApiConfig = { baseUrl: string; apiKey: string }` and `EvolutionApiClient = { checkConnection(): Promise<boolean>; getInstanceStatus(instanceName: string): Promise<InstanceStatus>; sendMessage(instanceName: string, to: string, text: string): Promise<void> }`. Used by Task 8's `apps/api/src/index.ts` and `apps/api/src/routes/health.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/tests/evolutionApiClient.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEvolutionApiClient } from "../src/evolutionApiClient";

describe("createEvolutionApiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("checkConnection returns true when the request succeeds", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" }));
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await expect(client.checkConnection()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://evo.example.com/instance/fetchInstances",
      expect.objectContaining({ headers: expect.objectContaining({ apikey: "key" }) })
    );
  });

  it("checkConnection returns false when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Error" }));
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await expect(client.checkConnection()).resolves.toBe(false);
  });

  it("sendMessage posts the number and text to the send endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    vi.stubGlobal("fetch", fetchMock);
    const client = createEvolutionApiClient({ baseUrl: "https://evo.example.com", apiKey: "key" });

    await client.sendMessage("instance-1", "5511999999999", "hello");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://evo.example.com/message/sendText/instance-1",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ number: "5511999999999", text: "hello" }),
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/shared test`
Expected: FAIL — `Cannot find module '../src/evolutionApiClient'`

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/evolutionApiClient.ts`:

```ts
export interface EvolutionApiConfig {
  baseUrl: string;
  apiKey: string;
}

export interface InstanceStatus {
  instanceName: string;
  state: string;
}

export interface EvolutionApiClient {
  checkConnection(): Promise<boolean>;
  getInstanceStatus(instanceName: string): Promise<InstanceStatus>;
  sendMessage(instanceName: string, to: string, text: string): Promise<void>;
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
    });

    if (!response.ok) {
      throw new Error(`Evolution API request failed: ${response.status} ${response.statusText}`);
    }

    return response;
  }

  return {
    async checkConnection() {
      try {
        await request("/instance/fetchInstances");
        return true;
      } catch {
        return false;
      }
    },

    async getInstanceStatus(instanceName: string) {
      const response = await request(`/instance/connectionState/${instanceName}`);
      const data = (await response.json()) as { instance: InstanceStatus };
      return data.instance;
    },

    async sendMessage(instanceName: string, to: string, text: string) {
      await request(`/message/sendText/${instanceName}`, {
        method: "POST",
        body: JSON.stringify({ number: to, text }),
      });
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fmagentes/shared test`
Expected: PASS (4 tests total: 1 from Task 4 + 3 here)

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat: add Evolution API client wrapper"
```

---

### Task 6: `packages/shared` — LLM provider abstraction

**Files:**
- Create: `packages/shared/src/llm.ts`
- Test: `packages/shared/tests/llm.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `getModel(config: LlmConfig, provider: LlmProvider, modelName: string): LanguageModel` where `LlmProvider = "anthropic" | "openai"` and `LlmConfig = { anthropicApiKey: string; openaiApiKey: string }`. Not consumed elsewhere in this plan — it's the seam the future "Núcleo do Agente/LLM" sub-project builds on.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/tests/llm.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const anthropicModelFactory = vi.fn(() => "anthropic-model");
const createAnthropicMock = vi.fn(() => anthropicModelFactory);
const openaiModelFactory = vi.fn(() => "openai-model");
const createOpenAIMock = vi.fn(() => openaiModelFactory);

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic: createAnthropicMock }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: createOpenAIMock }));

import { getModel } from "../src/llm";

const config = { anthropicApiKey: "a-key", openaiApiKey: "o-key" };

describe("getModel", () => {
  it("returns an Anthropic model when provider is anthropic", () => {
    const model = getModel(config, "anthropic", "claude-opus-4-8");

    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "a-key" });
    expect(anthropicModelFactory).toHaveBeenCalledWith("claude-opus-4-8");
    expect(model).toBe("anthropic-model");
  });

  it("returns an OpenAI model when provider is openai", () => {
    const model = getModel(config, "openai", "gpt-4o");

    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "o-key" });
    expect(openaiModelFactory).toHaveBeenCalledWith("gpt-4o");
    expect(model).toBe("openai-model");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/shared test`
Expected: FAIL — `Cannot find module '../src/llm'`

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/llm.ts`:

```ts
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type LlmProvider = "anthropic" | "openai";

export interface LlmConfig {
  anthropicApiKey: string;
  openaiApiKey: string;
}

export function getModel(config: LlmConfig, provider: LlmProvider, modelName: string): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.anthropicApiKey })(modelName);
    case "openai":
      return createOpenAI({ apiKey: config.openaiApiKey })(modelName);
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported LLM provider: ${exhaustiveCheck}`);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fmagentes/shared test`
Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat: add multi-provider LLM model factory"
```

---

### Task 7: `packages/shared` — test queue + barrel export

**Files:**
- Create: `packages/shared/src/testQueue.ts`
- Create: `packages/shared/src/index.ts`
- Test: `packages/shared/tests/testQueue.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TEST_QUEUE_NAME = "test-queue"`, `TestQueueJobData = { message: string }`, `createTestQueue(connection: Redis): Queue<TestQueueJobData>`. Used by Task 8 (`apps/api`, producer) and Task 11 (`apps/worker`, consumer) — this is what keeps the queue name and job shape from drifting between the two processes.
- Produces: `packages/shared/src/index.ts` re-exporting everything, so all apps import from `@fmagentes/shared` only.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/tests/testQueue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const QueueMock = vi.fn();

vi.mock("bullmq", () => ({
  Queue: QueueMock,
}));

import { createTestQueue, TEST_QUEUE_NAME } from "../src/testQueue";

describe("createTestQueue", () => {
  it("creates a BullMQ Queue named test-queue with the given connection", () => {
    const connection = { host: "localhost", port: 6379 };

    createTestQueue(connection as never);

    expect(QueueMock).toHaveBeenCalledWith(TEST_QUEUE_NAME, { connection });
    expect(TEST_QUEUE_NAME).toBe("test-queue");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/shared test`
Expected: FAIL — `Cannot find module '../src/testQueue'`

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/testQueue.ts`:

```ts
import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const TEST_QUEUE_NAME = "test-queue";

export interface TestQueueJobData {
  message: string;
}

export function createTestQueue(connection: Redis): Queue<TestQueueJobData> {
  return new Queue<TestQueueJobData>(TEST_QUEUE_NAME, { connection });
}
```

Create `packages/shared/src/index.ts`:

```ts
export * from "./types";
export * from "./supabaseClient";
export * from "./evolutionApiClient";
export * from "./llm";
export * from "./testQueue";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/shared test`
Expected: PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat: add shared test queue and package barrel export"
```

---

### Task 8: `apps/api` — bootstrap + `/health`

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`
- Create: `apps/api/.env.example`
- Create: `apps/api/src/env.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/routes/health.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/tests/health.test.ts`

**Interfaces:**
- Consumes: `createEnvLoader` (`@fmagentes/config`, Task 2); `createSupabaseClient` (Task 4), `createEvolutionApiClient` (Task 5), `createTestQueue`/`TEST_QUEUE_NAME` (Task 7), all from `@fmagentes/shared`.
- Produces: `AppDependencies = { redis: Redis; supabase: SupabaseClient; evolutionApi: EvolutionApiClient; testQueue: Queue }` and `buildApp(deps: AppDependencies): FastifyInstance` — Tasks 9, 10, and 12 add routes/tests against this same `buildApp`.

> Requires Redis running: `docker compose up -d` (from repo root) before running this task's tests.

- [ ] **Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@fmagentes/api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fmagentes/config": "workspace:*",
    "@fmagentes/shared": "workspace:*",
    "@supabase/supabase-js": "^2.45.4",
    "fastify": "^4.28.1",
    "ioredis": "^5.4.1",
    "bullmq": "^5.13.2",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `apps/api/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `apps/api/.env.example`**

```
API_PORT=3001
REDIS_URL=redis://localhost:6379
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: no errors.

- [ ] **Step 6: Create the env schema**

Create `apps/api/src/env.ts`:

```ts
import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  API_PORT: z.coerce.number().default(3001),
  REDIS_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),
  EVOLUTION_API_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;
```

- [ ] **Step 7: Write the failing test**

Create `apps/api/tests/health.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { buildApp, type AppDependencies } from "../src/app";
import type { FastifyInstance } from "fastify";

describe("GET /health", () => {
  let app: FastifyInstance;
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });

    const deps: AppDependencies = {
      redis,
      supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: null }) }) }) } as never,
      evolutionApi: {
        checkConnection: async () => true,
        getInstanceStatus: async () => ({ instanceName: "", state: "" }),
        sendMessage: async () => {},
      },
      testQueue: { add: async () => ({ id: "1" }) } as never,
    };

    app = buildApp(deps);
  });

  afterAll(async () => {
    await app.close();
    await redis.quit();
  });

  it("returns 200 and connected status for all services when everything is healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      supabase: "connected",
      redis: "connected",
      evolutionApi: "connected",
    });
  });

  it("returns 503 when a dependency is unavailable", async () => {
    const deps: AppDependencies = {
      redis,
      supabase: { from: () => ({ select: () => ({ limit: async () => ({ error: new Error("down") }) }) }) } as never,
      evolutionApi: {
        checkConnection: async () => true,
        getInstanceStatus: async () => ({ instanceName: "", state: "" }),
        sendMessage: async () => {},
      },
      testQueue: { add: async () => ({ id: "1" }) } as never,
    };
    const unhealthyApp = buildApp(deps);

    const response = await unhealthyApp.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json().supabase).toBe("unavailable");

    await unhealthyApp.close();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `docker compose up -d && pnpm --filter @fmagentes/api test`
Expected: FAIL — `Cannot find module '../src/app'`

- [ ] **Step 9: Write the implementation**

Create `apps/api/src/routes/health.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerHealthRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.get("/health", async (_request, reply) => {
    const [supabaseOk, redisOk, evolutionOk] = await Promise.all([
      checkSupabase(deps),
      checkRedis(deps),
      checkEvolutionApi(deps),
    ]);

    const allOk = supabaseOk && redisOk && evolutionOk;

    reply.code(allOk ? 200 : 503).send({
      supabase: supabaseOk ? "connected" : "unavailable",
      redis: redisOk ? "connected" : "unavailable",
      evolutionApi: evolutionOk ? "connected" : "unavailable",
    });
  });
}

async function checkSupabase(deps: AppDependencies): Promise<boolean> {
  const { error } = await deps.supabase.from("instances").select("id").limit(1);
  return !error;
}

async function checkRedis(deps: AppDependencies): Promise<boolean> {
  try {
    const pong = await deps.redis.ping();
    return pong === "PONG";
  } catch {
    return false;
  }
}

async function checkEvolutionApi(deps: AppDependencies): Promise<boolean> {
  return deps.evolutionApi.checkConnection();
}
```

Create `apps/api/src/app.ts`:

```ts
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EvolutionApiClient } from "@fmagentes/shared";
import type { Queue } from "bullmq";
import { registerHealthRoute } from "./routes/health";

export interface AppDependencies {
  redis: Redis;
  supabase: SupabaseClient;
  evolutionApi: EvolutionApiClient;
  testQueue: Queue;
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((error, request, reply) => {
    if (request.url === "/webhooks/evolution") {
      app.log.warn({ err: error }, "Malformed Evolution API webhook payload");
      reply.code(200).send({ received: false });
      return;
    }

    reply.send(error);
  });

  registerHealthRoute(app, deps);

  return app;
}
```

Create `apps/api/src/index.ts`:

```ts
import { Redis } from "ioredis";
import { createSupabaseClient, createEvolutionApiClient, createTestQueue } from "@fmagentes/shared";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const env = loadEnv();

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const supabase = createSupabaseClient({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
const evolutionApi = createEvolutionApiClient({ baseUrl: env.EVOLUTION_API_URL, apiKey: env.EVOLUTION_API_KEY });
const testQueue = createTestQueue(redis);

const app = buildApp({ redis, supabase, evolutionApi, testQueue });

app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
```

Note: the error handler is added now (Step 9) even though the webhook route arrives in Task 9 — it belongs to `buildApp`'s cross-cutting setup, not to any single route.

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS (2 tests)

- [ ] **Step 11: Commit**

```bash
git add apps/api pnpm-lock.yaml
git commit -m "feat: add api bootstrap and /health endpoint"
```

---

### Task 9: `apps/api` — `POST /webhooks/evolution`

**Files:**
- Create: `apps/api/src/routes/webhooks.ts`
- Modify: `apps/api/src/app.ts` (register the route)
- Test: `apps/api/tests/webhooks.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `AppDependencies` (Task 8).
- Produces: `registerWebhookRoute(app: FastifyInstance): void`, mounted at `POST /webhooks/evolution`. No later task consumes this directly (the next sub-project replaces the body).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/tests/webhooks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

function fakeDeps(): AppDependencies {
  return {
    redis: {} as never,
    supabase: {} as never,
    evolutionApi: {} as never,
    testQueue: { add: async () => ({ id: "1" }) } as never,
  };
}

describe("POST /webhooks/evolution", () => {
  it("returns 200 for a well-formed payload", async () => {
    const app = buildApp(fakeDeps());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: { event: "messages.upsert", data: {} },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: true });

    await app.close();
  });

  it("returns 200 even for a malformed JSON payload, to avoid webhook retries", async () => {
    const app = buildApp(fakeDeps());

    const response = await app.inject({
      method: "POST",
      url: "/webhooks/evolution",
      payload: "{not valid json",
      headers: { "content-type": "application/json" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: false });

    await app.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/api test`
Expected: FAIL — first test gets 404 (route not registered)

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/webhooks.ts`:

```ts
import type { FastifyInstance } from "fastify";

export function registerWebhookRoute(app: FastifyInstance): void {
  app.post("/webhooks/evolution", async (request, reply) => {
    app.log.info({ body: request.body }, "Received Evolution API webhook");
    reply.code(200).send({ received: true });
  });
}
```

Modify `apps/api/src/app.ts` — add the import and registration call:

```ts
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";
```

```ts
  registerHealthRoute(app, deps);
  registerWebhookRoute(app);

  return app;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS (4 tests total)

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add Evolution API webhook receiver (log-only)"
```

---

### Task 10: `apps/api` — `POST /test/enqueue`

**Files:**
- Create: `apps/api/src/routes/testQueue.ts`
- Modify: `apps/api/src/app.ts` (register the route)
- Test: `apps/api/tests/testQueue.test.ts`

**Interfaces:**
- Consumes: `buildApp`, `AppDependencies` (Task 8); `TestQueueJobData` (`@fmagentes/shared`, Task 7).
- Produces: `registerTestQueueRoute(app: FastifyInstance, deps: AppDependencies): void`, mounted at `POST /test/enqueue`. Task 12's e2e test triggers this same code path indirectly by calling `testQueue.add` the same way.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/testQueue.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { buildApp, type AppDependencies } from "../src/app";

describe("POST /test/enqueue", () => {
  it("enqueues a job and returns its id", async () => {
    const addMock = vi.fn().mockResolvedValue({ id: "job-123" });
    const deps: AppDependencies = {
      redis: {} as never,
      supabase: {} as never,
      evolutionApi: {} as never,
      testQueue: { add: addMock } as never,
    };
    const app = buildApp(deps);

    const response = await app.inject({ method: "POST", url: "/test/enqueue" });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: "job-123" });
    expect(addMock).toHaveBeenCalledWith("test-job", { message: "hello from api" });

    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/api test`
Expected: FAIL — 404 (route not registered)

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/routes/testQueue.ts`:

```ts
import type { FastifyInstance } from "fastify";
import type { AppDependencies } from "../app";

export function registerTestQueueRoute(app: FastifyInstance, deps: AppDependencies): void {
  app.post("/test/enqueue", async (_request, reply) => {
    const job = await deps.testQueue.add("test-job", { message: "hello from api" });
    reply.code(202).send({ jobId: job.id });
  });
}
```

Modify `apps/api/src/app.ts` — add the import and registration call:

```ts
import { registerHealthRoute } from "./routes/health";
import { registerWebhookRoute } from "./routes/webhooks";
import { registerTestQueueRoute } from "./routes/testQueue";
```

```ts
  registerHealthRoute(app, deps);
  registerWebhookRoute(app);
  registerTestQueueRoute(app, deps);

  return app;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/api test`
Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "feat: add test enqueue endpoint for pipeline smoke testing"
```

---

### Task 11: `apps/worker` — bootstrap + test queue processor

**Files:**
- Create: `apps/worker/package.json`
- Create: `apps/worker/tsconfig.json`
- Create: `apps/worker/vitest.config.ts`
- Create: `apps/worker/.env.example`
- Create: `apps/worker/src/env.ts`
- Create: `apps/worker/src/testQueueProcessor.ts`
- Create: `apps/worker/src/index.ts`
- Test: `apps/worker/tests/testQueueProcessor.test.ts`

**Interfaces:**
- Consumes: `createEnvLoader` (`@fmagentes/config`, Task 2); `TEST_QUEUE_NAME`, `TestQueueJobData` (`@fmagentes/shared`, Task 7).
- Produces: `processTestQueueJob(job: Job<TestQueueJobData>): Promise<{ ok: true }>` — Task 12's e2e test relies on jobs on `TEST_QUEUE_NAME` being consumed by a worker built the same way as `apps/worker/src/index.ts`.

- [ ] **Step 1: Create `apps/worker/package.json`**

```json
{
  "name": "@fmagentes/worker",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@fmagentes/config": "workspace:*",
    "@fmagentes/shared": "workspace:*",
    "bullmq": "^5.13.2",
    "ioredis": "^5.4.1",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `apps/worker/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Create `apps/worker/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 4: Create `apps/worker/.env.example`**

```
REDIS_URL=redis://localhost:6379
```

- [ ] **Step 5: Install dependencies**

Run: `pnpm install`
Expected: no errors.

- [ ] **Step 6: Create the env schema**

Create `apps/worker/src/env.ts`:

```ts
import { createEnvLoader } from "@fmagentes/config";
import { z } from "zod";

const schema = z.object({
  REDIS_URL: z.string().url(),
});

export const loadEnv = createEnvLoader(schema);
export type Env = ReturnType<typeof loadEnv>;
```

- [ ] **Step 7: Write the failing test**

Create `apps/worker/tests/testQueueProcessor.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { Job } from "bullmq";
import type { TestQueueJobData } from "@fmagentes/shared";
import { processTestQueueJob } from "../src/testQueueProcessor";

describe("processTestQueueJob", () => {
  it("logs the job message and returns ok", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const job = { id: "job-1", data: { message: "hello" } } as Job<TestQueueJobData>;

    const result = await processTestQueueJob(job);

    expect(result).toEqual({ ok: true });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("hello"));

    logSpy.mockRestore();
  });
});
```

- [ ] **Step 8: Run test to verify it fails**

Run: `pnpm --filter @fmagentes/worker test`
Expected: FAIL — `Cannot find module '../src/testQueueProcessor'`

- [ ] **Step 9: Write the implementation**

Create `apps/worker/src/testQueueProcessor.ts`:

```ts
import type { Job } from "bullmq";
import type { TestQueueJobData } from "@fmagentes/shared";

export async function processTestQueueJob(job: Job<TestQueueJobData>): Promise<{ ok: true }> {
  console.log(`[worker] processed job ${job.id}: ${job.data.message}`);
  return { ok: true };
}
```

Create `apps/worker/src/index.ts`:

```ts
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { TEST_QUEUE_NAME } from "@fmagentes/shared";
import { loadEnv } from "./env";
import { processTestQueueJob } from "./testQueueProcessor";

const env = loadEnv();

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const worker = new Worker(TEST_QUEUE_NAME, processTestQueueJob, { connection });

worker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
  console.error(`[worker] job ${job?.id} failed`, error);
});

console.log("[worker] listening for jobs on", TEST_QUEUE_NAME);
```

- [ ] **Step 10: Run test to verify it passes**

Run: `pnpm --filter @fmagentes/worker test`
Expected: PASS (1 test)

- [ ] **Step 11: Commit**

```bash
git add apps/worker pnpm-lock.yaml
git commit -m "feat: add worker bootstrap and test queue processor"
```

---

### Task 12: End-to-end queue integration test

**Files:**
- Test: `apps/api/tests/e2e-queue.test.ts`

**Interfaces:**
- Consumes: `createTestQueue`, `TEST_QUEUE_NAME`, `TestQueueJobData` (`@fmagentes/shared`, Task 7).
- Produces: nothing new — this is the proof that Task 8's producer path and Task 11's consumer path agree on queue name and job shape.

> Requires Redis running: `docker compose up -d` (from repo root) before running this task.

- [ ] **Step 1: Write the test**

Create `apps/api/tests/e2e-queue.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { Worker } from "bullmq";
import { createTestQueue, TEST_QUEUE_NAME, type TestQueueJobData } from "@fmagentes/shared";

describe("end-to-end: api enqueues, worker processes", () => {
  let producerRedis: Redis;
  let worker: Worker<TestQueueJobData>;

  beforeAll(() => {
    producerRedis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await worker.close();
    await producerRedis.quit();
  });

  it("processes a job enqueued through the shared test queue", async () => {
    const processed: string[] = [];

    worker = new Worker<TestQueueJobData>(
      TEST_QUEUE_NAME,
      async (job) => {
        processed.push(job.data.message);
        return { ok: true };
      },
      { connection: new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null }) }
    );

    await new Promise<void>((resolve) => worker.on("ready", resolve));

    const queue = createTestQueue(producerRedis);
    await queue.add("e2e-test-job", { message: "ping" });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for job to process")), 5000);
      worker.on("completed", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    expect(processed).toEqual(["ping"]);
    await queue.close();
  }, 10000);
});
```

- [ ] **Step 2: Run the test**

Run: `docker compose up -d && pnpm --filter @fmagentes/api test`
Expected: PASS (6 tests total in `apps/api`, including this one)

- [ ] **Step 3: Commit**

```bash
git add apps/api
git commit -m "test: prove api-to-worker pipeline works end-to-end via BullMQ"
```

---

### Task 13: `apps/dashboard` — scaffold + Supabase Auth + login

**Files:**
- Create: `apps/dashboard/package.json`
- Create: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/next.config.js`
- Create: `apps/dashboard/next-env.d.ts`
- Create: `apps/dashboard/.env.example`
- Create: `apps/dashboard/lib/supabase/client.ts`
- Create: `apps/dashboard/lib/supabase/server.ts`
- Create: `apps/dashboard/middleware.ts`
- Create: `apps/dashboard/app/layout.tsx`
- Create: `apps/dashboard/app/page.tsx`
- Create: `apps/dashboard/app/login/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks (dashboard talks to Supabase directly with the anon key, and to `apps/api` over HTTP — no shared package dependency).
- Produces: `/login` page and auth middleware protecting `/dashboard/*`. Task 14 adds the page that middleware protects.

> This task is framework wiring (Next.js App Router + Supabase Auth cookies) with no isolated unit to test — verification is manual (Step 8). Task 14 adds the first unit-testable piece of the dashboard.

- [ ] **Step 1: Create `apps/dashboard/package.json`**

```json
{
  "name": "@fmagentes/dashboard",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "^14.2.15",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "@supabase/ssr": "^0.5.1",
    "@supabase/supabase-js": "^2.45.4"
  },
  "devDependencies": {
    "@types/react": "^18.3.11",
    "@types/react-dom": "^18.3.0",
    "@types/node": "^22.7.4",
    "typescript": "^5.6.3",
    "vitest": "^2.1.2"
  }
}
```

- [ ] **Step 2: Create `apps/dashboard/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "esnext"],
    "jsx": "preserve",
    "module": "esnext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Create `apps/dashboard/next.config.js`**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = nextConfig;
```

- [ ] **Step 4: Create `apps/dashboard/next-env.d.ts`**

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 5: Create `apps/dashboard/.env.example`**

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
NEXT_PUBLIC_API_URL=http://localhost:3001
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`
Expected: no errors.

- [ ] **Step 7: Create the Supabase clients, middleware, layout, and pages**

Create `apps/dashboard/lib/supabase/client.ts`:

```ts
import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
```

Create `apps/dashboard/lib/supabase/server.ts`:

```ts
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          cookieStore.set({ name, value: "", ...options });
        },
      },
    }
  );
}
```

Create `apps/dashboard/middleware.ts`:

```ts
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          response = NextResponse.next({ request: { headers: request.headers } });
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && request.nextUrl.pathname.startsWith("/dashboard")) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
```

Create `apps/dashboard/app/layout.tsx`:

```tsx
import type { ReactNode } from "react";

export const metadata = {
  title: "fmagentes",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
```

Create `apps/dashboard/app/page.tsx`:

```tsx
import { redirect } from "next/navigation";

export default function HomePage() {
  redirect("/login");
}
```

Create `apps/dashboard/app/login/page.tsx`:

```tsx
"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "../../lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError(signInError.message);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  return (
    <main>
      <h1>Entrar</h1>
      <form onSubmit={handleSubmit}>
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit">Entrar</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 8: Manually verify**

Fill `apps/dashboard/.env` (copied from `.env.example`) with the Task 3 project URL and anon key. Run:

```bash
pnpm --filter @fmagentes/dashboard dev
```

Open `http://localhost:3000` — expect a redirect to `/login`. Log in with the test user from Task 3, Step 8 — expect a redirect toward `/dashboard` (a 404 is expected until Task 14 adds that page).

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard pnpm-lock.yaml
git commit -m "feat: add dashboard scaffold with Supabase Auth login"
```

---

### Task 14: `apps/dashboard` — protected status page

**Files:**
- Create: `apps/dashboard/lib/getHealth.ts`
- Create: `apps/dashboard/app/dashboard/page.tsx`
- Create: `apps/dashboard/vitest.config.ts`
- Test: `apps/dashboard/tests/getHealth.test.ts`

**Interfaces:**
- Consumes: nothing code-level from earlier tasks; relies on `apps/api`'s `/health` endpoint (Task 8) being reachable at `NEXT_PUBLIC_API_URL`.
- Produces: `getHealth(apiUrl: string): Promise<HealthStatus | null>`, rendered by the `/dashboard` page that Task 13's middleware already protects.

- [ ] **Step 1: Create `apps/dashboard/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
});
```

- [ ] **Step 2: Write the failing tests**

Create `apps/dashboard/tests/getHealth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHealth } from "../lib/getHealth";

describe("getHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed health status on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({ supabase: "connected", redis: "connected", evolutionApi: "connected" }),
      })
    );

    const result = await getHealth("http://localhost:3001");

    expect(result).toEqual({ supabase: "connected", redis: "connected", evolutionApi: "connected" });
    expect(fetch).toHaveBeenCalledWith("http://localhost:3001/health", { cache: "no-store" });
  });

  it("returns null when the request fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await getHealth("http://localhost:3001");

    expect(result).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @fmagentes/dashboard test`
Expected: FAIL — `Cannot find module '../lib/getHealth'`

- [ ] **Step 4: Write the implementation**

Create `apps/dashboard/lib/getHealth.ts`:

```ts
export interface HealthStatus {
  supabase: string;
  redis: string;
  evolutionApi: string;
}

export async function getHealth(apiUrl: string): Promise<HealthStatus | null> {
  try {
    const response = await fetch(`${apiUrl}/health`, { cache: "no-store" });
    return (await response.json()) as HealthStatus;
  } catch {
    return null;
  }
}
```

Create `apps/dashboard/app/dashboard/page.tsx`:

```tsx
import { getHealth } from "../../lib/getHealth";

export default async function DashboardPage() {
  const health = await getHealth(process.env.NEXT_PUBLIC_API_URL!);

  return (
    <main>
      <h1>Status do sistema</h1>
      {health ? (
        <ul>
          <li>Supabase: {health.supabase}</li>
          <li>Redis: {health.redis}</li>
          <li>Evolution API: {health.evolutionApi}</li>
        </ul>
      ) : (
        <p>Não foi possível conectar à API.</p>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @fmagentes/dashboard test`
Expected: PASS (2 tests)

- [ ] **Step 6: Manually verify**

With `docker compose up -d`, `apps/api` running (`pnpm --filter @fmagentes/api dev`), and `apps/dashboard` running, log in at `http://localhost:3000/login` and confirm `/dashboard` shows all three services as `connected`.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard
git commit -m "feat: add protected dashboard status page"
```

---

### Task 15: Definition of done — full boot verification

**Files:** none (verification only).

**Interfaces:** none — this task only runs what every earlier task produced.

- [ ] **Step 1: Populate real environment files**

Copy each `.env.example` to `.env` in `apps/api`, `apps/worker`, and `apps/dashboard`, and fill in real values: Supabase URL/anon key/service key from Task 3, the existing Evolution API URL/key, and your Anthropic/OpenAI API keys.

- [ ] **Step 2: Start infrastructure**

Run: `docker compose up -d`
Expected: `redis` container running.

- [ ] **Step 3: Build and test everything**

Run:
```bash
pnpm install
pnpm run build
pnpm run test
```
Expected: both commands exit 0 across every app/package.

- [ ] **Step 4: Boot everything**

Run: `pnpm run dev`
Expected: `api`, `worker`, and `dashboard` all start without errors in the Turborepo log output.

- [ ] **Step 5: Verify `/health`**

Run: `curl http://localhost:3001/health`
Expected: HTTP 200, body `{"supabase":"connected","redis":"connected","evolutionApi":"connected"}`.

- [ ] **Step 6: Verify the dashboard**

Open `http://localhost:3000` → redirected to `/login` → sign in with the Task 3 test user → redirected to `/dashboard` → see the same three "connected" statuses as Step 5.

- [ ] **Step 7: Verify the queue pipeline manually**

Run: `curl -X POST http://localhost:3001/test/enqueue`
Expected: HTTP 202 with a `jobId`. Check the `worker` terminal output for `[worker] processed job <id>: hello from api` and `[worker] job <id> completed`.

- [ ] **Step 8: Stop everything**

Stop the `pnpm run dev` process, then run: `docker compose down`

Fundação is done when Steps 3–7 all succeed without manual intervention beyond filling in real credentials in Step 1.

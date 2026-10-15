"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiFetch } from "../../../lib/browserApi";
import { usePolling } from "../../../lib/usePolling";
import { useMe } from "../../../lib/useMe";
import type { InboxResponse } from "../../../lib/types";
import { ConversationList } from "./ConversationList";
import { ConversationPane } from "./ConversationPane";
import ui from "../ui.module.css";

type Tab = "handoff" | "mine" | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "handoff", label: "Transferidas" },
  { id: "mine", label: "Minhas" },
  { id: "all", label: "Todas" },
];

function Inbox() {
  const params = useSearchParams();
  const router = useRouter();
  const { me, error: meError } = useMe();
  const tab = (TABS.some((t) => t.id === params.get("tab")) ? params.get("tab") : "handoff") as Tab;
  const selected = params.get("c");
  const profileMessage = meError ? "Não foi possível carregar seu perfil — tentando de novo…" : "Carregando seu perfil…";
  const list = usePolling(() => apiFetch<InboxResponse>(`/conversations?view=${tab}`), `inbox-${tab}`);

  function navigate(next: { tab?: Tab; c?: string | null }) {
    const query = new URLSearchParams(params.toString());
    if (next.tab) {
      query.set("tab", next.tab);
      query.delete("c");
    }
    if (next.c !== undefined) {
      if (next.c) query.set("c", next.c);
      else query.delete("c");
    }
    router.replace(`/dashboard/inbox?${query.toString()}`);
  }

  const counts = list.data?.counts;
  const countFor = (id: Tab) => (id === "handoff" ? counts?.handoff : id === "mine" ? counts?.mine : undefined);

  return (
    <div>
      <div className={ui.tabs}>
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? ui.tabActive : ui.tab} onClick={() => navigate({ tab: t.id })}>
            {t.label}
            {countFor(t.id) ? ` (${countFor(t.id)})` : ""}
          </button>
        ))}
      </div>
      <div className={`${ui.inbox} ${selected ? ui.inboxHasSelection : ui.inboxNoSelection}`}>
        <ConversationList
          items={list.data?.items ?? null}
          error={list.error}
          selectedId={selected}
          emptyText={tab === "all" ? "Nenhuma conversa aberta." : "Nenhuma conversa aguardando atendente."}
          onSelect={(id) => navigate({ c: id })}
        />
        <div className={ui.pane}>
          {selected && me ? (
            <ConversationPane
              key={selected}
              id={selected}
              me={me}
              onBack={() => navigate({ c: null })}
              onChanged={() => void list.refresh()}
            />
          ) : selected ? (
            <p className={meError ? ui.error : ui.muted}>{profileMessage}</p>
          ) : (
            <p className={ui.muted}>Selecione uma conversa.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function InboxPage() {
  return (
    <Suspense fallback={<p>Carregando…</p>}>
      <Inbox />
    </Suspense>
  );
}

"use client";

import { useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { usePolling } from "../../../lib/usePolling";
import { useMe } from "../../../lib/useMe";
import type { AgentListRow } from "../../../lib/types";
import { AgentForm } from "./AgentForm";
import ui from "../ui.module.css";

export default function AgentsPage() {
  const me = useMe();
  const list = usePolling(() => apiFetch<AgentListRow[]>("/agents"), "agents", 60_000);
  const [selected, setSelected] = useState<string | null>(null);
  const row = list.data?.find((r) => r.instance.id === selected) ?? null;

  return (
    <div>
      <h1>Agentes</h1>
      {list.error && !list.data ? <p className={ui.error}>Erro ao carregar.</p> : null}
      <table className={ui.table}>
        <thead>
          <tr><th>Número</th><th>Agente</th><th>Modelo</th><th>Situação</th><th /></tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((r) => (
            <tr key={r.instance.id}>
              <td>{r.instance.name}</td>
              <td>{r.agent?.name ?? <span className={ui.muted}>sem agente</span>}</td>
              <td>{r.agent ? `${r.agent.provider} / ${r.agent.model}` : "—"}</td>
              <td>{r.agent ? (r.agent.isActive ? "ativo" : "desligado") : "—"}</td>
              <td>
                <button type="button" className={ui.secondary} onClick={() => setSelected(r.instance.id)}>
                  {r.agent ? "Editar" : "Criar agente"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {row && me ? (
        <div className={ui.card} style={{ marginTop: 16 }}>
          <AgentForm
            key={row.instance.id}
            instance={row.instance}
            agent={row.agent}
            providers={me.providers}
            onSaved={() => void list.refresh()}
            onClose={() => setSelected(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

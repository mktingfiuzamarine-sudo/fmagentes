"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { ApiError } from "../../../lib/api";
import type { AgentDto, Me } from "../../../lib/types";
import ui from "../ui.module.css";

const DEFAULT_HANDOFF = "Vou te passar para um atendente, já já alguém te responde.";
const MODEL_SUGGESTIONS = ["claude-haiku-4-5", "gpt-4o-mini"];

export function AgentForm(props: {
  instance: { id: string; name: string };
  agent: AgentDto | null;
  providers: Me["providers"];
  onSaved(): void;
  onClose(): void;
}) {
  const [name, setName] = useState(props.agent?.name ?? "Atendente");
  const [provider, setProvider] = useState<AgentDto["provider"]>(props.agent?.provider ?? "anthropic");
  const [model, setModel] = useState(props.agent?.model ?? "claude-haiku-4-5");
  const [systemPrompt, setSystemPrompt] = useState(props.agent?.systemPrompt ?? "");
  const [handoffMessage, setHandoffMessage] = useState(props.agent?.handoffMessage ?? DEFAULT_HANDOFF);
  const [isActive, setIsActive] = useState(props.agent?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    const body = { name, provider, model, systemPrompt, handoffMessage, isActive };
    try {
      const result = props.agent
        ? await apiFetch<{ warning?: string }>(`/agents/${props.agent.id}`, { method: "PUT", body })
        : await apiFetch<{ warning?: string }>("/agents", { method: "POST", body: { instanceId: props.instance.id, ...body } });
      setStatus({
        kind: "ok",
        text: result.warning === "provider-key-missing" ? "Salvo, mas o provedor escolhido não tem chave configurada." : "Salvo.",
      });
      props.onSaved();
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 409
          ? "Este número já tem um agente."
          : error instanceof ApiError && error.status === 400
            ? "Confira os campos: nome e modelo são obrigatórios; prompt até 20.000 caracteres."
            : "Não foi possível salvar.";
      setStatus({ kind: "error", text });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>{props.agent ? "Editar agente" : "Criar agente"} — {props.instance.name}</h2>
      <label className={ui.field}>
        Nome
        <input className={ui.input} value={name} maxLength={100} required onChange={(e) => setName(e.target.value)} />
      </label>
      <label className={ui.field}>
        Provedor
        <select className={ui.select} value={provider} onChange={(e) => setProvider(e.target.value as AgentDto["provider"])}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </label>
      {!props.providers[provider] ? <p className={ui.warn}>Sem chave configurada para este provedor — o agente não vai responder.</p> : null}
      <label className={ui.field}>
        Modelo
        <input className={ui.input} list="model-suggestions" value={model} maxLength={100} required onChange={(e) => setModel(e.target.value)} />
        <datalist id="model-suggestions">
          {MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}
        </datalist>
      </label>
      <label className={ui.field}>
        Prompt (instruções do negócio)
        <textarea className={`${ui.textarea} ${ui.tall}`} value={systemPrompt} maxLength={20000} onChange={(e) => setSystemPrompt(e.target.value)} />
      </label>
      <label className={ui.field}>
        Mensagem de transferência
        <input className={ui.input} value={handoffMessage} maxLength={1000} required onChange={(e) => setHandoffMessage(e.target.value)} />
      </label>
      <label className={ui.row} style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        Agente ativo
      </label>
      {!isActive ? <p className={ui.warn}>Desligado, o bot não responde ninguém neste número.</p> : null}
      {status ? <p className={status.kind === "error" ? ui.error : ui.muted}>{status.text}</p> : null}
      <div className={ui.row}>
        <button type="submit" className={ui.button} disabled={busy}>Salvar</button>
        <button type="button" className={ui.secondary} onClick={props.onClose}>Fechar</button>
      </div>
    </form>
  );
}

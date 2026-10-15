"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { ApiError } from "../../../lib/api";
import { formatPhone, formatTime } from "../../../lib/format";
import { replyGate } from "../../../lib/replyGate";
import { usePolling } from "../../../lib/usePolling";
import type { ChatMessage, ConversationDetail, Me } from "../../../lib/types";
import ui from "../ui.module.css";

type Confirm = { text: string; kind: "send" | "assign" | "resume" } | null;

function bubbleClass(message: ChatMessage): string {
  if (message.direction === "in") return ui.fromCustomer;
  return message.sentBy ? ui.fromHuman : ui.fromBot;
}

function author(message: ChatMessage): string {
  if (message.direction === "in") return "Cliente";
  return message.sentBy ? message.sentBy.displayName : "Bot";
}

export function ConversationPane(props: { id: string; me: Me; onBack(): void; onChanged(): void }) {
  const detail = usePolling(() => apiFetch<ConversationDetail>(`/conversations/${props.id}`), props.id);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const historyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const conversation = detail.data;
  const messageCount = conversation?.messages.length ?? 0;
  const loaded = conversation !== null;

  // Open at the newest message; afterwards follow new ones only if the reader is near the bottom.
  useEffect(() => {
    const el = historyRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [loaded, messageCount]);

  if (!conversation) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    if (notFound) return <p className={ui.error}>Conversa não encontrada.</p>;
    if (detail.error) return <p className={ui.error}>Não foi possível carregar a conversa — tentando de novo…</p>;
    return <p className={ui.muted}>Carregando…</p>;
  }

  async function run(action: () => Promise<unknown>, errorText: string) {
    setBusy(true);
    setFailure(null);
    try {
      await action();
      await detail.refresh();
      props.onChanged();
    } catch {
      setFailure(errorText);
    } finally {
      setBusy(false);
    }
  }

  const assign = () => run(() => apiFetch(`/conversations/${props.id}/assign`, { method: "POST" }), "Não foi possível assumir.");
  const unassign = () => run(() => apiFetch(`/conversations/${props.id}/unassign`, { method: "POST" }), "Não foi possível soltar.");
  const resume = () =>
    run(() => apiFetch(`/conversations/${props.id}/resume`, { method: "POST" }), "Não foi possível devolver ao bot.");
  const send = () =>
    run(async () => {
      await apiFetch(`/conversations/${props.id}/messages`, { method: "POST", body: { text } });
      setText("");
    }, "Falha ao enviar. O texto foi mantido — tente de novo.");

  const gate = replyGate(conversation, props.me.id);
  const owner = conversation.assignedTo;

  function requestSend() {
    if (!text.trim()) return;
    if (gate === "assume-first") {
      setConfirm({ text: "Ninguém assumiu esta conversa. Responder sem assumir?", kind: "send" });
    } else if (gate === "warn-other-owner") {
      setConfirm({ text: `${owner?.displayName} está atendendo. Responder mesmo assim?`, kind: "send" });
    } else {
      void send();
    }
  }

  function requestAssign() {
    if (owner && owner.id !== props.me.id) {
      setConfirm({ text: `${owner.displayName} está atendendo. Assumir no lugar?`, kind: "assign" });
    } else {
      void assign();
    }
  }

  const customer = conversation.customer;

  return (
    <>
      <button type="button" className={`${ui.secondary} ${ui.backLink}`} onClick={props.onBack}>
        ← Voltar
      </button>
      <div>
        <div className={ui.row}>
          <strong>
            {customer.linkVia === "phone" || customer.linkVia === "created"
              ? customer.name ?? "Cliente vinculado (nome indisponível)"
              : formatPhone(conversation.contactPhone)}
          </strong>
          <span className={ui.muted}>{formatPhone(conversation.contactPhone)} · {conversation.instance.name}</span>
        </div>
        {customer.linkVia === "cpf" ? (
          <p className={ui.warn}>CPF não verificado — o cliente digitou este CPF; confirme a identidade antes de compartilhar dados.</p>
        ) : null}
        {conversation.handoffSummary ? <p><strong>Resumo:</strong> {conversation.handoffSummary}</p> : null}
        {conversation.status === "awaiting_human" ? (
          <div className={ui.row}>
            <span>Responsável: {owner ? owner.displayName : "ninguém"}</span>
            {owner?.id === props.me.id ? (
              <button type="button" className={ui.secondary} disabled={busy} onClick={() => void unassign()}>Soltar</button>
            ) : (
              <button type="button" className={ui.button} disabled={busy} onClick={requestAssign}>Assumir</button>
            )}
            <button
              type="button"
              className={ui.secondary}
              disabled={busy}
              onClick={() => setConfirm({ text: "Devolver esta conversa ao bot? Ele volta a responder o cliente.", kind: "resume" })}
            >
              Devolver ao bot
            </button>
          </div>
        ) : (
          <p className={ui.muted}>Conversa com o bot — somente leitura.</p>
        )}
      </div>

      <div
        className={ui.history}
        ref={historyRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {conversation.messages.map((message) => (
          <div key={message.id} className={`${ui.bubble} ${bubbleClass(message)}`}>
            {message.content}
            <div className={ui.bubbleMeta}>{author(message)} · {formatTime(message.createdAt)}</div>
          </div>
        ))}
      </div>

      {confirm ? (
        <div className={`${ui.warn} ${ui.row}`}>
          <span>{confirm.text}</span>
          <button
            type="button"
            className={ui.button}
            onClick={() => {
              const action = confirm.kind === "send" ? send : confirm.kind === "assign" ? assign : resume;
              setConfirm(null);
              void action();
            }}
          >
            Confirmar
          </button>
          <button type="button" className={ui.secondary} onClick={() => setConfirm(null)}>Cancelar</button>
        </div>
      ) : null}
      {failure ? <p className={ui.error}>{failure}</p> : null}

      {gate !== "read-only" ? (
        <div className={ui.row}>
          <textarea
            className={ui.textarea}
            value={text}
            maxLength={4096}
            disabled={busy || confirm !== null}
            placeholder="Escreva a resposta…"
            onChange={(event) => setText(event.target.value)}
          />
          <button type="button" className={ui.button} disabled={busy || confirm !== null || !text.trim()} onClick={requestSend}>
            {failure && text ? "Tentar de novo" : "Enviar"}
          </button>
        </div>
      ) : null}
    </>
  );
}

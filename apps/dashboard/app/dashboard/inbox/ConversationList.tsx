"use client";

import { formatPhone, formatRelative } from "../../../lib/format";
import type { ConversationListItem } from "../../../lib/types";
import ui from "../ui.module.css";

export function ConversationList(props: {
  items: ConversationListItem[] | null;
  error: unknown;
  selectedId: string | null;
  emptyText: string;
  onSelect(id: string): void;
}) {
  if (props.items === null) {
    return <div className={ui.list}>{props.error ? <p className={ui.error}>Erro ao carregar.</p> : <p className={ui.muted}>Carregando…</p>}</div>;
  }
  return (
    <div className={ui.list}>
      {props.error ? <p className={ui.error}>Sem conexão com a API — mostrando a última lista.</p> : null}
      {props.items.length === 0 ? <p className={ui.muted} style={{ padding: 12 }}>{props.emptyText}</p> : null}
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`${ui.item} ${item.id === props.selectedId ? ui.itemSelected : ""}`}
          onClick={() => props.onSelect(item.id)}
        >
          <div className={ui.itemTitle}>
            <span>{formatPhone(item.contactPhone)}</span>
            <span className={ui.muted}>{item.lastMessage ? formatRelative(item.lastMessage.createdAt) : ""}</span>
          </div>
          {item.handoffSummary ? <div className={ui.itemPreview}>{item.handoffSummary}</div> : null}
          <div className={ui.itemPreview}>{item.lastMessage?.content ?? "—"}</div>
          <div className={ui.row}>
            {item.awaitingReply && item.status === "awaiting_human" ? <span className={ui.awaiting}>aguardando resposta</span> : null}
            {item.assignedTo ? <span className={ui.muted}>{item.assignedTo.displayName}</span> : null}
            <span className={ui.muted}>{item.instance.name}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

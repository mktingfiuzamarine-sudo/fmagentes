"use client";

import { useState, type FormEvent } from "react";
import { apiFetch } from "../../../lib/browserApi";
import { createInstanceErrorMessage } from "../../../lib/instanceErrors";
import { formatPhone } from "../../../lib/format";
import { usePolling } from "../../../lib/usePolling";
import type { InstanceRow } from "../../../lib/types";
import { QrPanel } from "./QrPanel";
import ui from "../ui.module.css";

const STATUS_LABEL: Record<string, string> = {
  created: "criado",
  connecting: "conectando",
  connected: "conectado",
  disconnected: "desconectado",
};

export default function InstancesPage() {
  const list = usePolling(() => apiFetch<InstanceRow[]>("/instances"), "instances");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<InstanceRow | null>(null);
  const [typedName, setTypedName] = useState("");

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const row = await apiFetch<InstanceRow>("/instances", { method: "POST", body: { name: newName.trim() } });
      setNewName("");
      await list.refresh();
      setQrFor(row.id);
    } catch (error) {
      setMessage(createInstanceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch(`/instances/${removing.id}`, { method: "DELETE" });
      if (qrFor === removing.id) setQrFor(null);
      setRemoving(null);
      setTypedName("");
      await list.refresh();
    } catch {
      setMessage("Não foi possível remover o número.");
    } finally {
      setBusy(false);
    }
  }

  const qrInstance = list.data?.find((row) => row.id === qrFor) ?? null;

  return (
    <div>
      <h1>Números</h1>
      <form className={ui.row} onSubmit={create} style={{ marginBottom: 16 }}>
        <input
          className={ui.input}
          style={{ maxWidth: 280 }}
          placeholder="Nome do novo número (ex.: loja-centro)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className={ui.button} disabled={busy || !newName.trim()}>Novo número</button>
      </form>
      {message ? <p className={ui.error}>{message}</p> : null}
      <table className={ui.table}>
        <thead>
          <tr><th>Nome</th><th>Telefone</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((row) => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td>{row.phone_number ? formatPhone(row.phone_number) : "—"}</td>
              <td>{STATUS_LABEL[row.status] ?? row.status}</td>
              <td className={ui.row}>
                <button type="button" className={ui.secondary} onClick={() => setQrFor(row.id)}>
                  {row.status === "connected" ? "Ver status" : "Ver QR"}
                </button>
                <button type="button" className={ui.secondary} onClick={() => { setRemoving(row); setTypedName(""); }}>
                  Remover
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {removing ? (
        <div className={`${ui.card} ${ui.warn}`} style={{ marginTop: 16 }}>
          <p>
            Remover <strong>{removing.name}</strong> desconecta o WhatsApp e apaga <strong>todas as conversas e mensagens</strong> deste número.
            Digite o nome para confirmar.
          </p>
          <div className={ui.row}>
            <input className={ui.input} style={{ maxWidth: 240 }} value={typedName} onChange={(e) => setTypedName(e.target.value)} />
            <button type="button" className={ui.danger} disabled={busy || typedName !== removing.name} onClick={() => void remove()}>
              Remover definitivamente
            </button>
            <button type="button" className={ui.secondary} onClick={() => setRemoving(null)}>Cancelar</button>
          </div>
        </div>
      ) : null}

      {qrInstance ? <QrPanel key={qrInstance.id} instance={qrInstance} onClose={() => setQrFor(null)} /> : null}
    </div>
  );
}

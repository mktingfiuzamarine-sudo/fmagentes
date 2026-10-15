"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../../lib/browserApi";
import type { InstanceRow, QrResponse } from "../../../lib/types";
import ui from "../ui.module.css";

/** Fetches a QR once (WhatsApp codes expire; "Gerar novo QR" asks again). Status comes from the parent's polling. */
export function QrPanel(props: { instance: InstanceRow; onClose(): void }) {
  const [qr, setQr] = useState<QrResponse | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const connected = props.instance.status === "connected";

  useEffect(() => {
    if (connected) return;
    let cancelled = false;
    setQr(null);
    setError(false);
    apiFetch<QrResponse>(`/instances/${props.instance.id}/qr`)
      .then((result) => !cancelled && setQr(result))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [props.instance.id, attempt, connected]);

  return (
    <div className={ui.card} style={{ marginTop: 16 }}>
      <h2>Parear {props.instance.name}</h2>
      {connected ? (
        <p>Conectado ✓</p>
      ) : error ? (
        <p className={ui.error}>A Evolution API não respondeu. Tente gerar o QR de novo.</p>
      ) : !qr ? (
        <p className={ui.muted}>Gerando QR…</p>
      ) : qr.qrcode ? (
        <>
          <p>No celular: WhatsApp → Aparelhos conectados → Conectar aparelho.</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={ui.qr} src={qr.qrcode} alt="QR code para parear o WhatsApp" />
          {qr.pairingCode ? <p className={ui.muted}>Código de pareamento: {qr.pairingCode}</p> : null}
        </>
      ) : (
        <p className={ui.muted}>A Evolution não devolveu QR — o número pode já estar pareado.</p>
      )}
      <div className={ui.row}>
        {!connected ? (
          <button type="button" className={ui.secondary} onClick={() => setAttempt((n) => n + 1)}>Gerar novo QR</button>
        ) : null}
        <button type="button" className={ui.secondary} onClick={props.onClose}>Fechar</button>
      </div>
    </div>
  );
}

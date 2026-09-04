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

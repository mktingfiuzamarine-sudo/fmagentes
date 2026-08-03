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

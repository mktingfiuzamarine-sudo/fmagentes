export const INSTANCE_STATUS = {
  CREATED: "created",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
} as const;

export type InstanceStatusValue = (typeof INSTANCE_STATUS)[keyof typeof INSTANCE_STATUS];

export function mapConnectionState(state: string): InstanceStatusValue {
  if (state === "open") return INSTANCE_STATUS.CONNECTED;
  if (state === "connecting") return INSTANCE_STATUS.CONNECTING;
  return INSTANCE_STATUS.DISCONNECTED;
}

import { describe, expect, it } from "vitest";
import { parseEvolutionEvent, type InboundMessageEvent } from "../src/events";

const parseInbound = (body: unknown) => parseEvolutionEvent(body) as InboundMessageEvent | null;

const inbound = {
  event: "messages.upsert",
  instance: "acme",
  data: {
    key: { remoteJid: "5511999998888@s.whatsapp.net", fromMe: false, id: "MSG1" },
    pushName: "Alice",
    message: { conversation: "hello" },
    messageTimestamp: 1719000000,
  },
};

describe("parseEvolutionEvent", () => {
  it("parses a text messages.upsert event", () => {
    const parsed = parseEvolutionEvent(inbound);
    expect(parsed).toEqual({
      type: "messages.upsert",
      instanceName: "acme",
      messageId: "MSG1",
      fromMe: false,
      contactPhone: "5511999998888",
      pushName: "Alice",
      text: "hello",
      timestamp: 1719000000,
    });
  });

  it("reads text from extendedTextMessage", () => {
    const evt = { ...inbound, data: { ...inbound.data, message: { extendedTextMessage: { text: "long one" } } } };
    expect(parseInbound(evt)?.text).toBe("long one");
  });

  it("returns null text for a non-text message (e.g. image)", () => {
    const evt = { ...inbound, data: { ...inbound.data, message: { imageMessage: {} } } };
    expect(parseInbound(evt)?.text).toBeNull();
  });

  it("marks fromMe messages", () => {
    const evt = { ...inbound, data: { ...inbound.data, key: { ...inbound.data.key, fromMe: true } } };
    expect(parseInbound(evt)?.fromMe).toBe(true);
  });

  const withKey = (key: Record<string, unknown>) => ({
    ...inbound,
    data: { ...inbound.data, key: { ...inbound.data.key, ...key } },
  });

  it.each([
    ["a group", "120363025246125486@g.us"],
    ["a status update", "status@broadcast"],
    ["a broadcast list", "1719000000@broadcast"],
    ["a channel", "120363999999999999@newsletter"],
  ])("ignores messages from %s", (_label, remoteJid) => {
    expect(parseEvolutionEvent(withKey({ remoteJid }))).toBeNull();
  });

  it("resolves a @lid sender through the phone JID Evolution sends alongside", () => {
    const evt = withKey({ remoteJid: "123456789012345@lid", remoteJidAlt: "5511999998888@s.whatsapp.net" });
    expect(parseInbound(evt)?.contactPhone).toBe("5511999998888");
  });

  it("resolves a @lid sender through senderPn", () => {
    const evt = withKey({ remoteJid: "123456789012345@lid", senderPn: "5511999998888@s.whatsapp.net" });
    expect(parseInbound(evt)?.contactPhone).toBe("5511999998888");
  });

  it("ignores a @lid sender without a phone JID: the LID is not a number we can answer", () => {
    expect(parseEvolutionEvent(withKey({ remoteJid: "123456789012345@lid" }))).toBeNull();
  });

  it("parses connection.update", () => {
    expect(parseEvolutionEvent({ event: "connection.update", instance: "acme", data: { state: "open" } })).toEqual({
      type: "connection.update",
      instanceName: "acme",
      state: "open",
    });
  });

  it("parses qrcode.updated", () => {
    expect(parseEvolutionEvent({ event: "qrcode.updated", instance: "acme", data: {} })).toEqual({
      type: "qrcode.updated",
      instanceName: "acme",
    });
  });

  it("returns null for unknown events and junk", () => {
    expect(parseEvolutionEvent({ event: "contacts.update", instance: "x", data: {} })).toBeNull();
    expect(parseEvolutionEvent("not json")).toBeNull();
    expect(parseEvolutionEvent({})).toBeNull();
    expect(parseEvolutionEvent({ event: "messages.upsert", instance: "x" })).toBeNull();
  });
});

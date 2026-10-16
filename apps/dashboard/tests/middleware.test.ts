import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type CookieMethods = {
  getAll?: () => { name: string; value: string }[];
  setAll?: (cookies: { name: string; value: string; options?: object }[]) => void;
};

const { session } = vi.hoisted(() => ({ session: { onGetUser: (_cookies: CookieMethods) => {} } }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: CookieMethods }) => ({
    auth: {
      getUser: async () => {
        session.onGetUser(options.cookies);
        return { data: { user: { id: "u1" } } };
      },
    },
  }),
}));

import { middleware } from "../middleware";

describe("middleware session refresh (M14)", () => {
  it("keeps every chunk of a refreshed session cookie", async () => {
    // A refreshed token too big for one cookie is written in chunks (.0, .1).
    session.onGetUser = (cookies) =>
      cookies.setAll!([
        { name: "sb-x-auth-token.0", value: "first-half", options: { path: "/" } },
        { name: "sb-x-auth-token.1", value: "second-half", options: { path: "/" } },
      ]);

    const response = await middleware(new NextRequest("http://localhost/dashboard/inbox"));

    expect(response.cookies.get("sb-x-auth-token.0")?.value).toBe("first-half");
    expect(response.cookies.get("sb-x-auth-token.1")?.value).toBe("second-half");
  });

  it("reads all request cookies for the client", async () => {
    let seen: { name: string; value: string }[] = [];
    session.onGetUser = (cookies) => {
      seen = cookies.getAll!();
    };
    const request = new NextRequest("http://localhost/dashboard/inbox", { headers: { cookie: "a=1; b=2" } });

    await middleware(request);

    expect(seen.map((c) => c.name).sort()).toEqual(["a", "b"]);
  });
});

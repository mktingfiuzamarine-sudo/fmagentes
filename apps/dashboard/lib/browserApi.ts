"use client";

import { createClient } from "./supabase/client";
import { createApiFetch } from "./api";

export const apiFetch = createApiFetch({
  async getToken() {
    const { data } = await createClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
  onUnauthorized() {
    void createClient().auth.signOut();
    if (typeof window !== "undefined") window.location.href = "/login";
  },
});

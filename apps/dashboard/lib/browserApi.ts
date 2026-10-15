"use client";

import { createClient } from "./supabase/client";
import { createApiFetch } from "./api";
import { resetMe } from "./useMe";

export const apiFetch = createApiFetch({
  async getToken() {
    const { data } = await createClient().auth.getSession();
    return data.session?.access_token ?? null;
  },
  onUnauthorized() {
    resetMe();
    void createClient().auth.signOut();
    if (typeof window !== "undefined") window.location.href = "/login";
  },
});

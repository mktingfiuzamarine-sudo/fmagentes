"use client";

import { createClient } from "./supabase/client";
import { createApiFetch } from "./api";
import { resetMe } from "./useMe";

/** Read by the login page to explain why the user was signed out. */
export const NO_ACCESS_REASON = "sem-acesso";

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
  onForbidden() {
    resetMe();
    void createClient().auth.signOut();
    if (typeof window !== "undefined") window.location.href = `/login?motivo=${NO_ACCESS_REASON}`;
  },
});

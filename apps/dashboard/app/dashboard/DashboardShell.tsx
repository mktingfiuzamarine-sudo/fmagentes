"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch } from "../../lib/browserApi";
import { createClient } from "../../lib/supabase/client";
import { usePolling } from "../../lib/usePolling";
import { formatTabTitle } from "../../lib/format";
import { resetMe, useMe } from "../../lib/useMe";
import type { InboxResponse } from "../../lib/types";
import ui from "./ui.module.css";

const LINKS = [
  { href: "/dashboard/inbox", label: "Inbox" },
  { href: "/dashboard/agents", label: "Agentes" },
  { href: "/dashboard/instances", label: "Números" },
  { href: "/dashboard", label: "Status" },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me } = useMe();
  const { data } = usePolling(() => apiFetch<InboxResponse>("/conversations?view=handoff"), "shell-counts", undefined, { hiddenIntervalMs: 60_000 });
  const handoffs = data?.counts.handoff ?? 0;

  useEffect(() => {
    // Next re-applies metadata.title on client navigation, so re-run on pathname and each poll result.
    document.title = formatTabTitle(handoffs);
  }, [handoffs, data, pathname]);

  async function signOut() {
    resetMe();
    await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const isActive = (href: string) => (href === "/dashboard" ? pathname === href : pathname.startsWith(href));

  return (
    <div className={ui.shell}>
      <nav className={ui.nav}>
        <div className={ui.brand}>fmagentes</div>
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={`${ui.navLink} ${isActive(link.href) ? ui.navActive : ""}`}>
            <span>{link.label}</span>
            {link.href === "/dashboard/inbox" && handoffs > 0 ? <span className={ui.badge}>{handoffs}</span> : null}
          </Link>
        ))}
        <div className={ui.navFooter}>
          <span>{me?.displayName ?? ""}</span>
          <button type="button" className={ui.secondary} onClick={signOut}>
            Sair
          </button>
        </div>
      </nav>
      <main className={ui.main}>{children}</main>
    </div>
  );
}

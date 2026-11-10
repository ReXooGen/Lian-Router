export type DashboardApp = "landing" | "console" | "share" | "status";

/** Resolves the app mounted by the shared index document. */
export function resolveDashboardApp(pathname: string): DashboardApp {
  if (pathname === "/share" || pathname.startsWith("/share/")) return "share";
  if (pathname === "/status" || pathname.startsWith("/status/")) return "status";
  return pathname === "/console" || pathname.startsWith("/console/") ? "console" : "landing";
}

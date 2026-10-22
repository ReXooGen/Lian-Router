export type DashboardApp = "console" | "share";

/** Resolves the app mounted by the shared index document. */
export function resolveDashboardApp(pathname: string): DashboardApp {
  if (pathname === "/share" || pathname.startsWith("/share/")) return "share";
  return "console";
}

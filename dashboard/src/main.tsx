import { resolveDashboardApp } from "./lib/app-entry";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Dashboard root element is missing");
}

// Console-only distribution: nothing serves a public landing page, so the root
// document hands the visitor to the authenticated console surface instead.
const pathname = window.location.pathname;
if (pathname === "/" || pathname === "/index.html") {
  window.location.replace("/console/");
} else {
  const app = resolveDashboardApp(pathname);
  if (app === "console") {
    void import("./apps/console/entry").then(({ mountConsole }) => mountConsole(rootElement));
  } else {
    void import("./apps/share/entry").then(() => undefined);
  }
}

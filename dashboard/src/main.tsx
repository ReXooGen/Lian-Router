import { resolveDashboardApp } from "./lib/app-entry";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Dashboard root element is missing");
}

// The root document is the public entry: `/` renders the landing page, `/console/*`
// the authenticated console, `/share/*` the enrollment app. The landing never
// bounces a visitor into a login form they cannot yet satisfy.
const app = resolveDashboardApp(window.location.pathname);

if (app === "console") {
  void import("./apps/console/entry").then(({ mountConsole }) => mountConsole(rootElement));
} else if (app === "share") {
  void import("./apps/share/entry").then(() => undefined);
} else if (app === "status") {
  void import("./apps/status/entry").then(({ mountStatus }) => mountStatus(rootElement));
} else {
  void import("./apps/landing/entry").then(({ mountLanding }) => mountLanding(rootElement));
}

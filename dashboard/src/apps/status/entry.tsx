import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { StatusPage } from "./page";
import "./status.css";

/** Mounts the public model-status page into the shared dashboard document. */
export function mountStatus(root: HTMLElement): void {
  document.title = "LianRouter — Models status";
  createRoot(root).render(
    <StrictMode>
      <StatusPage />
    </StrictMode>,
  );
}

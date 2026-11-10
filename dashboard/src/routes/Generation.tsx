import type { ReactNode } from "react";
import { GenerationPanel } from "../components/generation/GenerationPanel";

/**
 * Generation page. The same panel is mounted from Model Lab's Generate tool,
 * so both surfaces share one provider/model picker and one task lifecycle.
 */
export default function Generation(): ReactNode {
  return <GenerationPanel />;
}

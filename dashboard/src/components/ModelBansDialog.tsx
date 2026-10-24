import { ShieldOff, Undo2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { DataTable } from "./ui/layout";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { ConfirmDialog } from "./ConfirmDialog";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../lib/helpers";
import type { ModelAbuseBan } from "../lib/contracts";
import { useModelBans, useUnbanModel } from "../lib/hooks/model-bans";

/**
 * The model-abuse ban list, opened from the API Credentials header.
 *
 * A ban is keyed on the client address, so it is cross-tenant and only a
 * platform admin may see or lift one; the entry point is hidden for everyone
 * else. A ban lapses on its own after its TTL — lifting one early is the escape
 * hatch for a false positive (a shared NAT, a client that genuinely mistyped a
 * model id).
 */
function lapseLabel(expiresAt: number): string {
  const date = new Date(expiresAt);
  if (!Number.isFinite(date.getTime())) return "—";
  const remaining = expiresAt - Date.now();
  const absolute = date.toLocaleString();
  if (remaining <= 0) return `${absolute} (lapsed)`;
  const totalMinutes = Math.ceil(remaining / 60_000);
  if (totalMinutes < 60) return `${absolute} (in ${totalMinutes}m)`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 24) return `${absolute} (in ${hours}h)`;
  return `${absolute} (in ${Math.floor(hours / 24)}d)`;
}

export function ModelBansDialog({ onClose }: { readonly onClose: () => void }): ReactNode {
  const bansQuery = useModelBans(true);
  const unban = useUnbanModel();
  const [unbanTarget, setUnbanTarget] = useState<ModelAbuseBan | null>(null);
  const bans = bansQuery.data ?? [];

  return (
    <>
      <Dialog
        open={true}
        onClose={onClose}
        title="Blocked clients"
        description="A client address is blocked after repeated requests naming models it may not use. The block applies to every API key used from that address, not just one credential."
        width={760}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
          <h4 style={{ margin: 0, fontSize: "12px", color: "var(--text-secondary)" }}>
            Active blocks ({bans.length})
          </h4>
          {bansQuery.isPending ? (
            <LoadingState label="Loading blocked clients…" />
          ) : bansQuery.isError ? (
            <ErrorState
              message={getErrorMessage(bansQuery.error, "Could not load blocked clients.")}
              onRetry={() => void bansQuery.refetch()}
            />
          ) : bans.length === 0 ? (
            <EmptyState
              title="No blocked clients"
              message="No client address is currently blocked for model abuse."
              icon={<ShieldOff size={20} />}
            />
          ) : (
            <DataTable maxHeight={480} headers={["Client IP", "Reason", "Applies to", "Lapses", ""]}>
              {bans.map((ban) => (
                <tr key={ban.ip}>
                  <td style={{ fontFamily: "var(--font-mono, monospace)", whiteSpace: "nowrap" }}>
                    {ban.ip}
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {ban.reason === "repeated_invalid_model_requests"
                      ? "Repeated invalid-model requests"
                      : ban.reason}
                  </td>
                  <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    All API keys from this IP
                  </td>
                  <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {lapseLabel(ban.expiresAt)}
                  </td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Undo2 size={13} />}
                      disabled={unban.isPending}
                      onClick={() => setUnbanTarget(ban)}
                    >
                      Unblock
                    </Button>
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={unbanTarget !== null}
        onClose={() => setUnbanTarget(null)}
        onConfirm={async () => {
          if (!unbanTarget) return;
          await unban.mutateAsync(unbanTarget.ip);
          toast.success(`Unblocked ${unbanTarget.ip}.`);
          setUnbanTarget(null);
        }}
        title="Lift this block?"
        message={
          unbanTarget
            ? `Lift the block on ${unbanTarget.ip}? The address can reach the gateway again immediately.`
            : "Lift this block?"
        }
        confirmLabel="Unblock"
        danger
      />
    </>
  );
}

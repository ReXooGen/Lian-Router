import { FlaskConical } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Inline } from "../../components/ui/inline";
import { Select } from "../../components/ui/select";
import { Stack } from "../../components/ui/stack";
import { getErrorMessage } from "../../lib/helpers";
import { useProbeModel } from "../../lib/hooks/providers";
import { accountProbeRequest, enabledModelOptions } from "../account-probe-model";
import type { ProbeModelResult, ProviderAccountResponse } from "../../lib/contracts";

/** The subset of a catalog entry the probe picker reads. */
export interface AccountProbeModel {
  readonly modelId: string;
  readonly enabled: boolean;
}


export interface AccountProbePanelProps {
  readonly models: readonly AccountProbeModel[];
  readonly modelsLoading: boolean;
  readonly pending: boolean;
  readonly result?: ProbeModelResult;
  readonly error?: string;
  readonly onProbe: (modelId: string) => void;
  readonly onClose: () => void;
}

/**
 * Dialog body, split from the mutation wrapper so its rendered states are
 * testable under the repository's server-rendering test setup.
 */
export function AccountProbePanel({
  models,
  modelsLoading,
  pending,
  result,
  error,
  onProbe,
  onClose,
}: AccountProbePanelProps): ReactNode {
  const options = enabledModelOptions(models);
  const [chosen, setChosen] = useState("");
  const modelId = options.some((option) => option.value === chosen)
    ? chosen
    : (options[0]?.value ?? "");
  const canProbe = modelId !== "" && !pending;

  return (
    <Stack gap="12px">
      {options.length === 0 ? (
        <div style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {modelsLoading
            ? "Loading models…"
            : "No enabled model on this provider — enable one on the Models tab before probing this account."}
        </div>
      ) : (
        <Select
          id="account-probe-model"
          label="Model"
          value={modelId}
          onValueChange={setChosen}
          options={options}
          disabled={pending}
          aria-label="Probe model"
        />
      )}

      <Inline gap="8px">
        <Button
          size="sm"
          variant="primary"
          icon={<FlaskConical size={12} />}
          loading={pending}
          disabled={!canProbe}
          onClick={() => onProbe(modelId)}
          title={
            canProbe
              ? "Send one probe with this account's credential"
              : "No enabled model to probe"
          }
        >
          Probe
        </Button>
        <Button size="sm" variant="secondary" onClick={onClose}>
          Close
        </Button>
      </Inline>

      {result ? (
        <Stack gap="6px">
          <Inline gap="8px" wrap>
            {result.ok ? (
              <Badge tone="ok">OK</Badge>
            ) : (
              <Badge tone="err">{result.error ?? "Probe failed"}</Badge>
            )}
            <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
              {result.latencyMs} ms
            </span>
            {result.ttfbMs !== undefined ? (
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                TTFB {result.ttfbMs} ms
              </span>
            ) : null}
            {!result.ok && result.statusCode !== undefined ? (
              <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                HTTP {result.statusCode}
              </span>
            ) : null}
          </Inline>
          {result.sample ? (
            <pre
              style={{
                margin: 0,
                padding: "8px 10px",
                borderRadius: "6px",
                background: "var(--surface-2, rgba(127,127,127,0.08))",
                color: "var(--text-secondary)",
                fontSize: "11.5px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "180px",
                overflow: "auto",
              }}
            >
              {result.sample}
            </pre>
          ) : null}
        </Stack>
      ) : null}

      {error ? (
        <div style={{ fontSize: "12px", color: "var(--status-danger, #e5484d)" }}>{error}</div>
      ) : null}

      <div style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
        The probe also writes account health, so this row's badge may change on its own.
      </div>
    </Stack>
  );
}

/**
 * One-account probe. The endpoint treats `accountId` as a hard pin, so this
 * dialog never fans out over the provider's other accounts.
 */
export function AccountProbeDialog({
  providerId,
  account,
  models,
  modelsLoading,
  onClose,
}: {
  readonly providerId: string;
  readonly account: ProviderAccountResponse;
  readonly models: readonly AccountProbeModel[];
  readonly modelsLoading: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const probe = useProbeModel();
  const label = account.label || account.id.slice(0, 8);

  return (
    <Dialog open onClose={onClose} title={`Probe account — ${label}`} width={520}>
      <AccountProbePanel
        models={models}
        modelsLoading={modelsLoading}
        pending={probe.isPending}
        result={probe.data}
        error={
          probe.error ? getErrorMessage(probe.error, "Probe request failed") : undefined
        }
        onProbe={(modelId) => {
          probe.reset();
          probe.mutate({
            providerId,
            request: accountProbeRequest(modelId, account.id),
          });
        }}
        onClose={onClose}
      />
    </Dialog>
  );
}

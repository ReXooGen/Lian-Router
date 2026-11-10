import { Image as ImageIcon, RefreshCw, Sparkles, TriangleAlert, Video } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardBody, CardHeader } from "../ui/card";
import { Inline } from "../ui/inline";
import { Input, Textarea } from "../ui/input";
import { SearchableSelect } from "../ui/searchable-select";
import { Select } from "../ui/select";
import { Stack } from "../ui/stack";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import {
  useGenerateImage,
  useGenerationCatalog,
  useGenerationImageTask,
  useGenerationVideoTask,
  useGenerateVideo,
} from "../../lib/hooks/generation";
import { getErrorMessage } from "../../lib/helpers";
import { groupGenerationProviders, providerOptionLabel } from "../../lib/generation-catalog";
import { toast } from "../../lib/toast";
import type {
  GenerationImageTask,
  GenerationKind,
  GenerationTaskStatus,
  GenerationVideoTask,
} from "../../lib/contracts";

const KIND_LABEL: Record<GenerationKind, string> = { image: "Image", video: "Video" };

function statusTone(status: GenerationTaskStatus): "ok" | "err" | "warn" | "info" {
  if (status === "succeeded") return "ok";
  if (status === "failed" || status === "cancelled") return "err";
  if (status === "queued" || status === "running") return "warn";
  return "info";
}

function isPending(status: GenerationTaskStatus | undefined): boolean {
  return status === "queued" || status === "running";
}

function ProgressBar({ progress }: { readonly progress: number }): ReactNode {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress)}
      style={{
        height: "6px",
        borderRadius: "999px",
        background: "var(--surface-2, rgba(127,127,127,0.18))",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, progress))}%`,
          height: "100%",
          background: "var(--accent, #6d8cff)",
          transition: "width 300ms ease",
        }}
      />
    </div>
  );
}

function TaskState({ task }: { readonly task: GenerationImageTask | GenerationVideoTask }): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "160px" }}>
      <Inline gap="8px" align="center" wrap>
        <Badge tone={statusTone(task.status)} dot>
          {task.status}
        </Badge>
        <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
          {Math.round(task.progress)}%
        </span>
      </Inline>
      {isPending(task.status) ? <ProgressBar progress={task.progress} /> : null}
    </div>
  );
}

function ImageResults({ task }: { readonly task: GenerationImageTask }): ReactNode {
  if (task.images.length === 0) {
    return isPending(task.status) ? (
      <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
        Waiting for the provider to finish the image job…
      </p>
    ) : (
      <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
        {task.error ?? "The provider returned no image."}
      </p>
    );
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "10px",
      }}
    >
      {task.images.map((image, index) => {
        const source = image.url ?? (image.b64Json ? `data:image/png;base64,${image.b64Json}` : "");
        if (source.length === 0) return null;
        return (
          <figure key={`${source.slice(0, 32)}-${index}`} style={{ margin: 0 }}>
            <a href={source} target="_blank" rel="noreferrer">
              <img
                src={source}
                alt={image.revisedPrompt ?? `Generated image ${index + 1}`}
                style={{
                  width: "100%",
                  borderRadius: "10px",
                  border: "1px solid var(--border)",
                  display: "block",
                }}
              />
            </a>
            {image.revisedPrompt ? (
              <figcaption
                style={{ marginTop: "4px", fontSize: "11px", color: "var(--text-tertiary)" }}
              >
                {image.revisedPrompt}
              </figcaption>
            ) : null}
          </figure>
        );
      })}
    </div>
  );
}

function VideoResult({ task }: { readonly task: GenerationVideoTask }): ReactNode {
  if (task.video === undefined) {
    return isPending(task.status) ? (
      <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
        The provider is rendering the video. This can take a few minutes.
      </p>
    ) : (
      <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
        {task.error ?? "The provider returned no video."}
      </p>
    );
  }
  return (
    <Stack gap="8px">
      <video
        controls
        preload="metadata"
        src={task.video.url}
        style={{ width: "100%", maxHeight: "480px", borderRadius: "10px", background: "#000" }}
      />
      <Inline gap="10px" align="center" wrap>
        <a href={task.video.url} target="_blank" rel="noreferrer" style={{ fontSize: "12px" }}>
          Open video
        </a>
        {task.video.width && task.video.height ? (
          <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
            {task.video.width}×{task.video.height}
          </span>
        ) : null}
        {task.video.mime ? (
          <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>{task.video.mime}</span>
        ) : null}
      </Inline>
    </Stack>
  );
}

export function GenerationPanel(): ReactNode {
  const catalog = useGenerationCatalog();
  const [kind, setKind] = useState<GenerationKind>("image");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState("1");
  const [size, setSize] = useState("");
  const [duration, setDuration] = useState("5");
  const [imageTask, setImageTask] = useState<{ providerId: string; task: GenerationImageTask }>();
  const [videoTask, setVideoTask] = useState<{ providerId: string; task: GenerationVideoTask }>();

  const imageMutation = useGenerateImage();
  const videoMutation = useGenerateVideo();

  const imagePoll = useGenerationImageTask(
    imageTask?.providerId ?? "",
    imageTask?.task.id ?? "",
  );
  const videoPoll = useGenerationVideoTask(
    videoTask?.providerId ?? "",
    videoTask?.task.id ?? "",
  );
  const currentImage = imagePoll.data ?? imageTask?.task;
  const currentVideo = videoPoll.data ?? videoTask?.task;

  // Provider and model are two explicit choices, never one merged string: the
  // same model id can exist on several providers, and a flat picker made those
  // rows indistinguishable.
  const providers = useMemo(
    () => groupGenerationProviders(catalog.data?.models ?? [], kind),
    [catalog.data, kind],
  );
  const activeProvider = providers.find((provider) => provider.id === providerId) ?? providers[0];
  const models = activeProvider?.models ?? [];
  const activeModel = models.find((model) => model.modelId === modelId) ?? models[0];
  const providerOptions = providers.map((provider) => ({
    value: provider.id,
    label: providerOptionLabel(provider),
  }));
  const modelOptions = models.map((model) => ({ value: model.modelId, label: model.modelId }));

  const submitting = imageMutation.isPending || videoMutation.isPending;
  const working =
    submitting || (kind === "image" ? isPending(currentImage?.status) : isPending(currentVideo?.status));

  const submit = (): void => {
    if (activeProvider === undefined || activeModel === undefined) {
      toast.error("Choose a provider and generation model first");
      return;
    }
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      toast.error("Write a prompt first");
      return;
    }
    if (kind === "image") {
      const n = Number(count);
      imageMutation.mutate(
        {
          providerId: activeProvider.id,
          model: activeModel.modelId,
          prompt: trimmed,
          n: Number.isInteger(n) && n >= 1 && n <= 4 ? n : 1,
          ...(size.trim().length > 0 ? { size: size.trim() } : {}),
        },
        {
          onSuccess: (task) => setImageTask({ providerId: activeProvider.id, task }),
          onError: (error) => toast.error("Image generation failed", getErrorMessage(error)),
        },
      );
      return;
    }
    const parsedDuration = Number(duration);
    videoMutation.mutate(
      {
        providerId: activeProvider.id,
        model: activeModel.modelId,
        prompt: trimmed,
        ...(size.trim().length > 0 ? { size: size.trim() } : {}),
        ...(Number.isInteger(parsedDuration) && parsedDuration >= 1 && parsedDuration <= 60
          ? { duration: parsedDuration }
          : {}),
      },
      {
        onSuccess: (task) => setVideoTask({ providerId: activeProvider.id, task }),
        onError: (error) => toast.error("Video generation failed", getErrorMessage(error)),
      },
    );
  };

  if (catalog.isLoading) return <LoadingState label="Loading generation models…" />;
  if (catalog.isError) {
    return (
      <ErrorState
        title="Generation catalog unavailable"
        message={getErrorMessage(catalog.error)}
        action={
          <Button icon={<RefreshCw size={14} />} onClick={() => void catalog.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  if ((catalog.data?.models.length ?? 0) === 0) {
    return (
      <EmptyState
        icon={<Sparkles size={20} />}
        title="No generation models"
        message="Register an image or video provider and sync its models. A model appears here when its catalog entry declares image or video output."
      />
    );
  }

  const activeTask = kind === "image" ? currentImage : currentVideo;

  return (
    <Stack gap="16px">
      <Card>
        <CardHeader
          title="Generate"
          subtitle="Runs through the selected provider's own account and egress; results are stored upstream and proxied back to this console."
          action={
            <Inline gap="6px">
              {(["image", "video"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={kind === value ? "primary" : "secondary"}
                  icon={value === "image" ? <ImageIcon size={14} /> : <Video size={14} />}
                  onClick={() => {
                    setKind(value);
                    setModelId("");
                  }}
                >
                  {KIND_LABEL[value]}
                </Button>
              ))}
            </Inline>
          }
        />
        <CardBody>
          <Stack gap="12px">
            <Inline gap="12px" align="flex-end" wrap>
              <div style={{ minWidth: "240px", flex: "1 1 240px" }}>
                <SearchableSelect
                  label="Provider"
                  value={activeProvider?.id ?? ""}
                  onValueChange={(value) => {
                    setProviderId(value);
                    setModelId("");
                  }}
                  options={providerOptions}
                  placeholder="Select a provider…"
                  searchPlaceholder="Search provider…"
                  emptyMessage="No providers for this kind"
                />
              </div>
              <div style={{ minWidth: "200px", flex: "1 1 200px" }}>
                <SearchableSelect
                  label="Model"
                  value={activeModel?.modelId ?? ""}
                  onValueChange={setModelId}
                  options={modelOptions}
                  placeholder="Select a model…"
                  searchPlaceholder="Search model…"
                  emptyMessage="No models for this provider"
                />
              </div>
            </Inline>
            <p style={{ fontSize: "11px", color: "var(--text-tertiary)" }}>
              Provider <strong>{activeProvider?.id ?? "—"}</strong> · Model{" "}
              <strong>{activeModel?.modelId ?? "—"}</strong> · {KIND_LABEL[kind]}
            </p>
            <p style={{ fontSize: "10.5px", color: "var(--text-tertiary)" }}>
              {providers.length} provider{providers.length === 1 ? "" : "s"} expose{" "}
              {KIND_LABEL[kind].toLowerCase()} output. A provider appears only when its catalog
              entry declares image or video output and its upstream accepts the generation call.
            </p>
            <Textarea
              label="Prompt"
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={
                kind === "image"
                  ? "A weathered brass compass on a dark oak table, shallow depth of field…"
                  : "Slow dolly through a rainy neon alley, reflections on wet asphalt…"
              }
            />
            {kind === "image" ? (
              <Inline gap="12px" align="flex-end" wrap>
                <Select
                  label="Images"
                  value={count}
                  onValueChange={setCount}
                  options={[1, 2, 3, 4].map((value) => ({
                    value: String(value),
                    label: String(value),
                  }))}
                  style={{ width: "110px" }}
                />
                <Input
                  label="Size (optional)"
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                  placeholder="1024x1024"
                  style={{ width: "180px" }}
                />
              </Inline>
            ) : (
              <Inline gap="12px" align="flex-end" wrap>
                <Input
                  label="Duration (seconds)"
                  value={duration}
                  onChange={(event) => setDuration(event.target.value)}
                  inputMode="numeric"
                  style={{ width: "150px" }}
                />
                <Input
                  label="Size (optional)"
                  value={size}
                  onChange={(event) => setSize(event.target.value)}
                  placeholder="1280x720"
                  style={{ width: "180px" }}
                />
              </Inline>
            )}
            <Inline gap="10px" align="center" wrap>
              <Button
                variant="primary"
                icon={kind === "image" ? <ImageIcon size={14} /> : <Video size={14} />}
                loading={submitting}
                disabled={working || activeModel === undefined || prompt.trim().length === 0}
                onClick={submit}
              >
                Generate {KIND_LABEL[kind].toLowerCase()}
              </Button>
              <span style={{ fontSize: "11.5px", color: "var(--text-tertiary)" }}>
                {activeProvider && activeModel
                  ? `${activeProvider.id}/${activeModel.modelId}`
                  : "No model selected"}
              </span>
            </Inline>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Result"
          subtitle={
            activeTask ? `Task ${activeTask.id}` : "Nothing generated in this session yet."
          }
          action={activeTask ? <TaskState task={activeTask} /> : undefined}
        />
        <CardBody>
          {activeTask === undefined ? (
            <p style={{ fontSize: "12px", color: "var(--text-tertiary)" }}>
              Submit a prompt to start. Image and video jobs run upstream; this page polls the
              provider until the result is ready.
            </p>
          ) : kind === "image" ? (
            <Stack gap="10px">
              {currentImage ? <ImageResults task={currentImage} /> : null}
              {currentImage?.error ? (
                <Inline gap="6px" align="center" style={{ color: "var(--text-tertiary)" }}>
                  <TriangleAlert size={13} aria-hidden="true" />
                  <span style={{ fontSize: "11.5px" }}>{currentImage.error}</span>
                </Inline>
              ) : null}
            </Stack>
          ) : currentVideo ? (
            <VideoResult task={currentVideo} />
          ) : null}
        </CardBody>
      </Card>
    </Stack>
  );
}

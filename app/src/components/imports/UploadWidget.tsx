import { useRef, useState, type ReactElement } from "react";
import { CheckCircle2, Loader2, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";

type DuplicateExisting = {
  fileName: string;
  status: string;
  uploadedAt: string;
  bankSlug: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

function formatDuplicateMessage(fileName: string, existing: DuplicateExisting): string {
  const lines: string[] = [
    `Já existe uma importação deste arquivo (${existing.fileName}).`,
    `Status atual: ${existing.status}.`,
    `Enviada em ${formatDate(existing.uploadedAt)}.`,
  ];
  if (existing.bankSlug !== null) lines.push(`Banco: ${existing.bankSlug}.`);
  if (existing.periodStart !== null && existing.periodEnd !== null) {
    lines.push(`Período: ${formatDate(existing.periodStart)} — ${formatDate(existing.periodEnd)}.`);
  }
  lines.push("");
  lines.push(`Enviar "${fileName}" mesmo assim? A importação anterior será descartada.`);
  return lines.join("\n");
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type UploadState = {
  fileName: string;
  status: "uploading" | "done" | "error";
  error?: string;
};

export function UploadWidget({
  accept = ".ofx,.csv",
  title = "Arraste um extrato .ofx ou vendas de cartão .csv",
  disabled = false,
  onUploaded,
}: {
  accept?: string;
  title?: string;
  disabled?: boolean;
  // Fired once per batch when at least one file was accepted — parsing
  // continues async, so callers can navigate away immediately.
  onUploaded?: (() => void) | undefined;
}): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const utils = trpc.useUtils();

  const uploadMutation = trpc.statementImports.upload.useMutation({
    onSuccess: () => {
      void utils.statementImports.list.invalidate();
    },
  });

  async function uploadOne(file: File, confirmDuplicate: boolean): Promise<void> {
    const fileContent = await fileToBase64(file);
    const result = await uploadMutation.mutateAsync({
      fileName: file.name,
      fileContent,
      confirmDuplicate,
    });

    if (result.status === "duplicate_warning") {
      const confirmed = window.confirm(formatDuplicateMessage(file.name, result.existing));
      if (!confirmed) {
        throw new Error("Importação cancelada pelo usuário.");
      }
      await uploadOne(file, true);
    }
  }

  // The picker enforces `accept`, but drag-and-drop bypasses it — validate
  // the extension ourselves so a wrong-side drop fails immediately.
  function extensionAllowed(fileName: string): boolean {
    const allowed = accept.split(",").map((ext) => ext.trim().toLowerCase());
    return allowed.some((ext) => fileName.toLowerCase().endsWith(ext));
  }

  async function handleFiles(files: FileList): Promise<void> {
    const fileArray = Array.from(files);
    let accepted = 0;

    for (const file of fileArray) {
      const idx = uploads.length + fileArray.indexOf(file);
      setUploads((prev) => [...prev, { fileName: file.name, status: "uploading" }]);

      try {
        if (!extensionAllowed(file.name)) {
          throw new Error(`Tipo de arquivo não aceito aqui (esperado: ${accept}).`);
        }
        await uploadOne(file, false);
        accepted += 1;
        setUploads((prev) =>
          prev.map((u, i) => (i === idx ? { ...u, status: "done" as const } : u)),
        );
      } catch (err) {
        setUploads((prev) =>
          prev.map((u, i) =>
            i === idx
              ? {
                  ...u,
                  status: "error" as const,
                  error: err instanceof Error ? err.message : "Erro desconhecido",
                }
              : u,
          ),
        );
      }
    }

    if (inputRef.current !== null) inputRef.current.value = "";
    if (accepted > 0) onUploaded?.();
  }

  return (
    <div
      className={cn(
        "relative flex flex-col items-center justify-center gap-3 py-10 px-6",
        "border border-dashed transition-colors duration-200",
        "rounded-[var(--radius-md)]",
        disabled && "opacity-50 pointer-events-none",
        isDragging
          ? "border-[color:var(--accent)] bg-[color:var(--accent-wash)]"
          : "border-[color:var(--rule-strong)] bg-[color:var(--paper-sink)]/40 hover:bg-[color:var(--paper-sink)]",
      )}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (!disabled && e.dataTransfer.files.length > 0) {
          void handleFiles(e.dataTransfer.files);
        }
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files !== null && e.target.files.length > 0) {
            void handleFiles(e.target.files);
          }
        }}
      />

      <div className="flex flex-col items-center gap-1 text-center">
        <Upload
          className={cn(
            "h-5 w-5 mb-2 transition-colors",
            isDragging ? "text-[color:var(--accent)]" : "text-[color:var(--ink-mute)]",
          )}
          aria-hidden="true"
        />
        <p className="font-serif text-[length:var(--fs-section)] font-[450] tracking-[-0.01em] text-[color:var(--ink)]">
          {title}
        </p>
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] italic">
          ou clique abaixo para selecionar do computador
        </p>
      </div>

      <Button
        variant="outline"
        size="sm"
        onClick={() => inputRef.current?.click()}
        disabled={disabled || uploadMutation.isPending}
      >
        {uploadMutation.isPending ? "Enviando…" : "Selecionar arquivos"}
      </Button>

      {uploads.length > 0 && (
        <ul className="mt-4 w-full max-w-md flex flex-col divide-y divide-[color:var(--rule)] text-[length:var(--fs-body-sm)]">
          {uploads.map((u, i) => (
            <li key={i} className="flex items-center gap-2.5 py-2">
              {u.status === "uploading" && (
                <Loader2 className="h-3.5 w-3.5 text-[color:var(--ink-mute)] animate-spin shrink-0" />
              )}
              {u.status === "done" && (
                <CheckCircle2 className="h-3.5 w-3.5 text-[color:var(--positive)] shrink-0" />
              )}
              {u.status === "error" && (
                <XCircle className="h-3.5 w-3.5 text-[color:var(--negative)] shrink-0" />
              )}
              <span className="truncate flex-1 text-[color:var(--ink)]">{u.fileName}</span>
              {u.status === "uploading" && (
                <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--ink-mute)]">
                  Enviando
                </span>
              )}
              {u.status === "done" && (
                <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--positive)]">
                  Enviado
                </span>
              )}
              {u.status === "error" && (
                <span
                  className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--negative)]"
                  title={u.error}
                >
                  Falhou
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

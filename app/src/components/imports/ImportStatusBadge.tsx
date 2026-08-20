import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { useLov } from "@/hooks/use-lov";

type Variant = NonNullable<BadgeProps["variant"]>;

const STATUS_VARIANTS: Record<string, Variant> = {
  uploaded_pending: "warning",
  parsing: "warning",
  parsed: "default",
  parse_failed: "destructive",
  approved: "success",
  rejected: "destructive",
  purged: "secondary",
  upload_timeout: "destructive",
};

const IN_PROGRESS_STATUSES = new Set(["uploaded_pending", "parsing"]);

export function ImportStatusBadge({ status }: { status: string }): ReactElement {
  const lov = useLov("STATEMENT_IMPORT_FILE_STATUS");
  const variant = STATUS_VARIANTS[status] ?? "outline";
  const isInProgress = IN_PROGRESS_STATUSES.has(status);

  return (
    <Badge variant={variant}>
      {isInProgress && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {lov.label(status, status)}
    </Badge>
  );
}

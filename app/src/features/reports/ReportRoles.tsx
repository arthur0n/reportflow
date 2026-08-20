// app/src/features/reports/ReportRoles.tsx
//
// The attach step (§3.2). One block per DECLARED role, each offering only the
// extractions whose document is of that role's type — the dropdown cannot
// contain a wrong answer, which is the point of declaring the inputs.
//
// A required role with nothing bound is rendered as "aguardando", not as an
// error: it is a normal state of a report that is still being assembled, and
// the design doc named it as the thing declared inputs exist to make showable.

import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

type ReportDetail = TrpcOutput["reports"]["get"];
type Role = ReportDetail["roles"][number];

function RoleBlock({
  reportId,
  role,
  frozen,
  onChanged,
}: {
  reportId: string;
  role: Role;
  frozen: boolean;
  onChanged: () => void;
}): ReactElement {
  const [picked, setPicked] = useState("");
  const options = trpc.reports.roleOptions.useQuery(
    { reportId, roleKey: role.key },
    { enabled: !frozen },
  );

  const attach = trpc.reports.attach.useMutation({
    onSuccess: () => {
      setPicked("");
      onChanged();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });
  const detach = trpc.reports.detach.useMutation({
    onSuccess: onChanged,
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const waiting = role.required && role.attached.length === 0;

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--rule)] py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[length:var(--fs-body-sm)]">{role.key}</span>
        <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
          {role.provider} / {role.documentType}
        </span>
        <Badge variant="outline">{role.cardinality === "many" ? "vários" : "um"}</Badge>
        {waiting ? (
          <Badge variant="secondary">aguardando</Badge>
        ) : (
          role.required && <Badge variant="outline">obrigatório</Badge>
        )}
      </div>

      {role.attached.length > 0 && (
        <ul className="flex flex-col gap-1">
          {role.attached.map((doc) => (
            <li
              key={doc.extractionId}
              className="flex items-center justify-between gap-3 text-[length:var(--fs-body-sm)]"
            >
              <span>{doc.fileName ?? doc.extractionId}</span>
              {!frozen && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={detach.isPending}
                  onClick={() => {
                    detach.mutate({
                      reportId,
                      roleKey: role.key,
                      extractionId: doc.extractionId,
                    });
                  }}
                >
                  Remover
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!frozen && (
        <div className="flex flex-wrap items-center gap-2">
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger className="min-w-[18rem]">
              <SelectValue placeholder="Escolha um documento extraído" />
            </SelectTrigger>
            <SelectContent>
              {(options.data ?? []).map((option) => (
                <SelectItem key={option.extractionId} value={option.extractionId}>
                  {option.fileName ?? option.extractionId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={picked.length === 0 || attach.isPending}
            onClick={() => {
              attach.mutate({ reportId, roleKey: role.key, extractionId: picked });
            }}
          >
            Anexar
          </Button>
          {options.data?.length === 0 && (
            <span className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
              Nenhum documento extraído desse tipo.
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ReportRoles({
  reportId,
  roles,
  frozen,
  onChanged,
}: {
  reportId: string;
  roles: readonly Role[];
  frozen: boolean;
  onChanged: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col">
      {roles.map((role) => (
        <RoleBlock
          key={role.key}
          reportId={reportId}
          role={role}
          frozen={frozen}
          onChanged={onChanged}
        />
      ))}
    </div>
  );
}

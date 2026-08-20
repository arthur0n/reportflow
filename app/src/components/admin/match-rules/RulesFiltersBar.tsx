import type { ReactElement } from "react";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type StatusFilter, TENANT_TARGET_KINDS, SYSTEM_TARGET_KINDS } from "./match-rule-shared";

type Props<K extends string> = {
  status: StatusFilter;
  onStatusChange: (s: StatusFilter) => void;
  kind: K | "ALL";
  onKindChange: (k: K | "ALL") => void;
  scope: "tenant" | "system";
  count: number;
  isLoading: boolean;
};

export function RulesFiltersBar<K extends string>({
  status,
  onStatusChange,
  kind,
  onKindChange,
  scope,
  count,
  isLoading,
}: Props<K>): ReactElement {
  const targetKinds = scope === "tenant" ? TENANT_TARGET_KINDS : SYSTEM_TARGET_KINDS;
  return (
    <div className="mt-6 flex flex-wrap items-end gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="status">Status</Label>
        <Select
          value={status}
          onValueChange={(v) => {
            onStatusChange(v as StatusFilter);
          }}
        >
          <SelectTrigger id="status" className="w-[180px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Ativas</SelectItem>
            <SelectItem value="inactive">Desativadas</SelectItem>
            <SelectItem value="all">Todas</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="kind">Destino</Label>
        <Select
          value={kind}
          onValueChange={(v) => {
            onKindChange(v as K | "ALL");
          }}
        >
          <SelectTrigger id="kind" className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Todos</SelectItem>
            {targetKinds.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="ml-auto pb-2 text-sm text-muted-foreground">
        {isLoading ? "Carregando…" : `${count} regra(s)`}
      </div>
    </div>
  );
}

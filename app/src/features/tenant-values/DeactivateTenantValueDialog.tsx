import type { ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import {
  TENANT_VALUE_KIND_CONFIG,
  type TenantValueKind,
} from "@shared/constants/tenant-value-kinds";

export type DeactivableTenantValue = {
  id: string;
  name: string;
};

export function DeactivateTenantValueDialog({
  kind,
  tenantValue,
  open,
  onOpenChange,
}: {
  kind: TenantValueKind;
  tenantValue: DeactivableTenantValue | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const cfg = TENANT_VALUE_KIND_CONFIG[kind];
  const labelLower = cfg.labelOne.toLowerCase();

  const deactivate = trpc.tenantValues.deactivate.useMutation({
    onSuccess: () => {
      void utils.tenantValues.invalidate();
      toast.success(`${cfg.labelOne} inativado.`);
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Inativar {labelLower} “{tenantValue?.name ?? ""}”?
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            {cfg.labelOne}s inativos não aparecem em dropdowns para novos registros.
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={deactivate.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (tenantValue) deactivate.mutate(tenantValue.id);
            }}
            disabled={deactivate.isPending || tenantValue === null}
          >
            {deactivate.isPending ? "Inativando…" : "Inativar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

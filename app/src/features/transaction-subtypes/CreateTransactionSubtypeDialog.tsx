import { type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { LovQuickCreateDialog } from "@/features/lov/LovQuickCreateDialog";

export function CreateTransactionSubtypeDialog({
  open,
  onOpenChange,
  initialName,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  onCreated?: (id: string) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const create = trpc.transactionSubtypes.create.useMutation();

  return (
    <LovQuickCreateDialog
      open={open}
      onOpenChange={onOpenChange}
      {...(initialName !== undefined ? { initialName } : {})}
      title="Novo subtipo"
      successMessage="Subtipo criado."
      mutateAsync={(input) => create.mutateAsync(input)}
      isPending={create.isPending}
      {...(onCreated !== undefined ? { onCreated } : {})}
      onInvalidate={() => {
        void utils.listOfValues.invalidate();
      }}
    />
  );
}

import { type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { LovQuickCreateDialog } from "@/features/lov/LovQuickCreateDialog";

export function CreatePaymentMethodDialog({
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
  const create = trpc.paymentMethods.create.useMutation();

  return (
    <LovQuickCreateDialog
      open={open}
      onOpenChange={onOpenChange}
      {...(initialName !== undefined ? { initialName } : {})}
      title="Nova forma de pagamento"
      successMessage="Forma de pagamento criada."
      mutateAsync={(input) => create.mutateAsync(input)}
      isPending={create.isPending}
      {...(onCreated !== undefined ? { onCreated } : {})}
      onInvalidate={() => {
        void utils.paymentMethods.invalidate();
        void utils.listOfValues.invalidate();
      }}
      suggestionsCopy={{
        pickedAlreadyTenant: "Esta forma de pagamento já está cadastrada.",
        pickedAlreadySystem: "Esta forma de pagamento já está disponível no sistema.",
      }}
    />
  );
}

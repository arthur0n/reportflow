// app/src/lib/utils.ts
// Standard shadcn/ui className helper. If/when `npx shadcn@latest init` is
// run, it will (re)generate this file with the same content.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

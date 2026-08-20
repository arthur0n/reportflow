export type PeriodGranularity = "day" | "week" | "month" | "year" | "all";

export type PeriodFilter = {
  granularity: PeriodGranularity;
  anchor: Date;
};

export const DEFAULT_PERIOD_FILTER: PeriodFilter = {
  granularity: "month",
  anchor: new Date(),
};

export function formatMonthLabel(date: Date): string {
  const months = [
    "Janeiro",
    "Fevereiro",
    "Março",
    "Abril",
    "Maio",
    "Junho",
    "Julho",
    "Agosto",
    "Setembro",
    "Outubro",
    "Novembro",
    "Dezembro",
  ];
  return `${months[date.getMonth()]} de ${date.getFullYear()}`;
}

export function getDateRange(
  granularity: PeriodGranularity,
  anchor: Date,
): { start: string; end: string } {
  const year = anchor.getFullYear();
  const month = String(anchor.getMonth() + 1).padStart(2, "0");
  const date = String(anchor.getDate()).padStart(2, "0");
  const isoDate = `${year}-${month}-${date}`;

  switch (granularity) {
    case "day":
      return { start: isoDate, end: isoDate };
    case "week": {
      const dayOfWeek = anchor.getDay();
      const diff = anchor.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
      const startDate = new Date(anchor.setDate(diff));
      const endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      const startStr = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
      const endStr = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, "0")}-${String(endDate.getDate()).padStart(2, "0")}`;
      return { start: startStr, end: endStr };
    }
    case "month":
      return {
        start: `${year}-${month}-01`,
        end: `${year}-${month}-${new Date(year, parseInt(month), 0).getDate()}`,
      };
    case "year":
      return { start: `${year}-01-01`, end: `${year}-12-31` };
    case "all":
      return { start: "", end: "" };
  }
}

export function formatMoney(value: number | undefined, currency?: string): string {
  if (value === undefined || !Number.isFinite(value)) return "未知";
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return `${value.toFixed(2)}（币种未知）`;
  return new Intl.NumberFormat("zh-CN", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

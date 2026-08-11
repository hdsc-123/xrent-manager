/** pricePerDay/totalPrice sont stockés en entiers (plus petite unité monétaire, ex. centimes). */
export function formatMoney(amountInSmallestUnit: number, currency: string): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(
    amountInSmallestUnit / 100
  );
}

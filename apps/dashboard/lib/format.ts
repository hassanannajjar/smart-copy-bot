/** -17.956 → "-$17.96". Import-free so client components can use it too. */
export function usd(n: number): string {
  const abs = Math.abs(n).toFixed(2);
  return `${n < 0 && abs !== '0.00' ? '-' : ''}$${abs}`;
}

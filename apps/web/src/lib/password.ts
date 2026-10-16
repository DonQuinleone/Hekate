/** How strong a new password reads, for the meter under the field: 0 to 4. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (password.length < 12) return { score: 0, label: "too short" };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^\w\s]/, /\s/].filter((r) => r.test(password)).length;
  const repeated = /(.)\1{3,}/.test(password);
  let score = 1;
  if (password.length >= 16) score++;
  if (password.length >= 20 || kinds >= 3) score++;
  if (password.length >= 24 && kinds >= 2) score++;
  if (repeated) score = Math.max(1, score - 1);
  const s = Math.min(4, score) as 1 | 2 | 3 | 4;
  return { score: s, label: ["", "weak", "fair", "good", "strong"][s] ?? "" };
}

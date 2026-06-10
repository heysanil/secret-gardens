/** Tiny strength heuristic for the first-admin signup hint. Not a gate —
 * better-auth enforces its own minimum length server-side. */

export interface PasswordStrength {
  /** 0 = too short, 1 = weak, 2 = fair, 3 = strong */
  score: 0 | 1 | 2 | 3;
  label: string;
}

export function passwordStrength(password: string): PasswordStrength {
  if (password.length < 8) {
    return { score: 0, label: "At least 8 characters" };
  }
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  if (/[^A-Za-z0-9]/.test(password)) classes += 1;

  if (password.length >= 16 && classes >= 3) {
    return { score: 3, label: "Strong" };
  }
  if (password.length >= 12 && classes >= 2) {
    return { score: 2, label: "Fair" };
  }
  return { score: 1, label: "Weak — longer is stronger" };
}

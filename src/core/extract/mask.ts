export const MEMBER_ID_MASK = /^\d{8}$/;

export function matchesMask(value: string, mask: RegExp): boolean {
  return mask.test(value);
}

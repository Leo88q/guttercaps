export const FEATURES: string[];
export const CONTROLS: string[];
export interface LegalContext { today: string; revision: string | undefined; counselReviewed: boolean; documentsSha256: string }
export function assessLegalRelease(input: unknown, context: LegalContext): string[];
export function legalContext(root?: string, today?: string): LegalContext;
export function checkLegalRelease(root?: string): string[];

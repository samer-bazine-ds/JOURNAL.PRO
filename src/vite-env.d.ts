/// <reference types="vite/client" />
declare module '../pdf-parser.js' {
  export function parsePdf(buffer: ArrayBuffer, progress?: (percent: number, message: string) => void): Promise<import('./types').Invoice[]>;
}
interface Window {
  journalPro?: {
    platform: string;
    versions: Record<string, string | undefined>;
    getControlStatus: () => Promise<{ status: 'active' | 'disabled'; message?: string }>;
  };
}

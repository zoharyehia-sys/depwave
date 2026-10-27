export declare const MARKER: string;
export declare const MAX_BODY: number;
export declare function findStickyComment(comments: ReadonlyArray<{ id: number; body?: string | null; user?: { type?: string } | null }>, marker?: string): { id: number } | undefined;
export declare function fitBody(body: string, max?: number): string;

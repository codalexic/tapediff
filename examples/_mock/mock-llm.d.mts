export function startMock(): Promise<{ url: string; close(): Promise<void> }>;

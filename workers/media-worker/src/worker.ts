// SPEC-003 media-worker. Red stub.
export class AdapterError extends Error { constructor(readonly code: string) { super(code); } }
export interface MediaAdapter { supportsIdempotency: boolean; submit(job: any): Promise<any> }
export interface WorkerEnv { [key: string]: any }
export async function handleFetch(_request: Request, _env: WorkerEnv): Promise<Response> { return new Response('', { status: 501 }); }
export async function handleQueue(_batch: any, _env: WorkerEnv, _deps?: any): Promise<void> {}

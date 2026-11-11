// SPEC-003 R2 presigner. Red stub.
export async function presignS3Get(_options: unknown): Promise<string> { return ''; }
export function r2SignerFromEnv(_env: NodeJS.ProcessEnv, _now: () => Date):
  { ok: true; signer: { signGetUrl: (key: string) => Promise<{ url: string; expires_at: string }> } } | { ok: false; problem: string } {
  return { ok: false, problem: 'not implemented' };
}

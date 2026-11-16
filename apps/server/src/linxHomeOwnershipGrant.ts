// Evaluated as the first main-entry dependency, before provider/runtime modules.
// Never retain the capability in process.env, provider context or child snapshots.
let nonce: string | undefined;
for (const key of Object.keys(process.env)) {
  if ((process.platform === "win32" ? key.toUpperCase() : key) === "LINX_HOME_OWNERSHIP_NONCE") {
    nonce ??= process.env[key];
    delete process.env[key];
  }
}
export function takeLinxHomeOwnershipGrant(): string | undefined {
  const grant = nonce;
  nonce = undefined;
  return grant;
}

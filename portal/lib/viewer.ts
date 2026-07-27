import type { Identity } from "@/lib/identity";
import { tableStore } from "@/lib/tables";

/** The per-viewer slice of portal state: their own settings and role. */
export async function viewerOf(identity: Identity) {
  const me = await tableStore.identity(identity.username);
  return {
    isAdmin: identity.isAdmin,
    defaultModule: me.defaultModule ?? "",
    spectateByDefault: me.spectateByDefault ?? false,
  };
}

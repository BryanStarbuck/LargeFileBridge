// peers.yaml accessor (storage.mdx §11).
import { PeersSchema, type Peers, type PeerRow } from "@lfb/shared";
import { readYaml, updateYaml } from "../../shared/store/yaml-store.js";
import { peersPath } from "../../shared/store/scopes.js";

export function getPeers(): Peers {
  return readYaml(peersPath(), PeersSchema);
}

/**
 * Forget a peer (menus.mdx §5.4 "Remove peer"). Drops the entry from peers.yaml only — it does not
 * touch any remote content or local file. Returns true if a peer was removed. Idempotent.
 */
export async function removePeer(id: string): Promise<boolean> {
  let removed = false;
  await updateYaml(peersPath(), PeersSchema, (p) => {
    const before = p.peers.length;
    p.peers = p.peers.filter((peer) => peer.id !== id);
    removed = p.peers.length < before;
    return p;
  });
  return removed;
}

export function peerRows(): PeerRow[] {
  return getPeers().peers.map((p) => ({
    id: p.id,
    label: p.label,
    ipfsPeerId: p.ipfs_peer_id,
    owner: p.owner,
    lastSeen: p.last_seen,
  }));
}
